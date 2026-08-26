import assert from "node:assert/strict";
import { request } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  addAccount,
  configureOAuthClient,
  listAuthAccounts,
  parseDesktopCredentials,
  reauthorizeAccount,
  removeAccount,
  AuthLifecycleError,
} from "../../src/auth/lifecycle.ts";
import {
  buildRedirectUri,
  READONLY_SCOPE,
  runOAuthFlow,
  OneUseState,
  validateCallbackRequest,
  type OAuthFlowResult,
} from "../../src/auth/oauth.ts";
import { readConfig } from "../../src/storage/config.ts";
import { KeychainError, KeychainStore } from "../../src/storage/keychain.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class MemoryKeychain extends KeychainStore {
  readonly values = new Map<string, Buffer>();

  constructor() {
    super({ helperPath: "/dev/null" });
  }

  override async createSecret(record: string, secret: Buffer | string): Promise<void> {
    if (this.values.has(record)) throw new KeychainError("create", "duplicate", 10);
    this.values.set(record, Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret));
  }

  override async replaceSecret(record: string, secret: Buffer | string): Promise<void> {
    if (!this.values.has(record)) throw new KeychainError("replace", "not_found", 11);
    this.values.set(record, Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret));
  }

  override async readSecret(record: string): Promise<Buffer> {
    const value = this.values.get(record);
    if (value === undefined) throw new KeychainError("read", "not_found", 11);
    return Buffer.from(value);
  }

  override async deleteSecret(record: string, allowMissing = false): Promise<void> {
    if (!this.values.delete(record) && !allowMissing) throw new KeychainError("delete", "not_found", 11);
  }
}

function clientFile() {
  return {
    installed: {
      client_id: "client-id",
      client_secret: "client-secret",
      redirect_uris: ["http://127.0.0.1"],
    },
  };
}

function successfulFlow(email: string, refreshToken: string | undefined): (credentials: { clientId: string; clientSecret: string }, alias: string) => Promise<OAuthFlowResult> {
  return async () => ({
    email,
    scopes: [READONLY_SCOPE],
    ...(refreshToken === undefined ? {} : { refreshToken }),
  });
}

describe("OAuth callback and PKCE", () => {
  it("enforces fixed loopback origin and one-use state", () => {
    const state = new OneUseState("state-value");
    const redirect = buildRedirectUri(43123);
    assert.deepEqual(validateCallbackRequest("GET", `${redirect}?state=state-value&code=code`, redirect, state), { accepted: true, code: "code" });
    assert.equal(validateCallbackRequest("GET", `${redirect}?state=state-value&code=second`, redirect, state).accepted, false);
    const otherState = new OneUseState("state-value");
    assert.equal(validateCallbackRequest("GET", `http://localhost:43123/oauth2callback?state=state-value&code=code`, redirect, otherState).accepted, false);
    assert.equal(validateCallbackRequest("POST", `${redirect}?state=state-value&code=code`, redirect, new OneUseState("state-value")).accepted, false);
  });

  it("runs the loopback flow with exact scope and Gmail identity seams", async () => {
    let authorization: Record<string, unknown> | undefined;
    let exchanged: { code: string; verifier: string; redirectUri: string } | undefined;
    let profileCredentials: Record<string, unknown> | undefined;
    const fakeClient = {
      credentials: {} as Record<string, unknown>,
      setCredentials(credentials: Record<string, unknown>) {
        this.credentials = { ...credentials };
      },
      async generateCodeVerifierAsync() { return { codeVerifier: "verifier", codeChallenge: "challenge" }; },
      generateAuthUrl(options: Record<string, unknown>) {
        authorization = options;
        return "https://accounts.google.test/authorize";
      },
      async getToken() { return { tokens: { scope: READONLY_SCOPE, refresh_token: "refresh-token" } }; },
    };
    const result = await runOAuthFlow({
      clientId: "client-id",
      clientSecret: "client-secret",
      createClient: () => fakeClient as never,
      openBrowser: async () => {
        const redirectUri = authorization?.redirect_uri as string;
        const callback = new URL(redirectUri);
        callback.searchParams.set("state", authorization?.state as string);
        callback.searchParams.set("code", "authorization-code");
        await new Promise<void>((resolve, reject) => {
          const callbackRequest = request(callback, (response) => {
            response.resume();
            response.once("end", resolve);
          });
          callbackRequest.once("error", reject);
          callbackRequest.end();
        });
      },
      exchangeCode: async (_client, code, verifier, redirectUri) => {
        exchanged = { code, verifier, redirectUri };
        return { scope: READONLY_SCOPE, refresh_token: "refresh-token", access_token: "access-token", expiry_date: 123 };
      },
      fetchProfile: async (client) => {
        profileCredentials = { ...client.credentials } as Record<string, unknown>;
        return "owner@example.test";
      },
    });
    assert.deepEqual(result, { email: "owner@example.test", scopes: [READONLY_SCOPE], refreshToken: "refresh-token" });
    assert.deepEqual(profileCredentials, {
      scope: READONLY_SCOPE,
      refresh_token: "refresh-token",
      access_token: "access-token",
      expiry_date: 123,
    });
    assert.equal(authorization?.access_type, "offline");
    assert.equal(authorization?.prompt, "consent");
    assert.equal(authorization?.code_challenge_method, "S256");
    assert.deepEqual(authorization?.scope, [READONLY_SCOPE]);
    assert.deepEqual(exchanged, { code: "authorization-code", verifier: "verifier", redirectUri: authorization?.redirect_uri });
  });
  it("closes callback listeners on browser and exchange terminal paths", async () => {
    const probeClosedPort = async (redirectUri: string): Promise<void> => {
      const status = await new Promise<"closed" | "open">((resolve) => {
        const callbackRequest = request(redirectUri, (response) => {
          response.resume();
          resolve("open");
        });
        callbackRequest.once("error", () => resolve("closed"));
        callbackRequest.end();
      });
      assert.equal(status, "closed");
    };
    let authorization: Record<string, unknown> | undefined;
    let redirectUri = "";
    const createClient = () => ({
      async generateCodeVerifierAsync() { return { codeVerifier: "verifier", codeChallenge: "challenge" }; },
      generateAuthUrl(options: Record<string, unknown>) {
        authorization = options;
        return "https://accounts.google.test/authorize";
      },
    }) as never;
    const browserError = await runOAuthFlow({
      clientId: "client-id",
      clientSecret: "client-secret",
      createClient,
      openBrowser: async () => {
        redirectUri = authorization?.redirect_uri as string;
        throw new Error("browser unavailable");
      },
    }).then(() => undefined, (error: unknown) => error);
    assert.equal((browserError as { code?: unknown } | undefined)?.code, "oauth_callback_invalid");
    await probeClosedPort(redirectUri);

    authorization = undefined;
    redirectUri = "";
    const exchangeError = await runOAuthFlow({
      clientId: "client-id",
      clientSecret: "client-secret",
      createClient,
      openBrowser: async () => {
        redirectUri = authorization?.redirect_uri as string;
        const callback = new URL(redirectUri);
        callback.searchParams.set("state", authorization?.state as string);
        callback.searchParams.set("code", "authorization-code");
        await new Promise<void>((resolve, reject) => {
          const callbackRequest = request(callback, (response) => {
            response.resume();
            response.once("end", resolve);
          });
          callbackRequest.once("error", reject);
          callbackRequest.end();
        });
      },
      exchangeCode: async () => {
        throw new Error("exchange unavailable");
      },
    }).then(() => undefined, (error: unknown) => error);
    assert.equal((exchangeError as { code?: unknown } | undefined)?.code, "oauth_exchange_failed");
    await probeClosedPort(redirectUri);
  });
});

describe("Keychain helper contract", () => {
  it("passes canonical records and secret bytes through the helper protocol", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-keychain-"));
    directories.push(directory);
    const helper = join(directory, "helper");
    const argumentsPath = join(directory, "arguments");
    const inputPath = join(directory, "input");
    await writeFile(helper, `#!/bin/sh
printf '%s\n%s\n' "$1" "$2" >> '${argumentsPath}'
if [ "$1" = "create" ]; then
  cat > '${inputPath}'
else
  printf 'read-secret' >&3
fi
`);
    await chmod(helper, 0o700);
    const keychain = new KeychainStore({ helperPath: helper });
    await keychain.createSecret("gmail:Primary", "secret-bytes");
    assert.equal((await keychain.readSecret("gmail:Primary")).toString("utf8"), "read-secret");
    assert.equal((await readFile(inputPath, "utf8")), "secret-bytes");
    assert.deepEqual((await readFile(argumentsPath, "utf8")).trim().split("\n"), [
      "create",
      "gmail:primary",
      "read",
      "gmail:primary",
    ]);
  });
});

describe("auth lifecycle", () => {
  it("imports desktop credentials, rejects duplicates, and keeps secrets out of metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-auth-"));
    directories.push(directory);
    const path = join(directory, "credentials.json");
    const configPath = join(directory, "config.json");
    const keychain = new MemoryKeychain();
    await writeFile(path, JSON.stringify(clientFile()));
    assert.deepEqual(parseDesktopCredentials(clientFile()), { clientId: "client-id", clientSecret: "client-secret" });
    await configureOAuthClient(path, { configPath, keychain });
    await assert.rejects(configureOAuthClient(path, { configPath, keychain }), (error: unknown) => error instanceof AuthLifecycleError && error.code === "oauth_client_already_configured");
    assert.equal((await readFile(configPath, "utf8").catch(() => "")).includes("client-secret"), false);
    assert.equal(keychain.values.get("oauth-client")?.toString("utf8").includes("client-secret"), true);
  });

  it("does not mutate when add receives no refresh token and manages an account after success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-auth-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");
    const keychain = new MemoryKeychain();
    await keychain.createOAuthClient(JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" }));
    await assert.rejects(
      addAccount("Personal", { configPath, keychain, oauthFlow: successfulFlow("owner@example.test", undefined) }),
      (error: unknown) => error instanceof AuthLifecycleError && error.code === "refresh_token_required",
    );
    assert.deepEqual((await readConfig(configPath)).accounts, {});
    await addAccount("Personal", { configPath, keychain, oauthFlow: successfulFlow("owner@example.test", "refresh-token") });
    assert.equal((await listAuthAccounts({ configPath, keychain }))[0]?.status, "connected");
    await removeAccount("personal", { configPath, keychain });
    assert.deepEqual((await readConfig(configPath)).accounts, {});
    assert.equal(keychain.values.has("gmail:personal"), false);
  });

  it("preserves prior state on identity mismatch and marks unusable omitted refresh tokens for reauthorization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-auth-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");
    const keychain = new MemoryKeychain();
    await keychain.createOAuthClient(JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" }));
    await addAccount("personal", { configPath, keychain, oauthFlow: successfulFlow("owner@example.test", "old-refresh") });
    const before = await readConfig(configPath);
    await assert.rejects(
      reauthorizeAccount("personal", { configPath, keychain, oauthFlow: successfulFlow("other@example.test", "new-refresh") }),
      (error: unknown) => error instanceof AuthLifecycleError && error.code === "account_identity_mismatch",
    );
    assert.deepEqual(await readConfig(configPath), before);
    assert.equal((await keychain.readAccountRefreshToken("personal"))?.toString(), "old-refresh");
    await reauthorizeAccount("personal", {
      configPath,
      keychain,
      oauthFlow: successfulFlow("owner@example.test", undefined),
      isPreviousRefreshTokenUsable: async () => false,
    });
    assert.equal((await listAuthAccounts({ configPath, keychain }))[0]?.status, "reauthorization_required");
  });
});
