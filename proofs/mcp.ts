import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

type Scenario = "success" | "schema-error" | "internal-error";

type CapturedChild = {
  stdout: string;
  stderr: string;
  lines: string[];
  messages: JsonRpcMessage[];
  exited: boolean;
};

const INTERNAL_DETAIL = "synthetic internal detail must never cross the boundary";

async function runChildScenario(scenario: Scenario): Promise<CapturedChild> {
  const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "--child"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let buffered = "";
  const lines: string[] = [];
  const messages: JsonRpcMessage[] = [];
  const waiting: Array<(line: string) => void> = [];
  const failures: Array<(error: Error) => void> = [];

  const deliverLine = (line: string): void => {
    if (line.length === 0) return;
    lines.push(line);
    const waiter = waiting.shift();
    if (waiter) waiter(line);
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      deliverLine(buffered.slice(0, newline).trim());
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    while (failures.length > 0) failures.shift()?.(error);
  });

  const nextLine = async (): Promise<string> => {
    if (lines.length > messages.length) return lines[messages.length] as string;
    return await new Promise<string>((resolve, reject) => {
      waiting.push(resolve);
      failures.push(reject);
      setTimeout(() => reject(new Error("MCP child response timed out")), 3000).unref();
    });
  };

  const send = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const readMessage = async (): Promise<JsonRpcMessage> => {
    const line = await nextLine();
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("MCP child emitted non-JSON stdout");
    }
    assert.equal(typeof parsed, "object");
    assert.notEqual(parsed, null);
    const message = parsed as JsonRpcMessage;
    assert.equal(message.jsonrpc, "2.0");
    messages.push(message);
    return message;
  };

  const waitForExit = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP child did not disconnect gracefully")), 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "multig-mcp-proof", version: "1.0.0" },
      },
    });
    const initialized = await readMessage();
    assert.equal(initialized.id, 1);
    assert.equal(typeof initialized.result?.serverInfo, "object");
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

    const argumentsByScenario: Record<Scenario, Record<string, unknown>> = {
      success: { value: "synthetic success" },
      "schema-error": { value: 42 },
      "internal-error": { value: "internal" },
    };
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "synthetic_echo", arguments: argumentsByScenario[scenario] },
    });
    const call = await readMessage();
    assert.equal(call.id, 2);

    child.stdin.end();
    await waitForExit();
    if (buffered.trim().length > 0) deliverLine(buffered.trim());
    assert.equal(lines.length, 2, "child emitted an unexpected number of protocol messages");
    assert.equal(stderr.includes(INTERNAL_DETAIL), false, "internal detail appeared on stderr");
    assert.equal(stdout.includes(INTERNAL_DETAIL), false, "internal detail appeared on stdout");
    return { stdout, stderr, lines, messages, exited: true };
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

async function runChildServer(): Promise<void> {
  const server = new McpServer({ name: "multig-mcp-proof", version: "1.0.0" });
  server.registerTool(
    "synthetic_echo",
    {
      description: "Returns one synthetic value for the stdio proof.",
      inputSchema: { value: z.string().min(1) },
      outputSchema: { value: z.string() },
    },
    async ({ value }) => {
      try {
        if (value === "internal") throw new Error(INTERNAL_DETAIL);
        console.error("synthetic MCP diagnostic: handled tool request");
        return {
          content: [{ type: "text", text: value }],
          structuredContent: { value },
        };
      } catch {
        console.error("synthetic MCP diagnostic: internal tool failure");
        return {
          isError: true,
          content: [{ type: "text", text: "internal_error" }],
          structuredContent: { value: "internal_error" },
        };
      }
    },
  );
  const transport = new StdioServerTransport();
  process.stdin.once("end", () => {
    void server.close();
  });
  await server.connect(transport);
}

export async function runMcpProof(): Promise<{ passed: true; scenarios: number }> {
  const success = await runChildScenario("success");
  const schemaError = await runChildScenario("schema-error");
  const internalError = await runChildScenario("internal-error");

  const successCall = success.messages[1];
  assert.equal(successCall?.error, undefined);
  assert.deepEqual(successCall?.result?.structuredContent, { value: "synthetic success" });
  assert.equal(successCall?.result?.isError, undefined);

  const schemaCall = schemaError.messages[1];
  assert.equal(schemaCall?.error?.code === -32602 || schemaCall?.result?.isError === true, true);

  const internalCall = internalError.messages[1];
  assert.equal(internalCall?.error, undefined);
  assert.equal(internalCall?.result?.isError, true);
  assert.deepEqual(internalCall?.result?.structuredContent, { value: "internal_error" });
  assert.equal(JSON.stringify(internalCall).includes(INTERNAL_DETAIL), false);

  for (const capture of [success, schemaError, internalError]) {
    for (const line of capture.lines) {
      const message = JSON.parse(line) as JsonRpcMessage;
      assert.equal(message.jsonrpc, "2.0");
      assert.equal(line.includes("console.log"), false);
    }
    assert.equal(capture.stderr.includes("jsonrpc"), false);
  }
  assert.equal(success.stderr.includes("synthetic MCP diagnostic"), true);
  assert.equal(internalError.stderr.includes("synthetic MCP diagnostic"), true);
  return { passed: true, scenarios: 3 };
}

if (process.argv[2] === "--child") {
  await runChildServer();
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runMcpProof();
    console.log(JSON.stringify({ proof: "mcp", ...result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP proof failed";
    console.error(JSON.stringify({ proof: "mcp", passed: false, error: message }));
    process.exitCode = 1;
  }
}
