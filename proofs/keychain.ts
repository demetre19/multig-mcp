import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";

const SOURCE = fileURLToPath(new URL("../native/keychain-helper.c", import.meta.url));
const HELPER_NAME = "multig-keychain";

type HelperResult = {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  fd3: Buffer;
  argv: string[];
  processListing: Buffer;
};

type OutputCapture = {
  chunks: Buffer[];
  ended: Promise<void>;
};

function capture(stream: Readable): OutputCapture {
  const end = Promise.withResolvers<void>();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  stream.once("end", end.resolve);
  return { chunks, ended: end.promise };
}

function bytes(captureResult: OutputCapture): Buffer {
  return Buffer.concat(captureResult.chunks);
}

function containsSecret(haystack: Buffer, secret: Buffer): boolean {
  return haystack.includes(secret);
}

function compileHelper(outputPath: string): void {
  const result = spawnSync("xcrun", [
    "--sdk",
    "macosx",
    "clang",
    "-std=c17",
    "-Os",
    "-Wall",
    "-Wextra",
    "-Werror",
    SOURCE,
    "-framework",
    "Security",
    "-framework",
    "CoreFoundation",
    "-o",
    outputPath,
  ], { shell: false, encoding: "buffer" });
  assert.equal(result.status, 0, "native Keychain helper compilation failed");
}

function inspectProcess(child: ChildProcess): Buffer {
  assert.notEqual(child.pid, undefined, "native helper did not receive a process id");
  const result = spawnSync("/bin/ps", ["eww", "-p", String(child.pid), "-o", "command="], {
    shell: false,
    encoding: "buffer",
  });
  assert.equal(result.status, 0, "native helper process inspection failed");
  return Buffer.from(result.stdout ?? Buffer.alloc(0));
}

async function invoke(
  binary: string,
  operation: string,
  record: string,
  input: Buffer | undefined,
): Promise<HelperResult> {
  const emptyEnvironment: NodeJS.ProcessEnv = {};
  const child = spawn(binary, [operation, record], {
    shell: false,
    env: emptyEnvironment,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const stdout = capture(child.stdout as Readable);
  const stderr = capture(child.stderr as Readable);
  const fd3 = capture(child.stdio[3] as Readable);
  const exit = Promise.withResolvers<number | null>();
  child.once("error", exit.reject);
  child.once("exit", (code) => exit.resolve(code));

  let processListing = Buffer.alloc(0);
  if (input !== undefined) {
    child.stdin.write(input);
    assert.equal(child.exitCode, null, "native helper exited before stdin inspection");
    processListing = inspectProcess(child);
    const argv = child.spawnargs ?? [];
    const argvBytes = Buffer.from(argv.join("\u0000"), "utf8");
    assert.equal(containsSecret(argvBytes, input), false, "secret appeared in native helper argv");
    assert.equal(containsSecret(processListing, input), false, "secret appeared in native helper argv/environment inspection");
    assert.equal(Object.keys(emptyEnvironment).length, 0, "native helper environment was not empty");
    child.stdin.end();
  } else {
    child.stdin.end();
  }

  const status = await exit.promise;
  await Promise.all([stdout.ended, stderr.ended, fd3.ended]);
  const result: HelperResult = {
    status,
    stdout: bytes(stdout),
    stderr: bytes(stderr),
    fd3: bytes(fd3),
    argv: [...(child.spawnargs ?? [])],
    processListing,
  };
  if (input !== undefined) {
    assert.equal(containsSecret(result.stdout, input), false, "secret appeared on native helper stdout");
    assert.equal(containsSecret(result.stderr, input), false, "secret appeared on native helper stderr");
  }
  if (operation !== "read") {
    assert.equal(result.fd3.length, 0, "native helper wrote unexpected read data");
  }
  return result;
}

function expectResult(result: HelperResult, status: number, stderr: string): void {
  assert.equal(result.status, status, "unexpected native Keychain helper status");
  assert.equal(result.stdout.length, 0, "native Keychain helper wrote to stdout");
  assert.equal(result.stderr.toString("utf8"), stderr, "unexpected sanitized native Keychain diagnostic");
}

function expectRead(result: HelperResult, expected: Buffer): void {
  expectResult(result, 0, "");
  assert.equal(result.fd3.equals(expected), true, "fd 3 did not contain the exact binary secret");
}

async function deleteIfPresent(binary: string, record: string): Promise<void> {
  const result = await invoke(binary, "delete", record, undefined);
  assert.equal(result.status === 0 || result.status === 11, true, "Keychain cleanup failed");
}

export async function runKeychainProof(): Promise<{ passed: true; operations: number }> {
  const directory = await mkdtemp(join(tmpdir(), "multig-mcp-keychain-proof-"));
  const binary = join(directory, HELPER_NAME);
  const namespace = randomUUID();
  const primary = `gmail:${namespace}-primary`;
  const isolated = `gmail:${namespace}-isolated`;
  const firstSecret = Buffer.concat([randomBytes(3), Buffer.from([0x00, 0x0a, 0xff, 0xfe, 0x80, 0x00]), randomBytes(5)]);
  const replacementSecret = Buffer.concat([Buffer.from([0xff, 0x00, 0x0d, 0x0a]), randomBytes(9)]);
  const isolatedSecret = Buffer.concat([randomBytes(2), Buffer.from([0x00, 0x80, 0xfe]), randomBytes(7)]);
  const records = [primary, isolated];
  let operations = 0;
  try {
    compileHelper(binary);

    const created = await invoke(binary, "create", primary, firstSecret);
    expectResult(created, 0, "");
    operations += 1;

    const duplicate = await invoke(binary, "create", primary, replacementSecret);
    expectResult(duplicate, 10, "duplicate-record\n");
    operations += 1;

    const firstRead = await invoke(binary, "read", primary, undefined);
    expectRead(firstRead, firstSecret);
    operations += 1;

    const isolatedCreate = await invoke(binary, "create", isolated, isolatedSecret);
    expectResult(isolatedCreate, 0, "");
    operations += 1;
    const isolatedRead = await invoke(binary, "read", isolated, undefined);
    expectRead(isolatedRead, isolatedSecret);
    operations += 1;

    const replaced = await invoke(binary, "replace", primary, replacementSecret);
    expectResult(replaced, 0, "");
    operations += 1;
    const secondRead = await invoke(binary, "read", primary, undefined);
    expectRead(secondRead, replacementSecret);
    operations += 1;

    const deleted = await invoke(binary, "delete", primary, undefined);
    expectResult(deleted, 0, "");
    operations += 1;
    const missing = await invoke(binary, "read", primary, undefined);
    expectResult(missing, 11, "record-not-found\n");
    operations += 1;
    const isolatedStillPresent = await invoke(binary, "read", isolated, undefined);
    expectRead(isolatedStillPresent, isolatedSecret);
    operations += 1;

    const isolatedDeleted = await invoke(binary, "delete", isolated, undefined);
    expectResult(isolatedDeleted, 0, "");
    operations += 1;
    const isolatedMissing = await invoke(binary, "read", isolated, undefined);
    expectResult(isolatedMissing, 11, "record-not-found\n");
    operations += 1;

    return { passed: true, operations };
  } finally {
    for (const record of records) {
      await deleteIfPresent(binary, record).catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runKeychainProof();
    console.log(JSON.stringify({ proof: "keychain", ...result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Keychain proof failed";
    console.error(JSON.stringify({ proof: "keychain", passed: false, error: message }));
    process.exitCode = 1;
  }
}
