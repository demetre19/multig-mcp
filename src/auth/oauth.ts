import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { Auth, google } from "googleapis";
import { deferred } from "../storage/deferred.js";
import { COMPOSE_SCOPE, GMAIL_SCOPES, READONLY_SCOPE, SEND_SCOPE } from "../storage/config.js";
export const CALLBACK_PATH = "/oauth2callback";
export { COMPOSE_SCOPE, GMAIL_SCOPES, READONLY_SCOPE, SEND_SCOPE };
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

type OAuthClient = Auth.OAuth2Client;

export type OAuthClientCredentials = {
  clientId: string;
  clientSecret: string;
};

export type OAuthTokens = {
  scope?: string;
  refresh_token?: string;
  access_token?: string;
  expiry_date?: number;
};

export type OAuthFlowResult = {
  email: string;
  scopes: typeof GMAIL_SCOPES;
  refreshToken?: string;
};

export class OAuthFlowError extends Error {
  readonly code:
    | "oauth_client_invalid"
    | "oauth_callback_invalid"
    | "oauth_authorization_denied"
    | "oauth_exchange_failed"
    | "missing_scope"
    | "gmail_profile_failed"
    | "oauth_timeout";

  constructor(
    code: OAuthFlowError["code"],
    message = code,
  ) {
    super(message);
    this.name = "OAuthFlowError";
    this.code = code;
  }
}

export class OneUseState {
  readonly value: string;
  #consumed = false;

  constructor(value = randomBytes(32).toString("base64url")) {
    if (value.length === 0) throw new OAuthFlowError("oauth_client_invalid");
    this.value = value;
  }

  validate(candidate: string): boolean {
    const left = Buffer.from(this.value, "utf8");
    const right = Buffer.from(candidate, "utf8");
    const matches = left.length === right.length && timingSafeEqual(left, right);
    if (!matches || this.#consumed) return false;
    this.#consumed = true;
    return true;
  }
}

export function buildRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

export function generatePkce(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest().toString("base64url");
}

type CallbackResult =
  | { accepted: true; code: string }
  | { accepted: true; error: string }
  | { accepted: false; reason: string };

function exactParameter(target: URL, name: string): string | undefined {
  const values = target.searchParams.getAll(name);
  if (values.length !== 1 || values[0] === undefined || values[0].length === 0) return undefined;
  return values[0];
}

export function validateCallbackRequest(
  method: string | undefined,
  requestTarget: string,
  expectedRedirectUri: string,
  state: OneUseState,
): CallbackResult {
  if (method !== "GET") return { accepted: false, reason: "method" };
  let expected: URL;
  let target: URL;
  try {
    expected = new URL(expectedRedirectUri);
    target = new URL(requestTarget, expected.origin);
  } catch {
    return { accepted: false, reason: "url" };
  }
  if (expected.protocol !== "http:" || expected.hostname !== "127.0.0.1" || expected.pathname !== CALLBACK_PATH) {
    return { accepted: false, reason: "expected-origin" };
  }
  if (target.origin !== expected.origin || target.pathname !== CALLBACK_PATH) {
    return { accepted: false, reason: "path-or-origin" };
  }
  const stateValue = exactParameter(target, "state");
  const code = exactParameter(target, "code");
  const error = exactParameter(target, "error");
  if (stateValue === undefined || !state.validate(stateValue)) return { accepted: false, reason: "state" };
  if ((code === undefined) === (error === undefined)) return { accepted: false, reason: "code-or-error" };
  return code === undefined ? { accepted: true, error: error as string } : { accepted: true, code };
}

function listen(server: Server): Promise<number> {
  const result = deferred<number>();
  server.once("error", result.reject);
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      result.reject(new OAuthFlowError("oauth_callback_invalid"));
      return;
    }
    result.resolve(address.port);
  });
  return result.promise;
}

type CallbackListener = {
  port: number;
  result: Promise<{ code: string }>;
  close: () => Promise<void>;
};

async function startCallbackListener(state: OneUseState, timeoutMs: number): Promise<CallbackListener> {
  const server = createServer();
  let port = 0;
  let timer: NodeJS.Timeout | undefined;
  let closePromise: Promise<void> | undefined;
  let settled = false;
  const resultResolvers = deferred<{ code: string }>();
  void resultResolvers.promise.catch(() => undefined);

  const closeServer = (): Promise<void> => {
    if (!server.listening) return Promise.resolve();
    if (closePromise === undefined) {
      const closeResolvers = deferred<void>();
      closePromise = closeResolvers.promise;
      server.close(() => closeResolvers.resolve());
    }
    return closePromise;
  };

  const finish = (result: { code: string } | undefined, error: OAuthFlowError | undefined): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    void closeServer().then(() => {
      if (error !== undefined) resultResolvers.reject(error);
      else if (result !== undefined) resultResolvers.resolve(result);
      else resultResolvers.reject(new OAuthFlowError("oauth_callback_invalid"));
    });
  };

  server.on("error", () => finish(undefined, new OAuthFlowError("oauth_callback_invalid")));
  server.on("request", (request, response) => {
    const callback = validateCallbackRequest(request.method, request.url ?? "", buildRedirectUri(port), state);
    response.statusCode = callback.accepted ? 200 : 400;
    response.setHeader("connection", "close");
    response.end(callback.accepted ? "Authorization received. You may return to the terminal." : "Invalid authorization callback.");
    if (!callback.accepted) {
      finish(undefined, new OAuthFlowError("oauth_callback_invalid"));
    } else if ("code" in callback) {
      finish({ code: callback.code }, undefined);
    } else {
      finish(undefined, new OAuthFlowError("oauth_authorization_denied"));
    }
  });

  try {
    port = await listen(server);
  } catch {
    await closeServer();
    throw new OAuthFlowError("oauth_callback_invalid");
  }
  timer = setTimeout(() => finish(undefined, new OAuthFlowError("oauth_timeout")), timeoutMs);
  return {
    port,
    result: resultResolvers.promise,
    close: async () => {
      finish(undefined, new OAuthFlowError("oauth_callback_invalid"));
      await closeServer();
    },
  };
}

export type OAuthFlowOptions = OAuthClientCredentials & {
  timeoutMs?: number;
  openBrowser?: (url: string) => Promise<void>;
  createClient?: (credentials: OAuthClientCredentials, redirectUri: string) => OAuthClient;
  exchangeCode?: (client: OAuthClient, code: string, codeVerifier: string, redirectUri: string) => Promise<OAuthTokens>;
  fetchProfile?: (client: OAuthClient) => Promise<string>;
};

function openSystemBrowser(url: string): Promise<void> {
  const result = deferred<void>();
  const browser = spawn("/usr/bin/open", [url], {
    detached: true,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    shell: false,
    stdio: "ignore",
  });
  browser.once("error", () => result.reject(new OAuthFlowError("oauth_callback_invalid")));
  browser.once("spawn", () => {
    browser.unref();
    result.resolve();
  });
  return result.promise;
}

export function assertGrantedScopes(scope: string | undefined): asserts scope is string {
  const granted = new Set(scope?.trim().split(/\s+/u).filter((value) => value.length > 0));
  if (GMAIL_SCOPES.some((required) => !granted.has(required))) {
    throw new OAuthFlowError("missing_scope");
  }
}

export { openSystemBrowser };

async function exchangeCode(
  client: OAuthClient,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const response = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
  return response.tokens as OAuthTokens;
}

async function fetchProfile(client: OAuthClient): Promise<string> {
  const response = await google.gmail({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
  const email = response.data.emailAddress;
  if (typeof email !== "string" || email.trim().length === 0) throw new OAuthFlowError("gmail_profile_failed");
  return email;
}

export async function runOAuthFlow(options: OAuthFlowOptions): Promise<OAuthFlowResult> {
  if (options.clientId.trim().length === 0 || options.clientSecret.length === 0) {
    throw new OAuthFlowError("oauth_client_invalid");
  }
  const state = new OneUseState();
  const listener = await startCallbackListener(state, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const redirectUri = buildRedirectUri(listener.port);
  try {
    const createClient = options.createClient ?? ((credentials, callbackUri) => new google.auth.OAuth2(credentials.clientId, credentials.clientSecret, callbackUri));
    const client = createClient({ clientId: options.clientId, clientSecret: options.clientSecret }, redirectUri);
    const openBrowser = options.openBrowser ?? openSystemBrowser;
    const exchange = options.exchangeCode ?? exchangeCode;
    const profile = options.fetchProfile ?? fetchProfile;
    const verifier = await client.generateCodeVerifierAsync();
    if (verifier.codeChallenge === undefined || verifier.codeChallenge.length === 0) {
      throw new OAuthFlowError("oauth_client_invalid");
    }
    const authorizationUrl = client.generateAuthUrl({
      access_type: "offline",
      client_id: options.clientId,
      code_challenge: verifier.codeChallenge,
      code_challenge_method: Auth.CodeChallengeMethod.S256,
      prompt: "consent",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: [...GMAIL_SCOPES],
      state: state.value,
    });
    try {
      await openBrowser(authorizationUrl);
    } catch (error) {
      if (error instanceof OAuthFlowError) throw error;
      throw new OAuthFlowError("oauth_callback_invalid");
    }
    const callback = await listener.result;
    let tokens: OAuthTokens;
    try {
      tokens = await exchange(client, callback.code, verifier.codeVerifier, redirectUri);
    } catch {
      throw new OAuthFlowError("oauth_exchange_failed");
    }
    assertGrantedScopes(tokens.scope);
    client.setCredentials(tokens);
    let email: string;
    try {
      email = await profile(client);
    } catch (error) {
      if (error instanceof OAuthFlowError) throw error;
      throw new OAuthFlowError("gmail_profile_failed");
    }
    const refreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token.trim().length > 0
      ? tokens.refresh_token
      : undefined;
    return { email, scopes: GMAIL_SCOPES, ...(refreshToken === undefined ? {} : { refreshToken }) };
  } finally {
    await listener.close();
  }
}
