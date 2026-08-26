import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccountManager, redactSensitive } from "../../dist/accounts/index.js";
import { AccountProviderError, type AccountProvider } from "../../dist/mcp/session.js";
import { createMultigServer } from "../../dist/mcp/server.js";
import type { GmailApiClient } from "../../dist/gmail/client.js";
import { KeychainStore } from "../../dist/storage/keychain.js";
import {
  KEYCHAIN_SERVICE,
  OAUTH_CLIENT_KEYCHAIN_ACCOUNT,
  READONLY_SCOPE,
  keychainAccountForAlias,
  writeConfigAtomic,
} from "../../dist/storage/config.js";

const temporaryDirectories: string[] = [];
const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

test.afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", cliPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const { promise, resolve } = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number | null }>();
  child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  return promise;
}

test("CLI help stays on stdout and unknown commands stay on stderr", async () => {
  const help = await runCli("--help");
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /^Usage:/u);
  assert.equal(help.stderr, "");

  const unknown = await runCli("not-a-command");
  assert.equal(unknown.exitCode, 1);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /Usage:/u);

  const unknownWithHelp = await runCli("not-a-command", "--help");
  assert.equal(unknownWithHelp.exitCode, 1);
  assert.equal(unknownWithHelp.stdout, "");
  assert.match(unknownWithHelp.stderr, /Usage:/u);

  const invalidAuth = await runCli("auth", "list", "--unknown");
  assert.equal(invalidAuth.exitCode, 1);
  assert.equal(invalidAuth.stdout, "");
  assert.match(invalidAuth.stderr, /Usage:/u);
});

function gmailClientFor(alias: string, calls: string[]): GmailApiClient {
  return {
    users: {
      messages: {
        async list() {
          calls.push(`${alias}:list`);
          return { data: { messages: [{ id: `${alias}-message`, threadId: `${alias}-thread` }] } };
        },
        async get(params: { id?: string; format?: string }) {
          calls.push(`${alias}:${params.format ?? ""}:${params.id ?? ""}`);
          return {
            data: {
              id: params.id,
              threadId: `${alias}-thread`,
              snippet: `${alias} snippet`,
              internalDate: "1700000000000",
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "From", value: `${alias}@example.test` },
                  { name: "To", value: "recipient@example.test" },
                  { name: "Subject", value: `${alias} subject` },
                ],
                body: { data: Buffer.from(`${alias} body`, "utf8").toString("base64url") },
              },
            },
          };
        },
      },
    },
  };
}

function isolatedProvider(calls: string[]): AccountProvider {
  return {
    async listAccounts() {
      return [
        { alias: "alpha", email: "alpha@example.test", scopes: [READONLY_SCOPE], status: "connected" },
        { alias: "beta", email: "beta@example.test", scopes: [READONLY_SCOPE], status: "connected" },
      ];
    },
    async openSession(alias: string) {
      calls.push(`open:${alias}`);
      if (alias !== "alpha" && alias !== "beta") {
        throw new AccountProviderError("unknown_account", "provider detail contains a secret", alias);
      }
      return { alias, gmailClient: gmailClientFor(alias, calls) };
    },
  };
}

async function connectedPair(provider: AccountProvider) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMultigServer(provider);
  const client = new Client({ name: "integration-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("MCP account, search, and get-message flow preserves alias isolation", async () => {
  const calls: string[] = [];
  const { client, server } = await connectedPair(isolatedProvider(calls));
  try {
    const accounts = await client.callTool({ name: "gmail_accounts", arguments: {} });
    assert.deepEqual(accounts.structuredContent, {
      accounts: [
        { alias: "alpha", email: "alpha@example.test", scopes: [READONLY_SCOPE], status: "connected" },
        { alias: "beta", email: "beta@example.test", scopes: [READONLY_SCOPE], status: "connected" },
      ],
    });

    const alphaSearch = await client.callTool({ name: "gmail_search", arguments: { account: "alpha", query: "is:unread" } });
    assert.deepEqual(alphaSearch.structuredContent, {
      account: "alpha",
      messages: [{ id: "alpha-message", threadId: "alpha-thread", snippet: "alpha snippet", from: "alpha@example.test", to: "recipient@example.test", subject: "alpha subject" }],
    });

    const betaSearch = await client.callTool({ name: "gmail_search", arguments: { account: "beta", query: "is:unread" } });
    assert.deepEqual(betaSearch.structuredContent, {
      account: "beta",
      messages: [{ id: "beta-message", threadId: "beta-thread", snippet: "beta snippet", from: "beta@example.test", to: "recipient@example.test", subject: "beta subject" }],
    });

    const alphaMessage = await client.callTool({ name: "gmail_get_message", arguments: { account: "alpha", messageId: "alpha-message" } });
    assert.equal(alphaMessage.structuredContent.account, "alpha");
    assert.equal(alphaMessage.structuredContent.textBody, "alpha body");
    assert.equal(alphaMessage.structuredContent.textBody === "beta body", false);

    const unknown = await client.callTool({ name: "gmail_get_message", arguments: { account: "missing", messageId: "beta-message" } });
    assert.deepEqual(unknown.structuredContent, {
      account: "missing",
      error: { code: "unknown_account", message: "The selected account alias is not configured.", account: "missing" },
    });
    assert.equal(calls.some((call) => call.startsWith("missing:")), false);
  } finally {
    await client.close();
    await server.close();
  }
});

async function fakeHelper(directory: string): Promise<string> {
  const records = join(directory, "records");
  await mkdir(records, { mode: 0o700 });
  const helper = join(directory, "keychain-helper");
  await writeFile(helper, `#!/bin/sh
set -eu
records='${records}'
operation="$1"
record="$2"
path="$records/$record"
case "$operation" in
  create)
    if [ -e "$path" ]; then exit 10; fi
    cat > "$path"
    ;;
  replace)
    if [ ! -e "$path" ]; then exit 11; fi
    cat > "$path"
    ;;
  read)
    if [ ! -e "$path" ]; then exit 11; fi
    cat "$path" >&3
    ;;
  delete)
    if [ ! -e "$path" ]; then exit 11; fi
    rm "$path"
    ;;
  *) exit 3 ;;
esac
`);
  await chmod(helper, 0o700);
  return helper;
}

test("storage and account sessions use a fake helper without persisting access tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multig-mcp-integration-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "config.json");
  const helperPath = await fakeHelper(directory);
  const keychain = new KeychainStore({ helperPath });
  await keychain.createSecret(OAUTH_CLIENT_KEYCHAIN_ACCOUNT, JSON.stringify({ clientId: "synthetic-client", clientSecret: "synthetic-secret" }));
  await keychain.createAccountRefreshToken("alpha", "synthetic-refresh-token");
  await writeConfigAtomic(configPath, {
    version: 1,
    accounts: {
      alpha: {
        email: "alpha@example.test",
        scopes: [READONLY_SCOPE],
        keychainService: KEYCHAIN_SERVICE,
        keychainAccount: keychainAccountForAlias("alpha"),
      },
    },
  });

  let accessTokenCalls = 0;
  const fakeClient = {
    credentials: {} as Record<string, unknown>,
    setCredentials(credentials: Record<string, unknown>) {
      this.credentials = { ...this.credentials, ...credentials };
    },
    on() {
      return this;
    },
    async getAccessToken() {
      accessTokenCalls += 1;
      return { token: "synthetic-access-token" };
    },
  };
  const manager = new AccountManager(
    { configPath, keychain },
    { clientFactory: () => fakeClient as never },
  );

  assert.deepEqual(await manager.listAccounts(), [{ alias: "alpha", email: "alpha@example.test", scopes: [READONLY_SCOPE], status: "connected" }]);
  const session = await manager.getAccountSession("alpha");
  assert.equal(session, fakeClient);
  assert.equal(accessTokenCalls, 1);
  const storedConfig = await readFile(configPath, "utf8");
  assert.equal(storedConfig.includes("synthetic-access-token"), false);
  assert.equal(storedConfig.includes("synthetic-refresh-token"), false);
});

test("credential-shaped errors are redacted before crossing module boundaries", async () => {
  assert.deepEqual(redactSensitive({
    refresh_token: "synthetic-refresh-token",
    nested: { client_secret: "synthetic-client-secret", accessToken: "synthetic-access-token" },
  }), {
    refresh_token: "[redacted]",
    nested: { client_secret: "[redacted]", accessToken: "[redacted]" },
  });

  const provider: AccountProvider = {
    async listAccounts() { return []; },
    async openSession(alias) {
      throw new AccountProviderError("reauthorization_required", "refresh token synthetic-refresh-token", alias);
    },
  };
  const { client, server } = await connectedPair(provider);
  try {
    const result = await client.callTool({ name: "gmail_search", arguments: { account: "alpha", query: "is:unread" } });
    assert.deepEqual(result.structuredContent, {
      account: "alpha",
      error: { code: "reauthorization_required", message: "The selected account requires reauthorization.", account: "alpha" },
    });
    assert.equal(JSON.stringify(result.structuredContent).includes("synthetic-refresh-token"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

