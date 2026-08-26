import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AccountProviderError, type AccountProvider } from "../../dist/mcp/session.js";
import { createMultigServer, serve } from "../../dist/mcp/server.js";
import type { GmailApiClient } from "../../dist/gmail/client.js";

function providerWithCalls(calls: string[]): AccountProvider {
  const gmailClient = {
    users: {
      messages: {
        async list() {
          calls.push("list");
          return { data: { messages: [{ id: "message-1", threadId: "thread-1" }] } };
        },
        async get(params: { id?: string; format?: string }) {
          calls.push(`${params.format ?? ""}:${params.id ?? ""}`);
          return {
            data: {
              id: params.id,
              threadId: "thread-1",
              internalDate: "1700000000000",
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "From", value: "sender@example.test" },
                  { name: "To", value: "recipient@example.test" },
                  { name: "Subject", value: "subject" },
                ],
                body: { data: Buffer.from("body", "utf8").toString("base64url") },
              },
            },
          };
        },
      },
    },
  } as unknown as GmailApiClient;

  return {
    async listAccounts() {
      return [
        { alias: "zeta", email: "zeta@example.test", scopes: ["scope"], status: "connected" },
        { alias: "alpha", email: "alpha@example.test", scopes: ["scope"], status: "connected" },
      ];
    },
    async openSession(alias) {
      calls.push(`open:${alias}`);
      if (alias !== "alpha" && alias !== "zeta") {
        throw new AccountProviderError("unknown_account", "untrusted provider detail", alias);
      }
      return { alias, gmailClient };
    },
  };
}

async function connectedPair(provider: AccountProvider) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMultigServer(provider);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("initializes and exercises account, search, and get-message tools", async () => {
  const calls: string[] = [];
  const { client, server } = await connectedPair(providerWithCalls(calls));
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["gmail_accounts", "gmail_search", "gmail_get_message"]);

    const accounts = await client.callTool({ name: "gmail_accounts", arguments: {} });
    assert.deepEqual(accounts.structuredContent, {
      accounts: [
        { alias: "alpha", email: "alpha@example.test", scopes: ["scope"], status: "connected" },
        { alias: "zeta", email: "zeta@example.test", scopes: ["scope"], status: "connected" },
      ],
    });

    const search = await client.callTool({ name: "gmail_search", arguments: { account: "alpha", query: "is:unread", limit: 1 } });
    assert.deepEqual(search.structuredContent, {
      account: "alpha",
      messages: [{ id: "message-1", threadId: "thread-1", from: "sender@example.test", to: "recipient@example.test", subject: "subject" }],
    });

    const message = await client.callTool({ name: "gmail_get_message", arguments: { account: "alpha", messageId: "message-1" } });
    assert.deepEqual(message.structuredContent, {
      account: "alpha",
      id: "message-1",
      threadId: "thread-1",
      sender: "sender@example.test",
      recipients: ["recipient@example.test"],
      subject: "subject",
      timestamp: "2023-11-14T22:13:20.000Z",
      textBody: "body",
      labels: [],
      attachments: [],
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("rejects schema-invalid input and unknown accounts without fallback Gmail calls", async () => {
  const calls: string[] = [];
  const { client, server } = await connectedPair(providerWithCalls(calls));
  try {
    const invalid = await client.callTool({ name: "gmail_search", arguments: { account: "alpha", query: "", limit: 1 } });
    assert.equal(invalid.isError, true);
    const unknown = await client.callTool({ name: "gmail_get_message", arguments: { account: "missing", messageId: "message-1" } });
    assert.equal(unknown.isError, true);
    assert.deepEqual(unknown.structuredContent, {
      account: "missing",
      error: { code: "unknown_account", message: "The selected account alias is not configured.", account: "missing" },
    });
    assert.deepEqual(calls, ["open:missing"]);
  } finally {
    await client.close();
    await server.close();
  }
});

async function runStdioChild(): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./stdio-child.js", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const { promise: ready, resolve } = Promise.withResolvers<void>();
  const maybeReady = (): void => {
    if (stdout.includes("\"id\":2") && stderr.includes("synthetic MCP diagnostic")) resolve();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    maybeReady();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    maybeReady();
  });
  const closed = once(child, "close");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "stdio-test", version: "1" } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gmail_accounts", arguments: {} } })}\n`);
  await ready;
  child.kill();
  await closed;
  return { stdout, stderr };
}


test("stdio child emits JSON-RPC on stdout and diagnostics only on stderr", async () => {
  const capture = await runStdioChild();
  const lines = capture.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length >= 2, true);
  for (const line of lines) {
    const message = JSON.parse(line) as { jsonrpc?: string };
    assert.equal(message.jsonrpc, "2.0");
  }
  assert.equal(capture.stdout.includes("synthetic MCP diagnostic"), false);
  assert.equal(capture.stderr.includes("synthetic MCP diagnostic"), true);
});
