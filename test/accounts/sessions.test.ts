import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Auth } from "googleapis";
import { AccountManager, AccountSessionError, mapGoogleError, redactSensitive } from "../../src/accounts/index.ts";
import { addAccount, reauthorizeAccount, removeAccount } from "../../src/auth/lifecycle.ts";
import { GMAIL_SCOPES, mutateConfig, READONLY_SCOPE } from "../../src/storage/config.ts";
import { KeychainError, KeychainStore } from "../../src/storage/keychain.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class MemoryKeychain extends KeychainStore {
  readonly values = new Map<string, Buffer>();
  failRefreshReplacement = false;

  constructor() {
    super({ helperPath: "/dev/null" });
  }

  override async createSecret(record: string, secret: Buffer | string): Promise<void> {
    if (this.values.has(record)) throw new KeychainError("create", "duplicate", 10);
    this.values.set(record, Buffer.from(secret));
  }

  override async replaceSecret(record: string, secret: Buffer | string): Promise<void> {
    if (!this.values.has(record)) throw new KeychainError("replace", "not_found", 11);
    this.values.set(record, Buffer.from(secret));
  }
  override async replaceAccountRefreshToken(alias: string, secret: string): Promise<void> {
    if (this.failRefreshReplacement) throw new KeychainError("replace", "unavailable", null);
    await super.replaceAccountRefreshToken(alias, secret);
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

describe("account session contract", () => {
  it("reports status from metadata and Keychain presence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-accounts-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");
    const keychain = new MemoryKeychain();
    await keychain.createOAuthClient(JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" }));
    await mutateConfig(configPath, (config) => {
      config.accounts.personal = {
        email: "owner@example.test",
        scopes: [READONLY_SCOPE],
        keychainService: "multig-mcp.v1",
        keychainAccount: "gmail:personal",
      };
      config.accounts.missing = {
        email: "missing@example.test",
        scopes: [READONLY_SCOPE],
        keychainService: "multig-mcp.v1",
        keychainAccount: "gmail:missing",
      };
    });
    await keychain.createAccountRefreshToken("personal", "refresh-token");
    const summaries = await new AccountManager({ configPath, keychain }).listAccounts();
    assert.deepEqual(summaries.map(({ alias, status }) => ({ alias, status })), [
      { alias: "missing", status: "reauthorization_required" },
      { alias: "personal", status: "connected" },
    ]);
  });

  it("caches an unexpired access token and never persists it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-accounts-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");
    const keychain = new MemoryKeychain();
    await keychain.createOAuthClient(JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" }));
    await keychain.createAccountRefreshToken("personal", "refresh-token");
    await mutateConfig(configPath, (config) => {
      config.accounts.personal = {
        email: "owner@example.test",
        scopes: [READONLY_SCOPE],
        keychainService: "multig-mcp.v1",
        keychainAccount: "gmail:personal",
      };
    });
    let refreshCalls = 0;
    const fakeClient = {
      credentials: {} as { access_token?: string; expiry_date?: number; refresh_token?: string },
      setCredentials(credentials: { access_token?: string; expiry_date?: number; refresh_token?: string }) {
        this.credentials = { ...this.credentials, ...credentials };
      },
      async getAccessToken() {
        refreshCalls += 1;
        this.credentials = { ...this.credentials, access_token: "access-token", expiry_date: Date.now() + 300_000 };
        return { token: "access-token" };
      },
      on() { return this; },
    };
    const manager = new AccountManager({ configPath, keychain }, {
      clientFactory: () => fakeClient as unknown as Auth.OAuth2Client,
    });
    const first = await manager.getAccountSession("personal");
    const second = await manager.getAccountSession("PERSONAL");
    assert.equal(first, second);
    assert.equal(refreshCalls, 1);
    assert.equal((await keychain.readAccountRefreshToken("personal"))?.toString(), "refresh-token");
  });

  it("maps Google failures and recursively redacts token-shaped fields", () => {
    assert.equal(mapGoogleError({ response: { status: 429 } }, "personal").code, "gmail_rate_limited");
    assert.equal(mapGoogleError({ response: { status: 401 } }, "personal").code, "reauthorization_required");
    const redacted = redactSensitive({ nested: { refresh_token: "secret", safe: "value" }, array: [{ accessToken: "secret" }] }) as { nested: { refresh_token: string; safe: string }; array: Array<{ accessToken: string }> };
    assert.deepEqual(redacted, { nested: { refresh_token: "[redacted]", safe: "value" }, array: [{ accessToken: "[redacted]" }] });
    assert.throws(() => { throw new AccountSessionError("unknown_account", "personal"); }, AccountSessionError);
  });
  it("invalidates cached sessions across reauthorization and remove plus re-add", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-accounts-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");
    const keychain = new MemoryKeychain();
    await keychain.createOAuthClient(JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" }));
    const flow = (refreshToken: string) => async () => ({ email: "owner@example.test", scopes: GMAIL_SCOPES, refreshToken });
    await addAccount("personal", { configPath, keychain, oauthFlow: flow("old-refresh") });
    const clients: Array<{ initialRefreshToken?: string }> = [];
    const manager = new AccountManager({ configPath, keychain }, {
      clientFactory: () => {
        const client = {
          credentials: {} as { access_token?: string; expiry_date?: number; refresh_token?: string },
          initialRefreshToken: undefined as string | undefined,
          setCredentials(credentials: { access_token?: string; expiry_date?: number; refresh_token?: string }) {
            this.credentials = { ...this.credentials, ...credentials };
            if (this.initialRefreshToken === undefined && credentials.refresh_token !== undefined) this.initialRefreshToken = credentials.refresh_token;
          },
          async getAccessToken() {
            this.credentials = { ...this.credentials, access_token: "access-token", expiry_date: Date.now() + 300_000 };
            return { token: "access-token" };
          },
          on() { return this; },
        };
        clients.push(client);
        return client as unknown as Auth.OAuth2Client;
      },
    });
    const first = await manager.getAccountSession("personal");
    await reauthorizeAccount("personal", { configPath, keychain, oauthFlow: flow("new-refresh") });
    const second = await manager.getAccountSession("personal");
    await removeAccount("personal", { configPath, keychain });
    await addAccount("personal", { configPath, keychain, oauthFlow: flow("readded-refresh") });
    const third = await manager.getAccountSession("personal");
    assert.notEqual(second, first);
    assert.notEqual(third, second);
    assert.deepEqual(clients.map((client) => client.initialRefreshToken), ["old-refresh", "new-refresh", "readded-refresh"]);
  });

  it("reports refresh-token rotation persistence failure before returning a session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-accounts-"));
    directories.push(directory);
    const configPath = join(directory, "config.json");
    const keychain = new MemoryKeychain();
    await keychain.createOAuthClient(JSON.stringify({ clientId: "client-id", clientSecret: "client-secret" }));
    await addAccount("personal", { configPath, keychain, oauthFlow: async () => ({ email: "owner@example.test", scopes: GMAIL_SCOPES, refreshToken: "old-refresh" }) });
    keychain.failRefreshReplacement = true;
    let tokenListener: ((tokens: { access_token: string; expiry_date: number; refresh_token: string }) => void) | undefined;
    const client = {
      credentials: {} as { access_token?: string; expiry_date?: number; refresh_token?: string },
      setCredentials(credentials: { access_token?: string; expiry_date?: number; refresh_token?: string }) {
        this.credentials = { ...this.credentials, ...credentials };
      },
      async getAccessToken() {
        const expiryDate = Date.now() + 300_000;
        tokenListener?.({ access_token: "access-token", expiry_date: expiryDate, refresh_token: "rotated-refresh" });
        this.credentials = { ...this.credentials, access_token: "access-token", expiry_date: expiryDate };
        return { token: "access-token" };
      },
      on(_event: string, listener: typeof tokenListener) {
        tokenListener = listener;
        return this;
      },
    };
    const manager = new AccountManager({ configPath, keychain }, {
      clientFactory: () => client as unknown as Auth.OAuth2Client,
    });
    await assert.rejects(
      manager.getAccountSession("personal"),
      (error: unknown) => error instanceof AccountSessionError && error.code === "invalid_local_configuration",
    );
    assert.equal((await keychain.readAccountRefreshToken("personal"))?.toString(), "old-refresh");
  });
});
