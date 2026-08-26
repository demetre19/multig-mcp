import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { google } from "googleapis";
import { z } from "zod";

export const READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const CALLBACK_PATH = "/oauth2callback";
const SYNTHETIC_CLIENT_ID = "synthetic-desktop-client.apps.googleusercontent.test";
const REAL_CREDENTIAL_PATH = join(
  homedir(),
  "Documents",
  "UNCLUTTER-NEW",
  "CLAUDE-DEV",
  "Multi G",
  "SECRET",
  "client_secret_459145523371-ou3uc7c998qsnvgtccol771qm6grmklp.apps.googleusercontent.com.json",
);
const REAL_EVIDENCE_PATH = join(tmpdir(), "multig-mcp-oauth-real-proof.json");
const REAL_AUTH_TIMEOUT_MS = 5 * 60_000;

type CallbackResult =
  | { accepted: true; code: string }
  | { accepted: true; error: string }
  | { accepted: false; reason: string };

type TokenFixture = {
  scope?: string;
  refresh_token?: string;
};

type ProfileFixture = { emailAddress?: string };

type StoredAccount = {
  email: string;
  scopes: string[];
  refreshToken: string;
};

type DesktopCredential = {
  clientId: string;
  clientSecret: string;
};

type RealAuthorizationResult = {
  passed: true;
  evidence_path: string;
  revocation: "revoked" | "skipped";
};

type RealCallbackListener = {
  port: number;
  result: Promise<string>;
  close: () => Promise<void>;
};
const DesktopCredentialFile = z.object({
  installed: z.object({
    client_id: z.string().trim().min(1),
    client_secret: z.string().trim().min(1),
    auth_uri: z.literal("https://accounts.google.com/o/oauth2/auth"),
    token_uri: z.literal("https://oauth2.googleapis.com/token"),
    redirect_uris: z.array(z.string().min(1)).min(1),
  }),
});

async function readDesktopCredential(): Promise<DesktopCredential> {
  try {
    const parsed = DesktopCredentialFile.parse(JSON.parse(await readFile(REAL_CREDENTIAL_PATH, "utf8")) as unknown);
    return { clientId: parsed.installed.client_id, clientSecret: parsed.installed.client_secret };
  } catch {
    throw new Error("desktop credential could not be read or has an invalid desktop shape");
  }
}

function openSystemBrowser(url: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const browser = spawn("/usr/bin/open", [url], {
    detached: true,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdio: "ignore",
  });
  browser.once("error", () => reject(new Error("system browser could not be opened")));
  browser.once("spawn", () => {
    browser.unref();
    resolve();
  });
  return promise;
}

async function startRealCallbackListener(state: OneUseState): Promise<RealCallbackListener> {
  const server = createServer();
  let timer: NodeJS.Timeout | undefined;
  let closePromise: Promise<void> | undefined;
  let settled = false;
  const resultResolvers = Promise.withResolvers<string>();
  const closeServer = (): Promise<void> => {
    if (!server.listening) return Promise.resolve();
    if (closePromise === undefined) {
      const closeResolvers = Promise.withResolvers<void>();
      closePromise = closeResolvers.promise;
      server.close(() => closeResolvers.resolve());
    }
    return closePromise;
  };
  const finish = (code: string | undefined, error: Error | undefined): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    void closeServer().then(() => {
      if (error) resultResolvers.reject(error);
      else if (code === undefined) resultResolvers.reject(new Error("callback code missing"));
      else resultResolvers.resolve(code);
    });
  };
  server.on("error", () => finish(undefined, new Error("callback listener failed")));
  let addressPort = 0;
  server.on("request", (incoming, response) => {
    const redirectUri = `http://127.0.0.1:${addressPort}${CALLBACK_PATH}`;
    const callback = validateCallbackRequest(incoming.method, incoming.url ?? "", redirectUri, state);
    response.statusCode = callback.accepted ? 200 : 400;
    response.end(callback.accepted ? "Authorization received. You may return to the terminal." : "Invalid authorization callback.");
    if (!callback.accepted) return;
    if ("code" in callback) finish(callback.code, undefined);
    else finish(undefined, new Error("authorization was denied"));
  });
  try {
    addressPort = await listen(server);
  } catch {
    finish(undefined, new Error("callback listener failed"));
    throw new Error("callback listener failed");
  }
  timer = setTimeout(() => finish(undefined, new Error("authorization callback timed out")), REAL_AUTH_TIMEOUT_MS);
  return {
    port: addressPort,
    result: resultResolvers.promise,
    close: async () => {
      finish(undefined, new Error("callback listener closed"));
      await closeServer();
    },
  };
}

function revokeRefreshToken(refreshToken: string): Promise<"revoked" | "skipped"> {
  const body = `token=${encodeURIComponent(refreshToken)}`;
  const { promise, resolve } = Promise.withResolvers<"revoked" | "skipped">();
  try {
    const revocationRequest = httpsRequest(
      {
        hostname: "oauth2.googleapis.com",
        path: "/revoke",
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode === 200 ? "revoked" : "skipped"));
      },
    );
    revocationRequest.once("error", () => resolve("skipped"));
    revocationRequest.end(body);
  } catch {
    resolve("skipped");
  }
  return promise;
}

async function writeRealEvidence(revocation: "revoked" | "skipped"): Promise<string> {
  const evidence = {
    proof: "oauth",
    credential_shape_validated: true,
    browser_authorization_completed: true,
    callback: "GET /oauth2callback on 127.0.0.1 with timing-safe one-use state",
    granted_scope: READONLY_SCOPE,
    gmail_profile_address_resolved: true,
    refresh_token_issued: true,
    access_token_refresh_succeeded: true,
    revocation,
  };
  await writeFile(REAL_EVIDENCE_PATH, `${JSON.stringify(evidence)}\n`, { encoding: "utf8", mode: 0o600 });
  return REAL_EVIDENCE_PATH;
}


function safeEqualText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class OneUseState {
  readonly value: string;
  #consumed = false;

  constructor(value = randomBytes(32).toString("base64url")) {
    this.value = value;
  }

  validate(candidate: string): boolean {
    const matches = safeEqualText(this.value, candidate);
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

  const exactParameter = (name: string): string | undefined => {
    const values = target.searchParams.getAll(name);
    if (values.length !== 1 || values[0] === undefined || values[0].length === 0) return undefined;
    return values[0];
  };
  const stateValue = exactParameter("state");
  const code = exactParameter("code");
  const error = exactParameter("error");
  if (stateValue === undefined || !state.validate(stateValue)) return { accepted: false, reason: "state" };
  if ((code === undefined) === (error === undefined)) return { accepted: false, reason: "code-or-error" };
  return code === undefined ? { accepted: true, error: error as string } : { accepted: true, code };
}

export async function buildAuthorizationFixture(port: number): Promise<{
  client: InstanceType<typeof google.auth.OAuth2>;
  redirectUri: string;
  state: OneUseState;
  codeVerifier: string;
  codeChallenge: string;
  url: string;
}> {
  const redirectUri = buildRedirectUri(port);
  const client = new google.auth.OAuth2(SYNTHETIC_CLIENT_ID, undefined, redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = new OneUseState();
  const url = client.generateAuthUrl({
    access_type: "offline",
    client_id: SYNTHETIC_CLIENT_ID,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: [READONLY_SCOPE],
    state: state.value,
  });
  return { client, redirectUri, state, codeVerifier, codeChallenge, url };
}

export async function exchangeAuthorizationCode(
  client: InstanceType<typeof google.auth.OAuth2>,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenFixture> {
  const response = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
  return response.tokens as TokenFixture;
}

function assertExactReadonlyScope(scope: string | undefined): void {
  assert.deepEqual(scope?.trim().split(/\s+/u), [READONLY_SCOPE]);
}

export function commitAuthorizedAccount(
  token: TokenFixture,
  profile: ProfileFixture,
  expectedEmail: string,
  prior: StoredAccount | undefined,
  priorRefreshUsable: boolean,
  commit: (account: StoredAccount) => void,
): void {
  assertExactReadonlyScope(token.scope);
  if (profile.emailAddress === undefined || profile.emailAddress.length === 0) {
    throw new Error("gmail profile is missing");
  }
  if (!safeEqualText(profile.emailAddress, expectedEmail)) {
    throw new Error("gmail identity mismatch");
  }
  const refreshToken = token.refresh_token;
  if (refreshToken === undefined && (prior === undefined || !priorRefreshUsable)) {
    throw new Error("refresh token required");
  }
  const next: StoredAccount = {
    email: profile.emailAddress,
    scopes: [READONLY_SCOPE],
    refreshToken: refreshToken ?? (prior as StoredAccount).refreshToken,
  };
  commit(next);
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("callback listener address unavailable"));
      else resolve(address.port);
    });
  });
}

function sendCallback(port: number, method: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const childRequest = request({ host: "127.0.0.1", port, path: target, method }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    childRequest.once("error", reject);
    childRequest.end();
  });
}

async function exerciseListener(kind: "success" | "rejection" | "timeout"): Promise<{ closed: boolean; result: CallbackResult | undefined }> {
  const state = new OneUseState();
  const server = createServer();
  let port = 0;
  let timer: NodeJS.Timeout | undefined;
  const terminal = new Promise<CallbackResult | undefined>((resolve) => {
    const finish = (result: CallbackResult | undefined): void => {
      if (timer) clearTimeout(timer);
      server.close(() => resolve(result));
    };
    server.on("request", (incoming, response) => {
      const result = validateCallbackRequest(incoming.method, incoming.url ?? "", buildRedirectUri(port), state);
      response.statusCode = result.accepted ? 200 : 400;
      response.end("synthetic callback");
      finish(result);
    });
    timer = setTimeout(() => finish(undefined), 100);
  });
  port = await listen(server);
  const redirectUri = buildRedirectUri(port);
  if (kind === "success") {
    await sendCallback(port, "GET", `${CALLBACK_PATH}?code=synthetic-code&state=${encodeURIComponent(state.value)}`);
  } else if (kind === "rejection") {
    await sendCallback(port, "GET", `${CALLBACK_PATH}?code=synthetic-code&state=wrong-state`);
  }
  const result = await terminal;
  return { closed: server.listening === false, result };
}
export async function runRealOAuthProof(): Promise<RealAuthorizationResult> {
  let listener: RealCallbackListener | undefined;
  try {
    const credential = await readDesktopCredential();
    const state = new OneUseState();
    listener = await startRealCallbackListener(state);
    const redirectUri = buildRedirectUri(listener.port);
    const client = new google.auth.OAuth2(credential.clientId, credential.clientSecret, redirectUri);
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const authorizationUrl = client.generateAuthUrl({
      access_type: "offline",
      client_id: credential.clientId,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      prompt: "consent",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: [READONLY_SCOPE],
      state: state.value,
    });
    const authorization = new URL(authorizationUrl);
    assert.equal(authorization.hostname, "accounts.google.com");
    assert.equal(authorization.pathname, "/o/oauth2/v2/auth");
    assert.equal(authorization.searchParams.get("client_id"), credential.clientId);
    assert.equal(authorization.searchParams.get("redirect_uri"), redirectUri);
    assert.equal(authorization.searchParams.get("response_type"), "code");
    assert.equal(authorization.searchParams.get("scope"), READONLY_SCOPE);
    assert.equal(authorization.searchParams.get("access_type"), "offline");
    assert.equal(authorization.searchParams.get("prompt"), "consent");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("code_challenge"), codeChallenge);
    assert.equal(codeChallenge, generatePkce(codeVerifier));

    await openSystemBrowser(authorizationUrl);
    const code = await listener.result;
    const tokenResponse = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    const token = tokenResponse.tokens;
    assertExactReadonlyScope(token.scope);
    const refreshToken = token.refresh_token;
    assert.ok(typeof refreshToken === "string" && refreshToken.trim().length > 0);

    client.setCredentials(token);
    const gmail = google.gmail({ version: "v1", auth: client });
    const profile = await gmail.users.getProfile({ userId: "me" });
    assert.ok(typeof profile.data.emailAddress === "string" && profile.data.emailAddress.trim().length > 0);

    const refreshed = await client.refreshAccessToken();
    assert.ok(typeof refreshed.credentials.access_token === "string" && refreshed.credentials.access_token.length > 0);
    const revocation = await revokeRefreshToken(refreshToken);
    const evidence_path = await writeRealEvidence(revocation);
    return { passed: true, evidence_path, revocation };
  } catch {
    throw new Error("real OAuth proof failed");
  } finally {
    await listener?.close();
  }
}

export async function runOAuthProof(): Promise<{ passed: true; terminalPaths: number }> {
  const listener = createServer();
  const port = await listen(listener);
  listener.close();
  const fixture = await buildAuthorizationFixture(port);
  const authorization = new URL(fixture.url);
  assert.equal(authorization.hostname, "accounts.google.com");
  assert.equal(authorization.pathname, "/o/oauth2/v2/auth");
  assert.equal(authorization.searchParams.get("client_id"), SYNTHETIC_CLIENT_ID);
  assert.equal(authorization.searchParams.get("redirect_uri"), fixture.redirectUri);
  assert.equal(authorization.searchParams.get("response_type"), "code");
  assert.equal(authorization.searchParams.get("scope"), READONLY_SCOPE);
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(authorization.searchParams.get("prompt"), "consent");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("code_challenge"), fixture.codeChallenge);
  assert.equal(fixture.codeChallenge, generatePkce(fixture.codeVerifier));

  assert.equal(fixture.state.validate(fixture.state.value), true);
  assert.equal(fixture.state.validate(fixture.state.value), false);
  assert.equal(safeEqualText(fixture.state.value, fixture.state.value), true);
  assert.equal(safeEqualText(fixture.state.value, `${fixture.state.value}x`), false);

  const callbackState = new OneUseState("fixed-state");
  const callbackUri = "http://127.0.0.1:45678/oauth2callback";
  const valid = validateCallbackRequest("GET", "/oauth2callback?code=synthetic-code&state=fixed-state", callbackUri, callbackState);
  assert.deepEqual(valid, { accepted: true, code: "synthetic-code" });
  const invalidRequests: Array<[string | undefined, string]> = [
    ["POST", "/oauth2callback?code=x&state=fixed-state"],
    ["GET", "/wrong?code=x&state=fixed-state"],
    ["GET", "http://127.0.0.2:45678/oauth2callback?code=x&state=fixed-state"],
    ["GET", "/oauth2callback?code=x&code=y&state=fixed-state"],
    ["GET", "/oauth2callback?code=&state=fixed-state"],
    ["GET", "/oauth2callback?code=x"],
    ["GET", "/oauth2callback?code=x&error=access_denied&state=fixed-state"],
  ];
  for (const [method, target] of invalidRequests) {
    const result = validateCallbackRequest(method, target, callbackUri, new OneUseState("fixed-state"));
    assert.equal(result.accepted, false);
  }
  const denial = validateCallbackRequest("GET", "/oauth2callback?error=access_denied&state=denial-state", callbackUri, new OneUseState("denial-state"));
  assert.deepEqual(denial, { accepted: true, error: "access_denied" });

  const successListener = await exerciseListener("success");
  const rejectionListener = await exerciseListener("rejection");
  const timeoutListener = await exerciseListener("timeout");
  assert.equal(successListener.closed, true);
  assert.equal(successListener.result?.accepted, true);
  assert.equal(rejectionListener.closed, true);
  assert.equal(rejectionListener.result?.accepted, false);
  assert.equal(timeoutListener.closed, true);
  assert.equal(timeoutListener.result, undefined);

  const captured: Array<Record<string, unknown>> = [];
  const tokenClient = new google.auth.OAuth2(SYNTHETIC_CLIENT_ID, undefined, fixture.redirectUri);
  tokenClient.getToken = async (options: Record<string, unknown>) => {
    captured.push(options);
    return { tokens: { scope: READONLY_SCOPE, refresh_token: "synthetic-refresh" } } as never;
  };
  const token = await exchangeAuthorizationCode(tokenClient, "synthetic-code", fixture.codeVerifier, fixture.redirectUri);
  assert.deepEqual(captured, [{ code: "synthetic-code", codeVerifier: fixture.codeVerifier, redirect_uri: fixture.redirectUri }]);
  assert.equal(token.scope, READONLY_SCOPE);

  let committed: StoredAccount | undefined;
  commitAuthorizedAccount(
    token,
    { emailAddress: "person@example.test" },
    "person@example.test",
    undefined,
    false,
    (account) => {
      committed = account;
    },
  );
  assert.equal(committed?.email, "person@example.test");
  assert.equal(committed?.refreshToken, "synthetic-refresh");

  let commitCount = 0;
  assert.throws(() => commitAuthorizedAccount(
    { scope: "https://www.googleapis.com/auth/gmail.modify", refresh_token: "bad" },
    { emailAddress: "person@example.test" },
    "person@example.test",
    undefined,
    false,
    () => { commitCount += 1; },
  ));
  assert.equal(commitCount, 0);
  assert.throws(
    () => commitAuthorizedAccount({ scope: READONLY_SCOPE, refresh_token: "new" }, { emailAddress: "other@example.test" }, "person@example.test", committed, true, () => { commitCount += 1; }),
    /identity mismatch/u,
  );
  assert.equal(commitCount, 0);

  const prior: StoredAccount = { email: "person@example.test", scopes: [READONLY_SCOPE], refreshToken: "old-refresh" };
  let preserved: StoredAccount | undefined;
  commitAuthorizedAccount({ scope: READONLY_SCOPE }, { emailAddress: prior.email }, prior.email, prior, true, (account) => { preserved = account; });
  assert.equal(preserved?.refreshToken, prior.refreshToken);
  assert.throws(
    () => commitAuthorizedAccount({ scope: READONLY_SCOPE }, { emailAddress: prior.email }, prior.email, prior, false, () => { commitCount += 1; }),
    /refresh token required/u,
  );
  assert.equal(commitCount, 0);

  return { passed: true, terminalPaths: 3 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runOAuthProof();
    console.error(JSON.stringify({ proof: "oauth", realAuthorization: "awaiting owner browser authorization" }));
    const realAuthorization = await runRealOAuthProof();
    console.log(JSON.stringify({ proof: "oauth", ...result, realAuthorization }));
  } catch {
    console.error(JSON.stringify({ proof: "oauth", passed: false, error: "OAuth proof failed" }));
    process.exitCode = 1;
  }
}
