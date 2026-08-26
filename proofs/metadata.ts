import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

export type MetadataConfig = {
  version: 1;
  accounts: Record<string, { email: string; scopes: string[]; keychainService: string; keychainAccount: string }>;
};

export type AtomicWriteOptions = {
  beforeRename?: () => void | Promise<void>;
};

const LOCK_SUFFIX = ".lock";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(value: unknown): MetadataConfig {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.accounts)) {
    throw new Error("invalid_local_configuration");
  }
  for (const [alias, account] of Object.entries(value.accounts)) {
    if (!isRecord(account) || typeof account.email !== "string" || !Array.isArray(account.scopes) || !account.scopes.every((scope) => typeof scope === "string")) {
      throw new Error(`invalid_local_configuration:${alias}`);
    }
    if (typeof account.keychainService !== "string" || typeof account.keychainAccount !== "string") {
      throw new Error(`invalid_local_configuration:${alias}`);
    }
  }
  return value as unknown as MetadataConfig;
}

async function acquireLock(lockPath: string): Promise<FileHandle> {
  try {
    return await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error("metadata_write_locked");
  }
}

export async function readConfig(path: string): Promise<MetadataConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("invalid_local_configuration");
  }
  try {
    return validateConfig(JSON.parse(text) as unknown);
  } catch {
    throw new Error("invalid_local_configuration");
  }
}

export async function writeConfigAtomic(path: string, config: MetadataConfig, options: AtomicWriteOptions = {}): Promise<void> {
  validateConfig(config);
  const parent = join(path, "..");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const lockPath = `${path}${LOCK_SUFFIX}`;
  const lock = await acquireLock(lockPath);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let temporaryHandle: FileHandle | undefined;
  try {
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(`${JSON.stringify(config)}\n`, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await options.beforeRename?.();
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof Error && error.message === "synthetic interruption") throw error;
    throw new Error("metadata_write_failed");
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function cleanupStaleTemps(path: string): Promise<number> {
  const directory = join(path, "..");
  const prefix = `${basename(path)}.`;
  let removed = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".tmp")) {
      await unlink(join(directory, entry.name));
      removed += 1;
    }
  }
  return removed;
}

function account(alias: string): MetadataConfig["accounts"][string] {
  return {
    email: `${alias}@example.test`,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    keychainService: `multig-mcp-proof-${alias}`,
    keychainAccount: alias,
  };
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

async function waitForLock(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  throw new Error("metadata lock was not acquired");
}

function assertNoSensitiveFields(config: MetadataConfig, serialized: string): void {
  const forbidden = /token|secret|authorization.?code|message.?body|payload/iu;
  assert.equal(forbidden.test(serialized), false, "metadata contains a sensitive field");
  assert.equal(Object.values(config.accounts).some((entry) => Object.values(entry).some((value) => typeof value === "string" && forbidden.test(value))), false);
}

export async function runMetadataProof(): Promise<{ passed: true; cases: number }> {
  const directory = await mkdtemp(join(tmpdir(), "multig-mcp-proof-"));
  const path = join(directory, "config.json");
  const initial: MetadataConfig = { version: 1, accounts: { alpha: account("alpha") } };
  const replacement: MetadataConfig = { version: 1, accounts: { beta: account("beta") } };
  try {
    await writeConfigAtomic(path, initial);
    assert.deepEqual(await readConfig(path), initial);
    assert.equal(await mode(directory), 0o700);
    assert.equal(await mode(path), 0o600);
    assertNoSensitiveFields(initial, await readFile(path, "utf8"));

    await writeConfigAtomic(path, replacement);
    assert.deepEqual(await readConfig(path), replacement);

    const beforeInterrupted = await readFile(path, "utf8");
    await assert.rejects(
      writeConfigAtomic(path, initial, { beforeRename: () => { throw new Error("synthetic interruption"); } }),
      /synthetic interruption/u,
    );
    assert.equal(await readFile(path, "utf8"), beforeInterrupted, "interrupted write changed the valid file");
    assert.equal((await readdir(directory)).some((entry) => entry.endsWith(".tmp")), false, "interrupted temp file remained");

    await writeFile(path, "{malformed", { mode: 0o600 });
    await assert.rejects(readConfig(path), /invalid_local_configuration/u);
    await writeConfigAtomic(path, initial);

    let writerEntered = false;
    const firstWriter = writeConfigAtomic(path, replacement, {
      beforeRename: async () => {
        writerEntered = true;
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    });
    await waitForLock(`${path}${LOCK_SUFFIX}`);
    for (let attempt = 0; attempt < 50 && !writerEntered; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(writerEntered, true);
    await assert.rejects(writeConfigAtomic(path, initial), /metadata_write_locked/u);
    await firstWriter;
    assert.deepEqual(await readConfig(path), replacement, "concurrent writer lost the successful update");

    const stalePath = `${path}.${randomUUID()}.tmp`;
    await writeFile(stalePath, "stale synthetic temp", { mode: 0o600 });
    const removed = await cleanupStaleTemps(path);
    assert.equal(removed, 1);
    assert.deepEqual(await readConfig(path), replacement, "stale cleanup damaged the valid config");
    assertNoSensitiveFields(replacement, await readFile(path, "utf8"));
    return { passed: true, cases: 8 };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runMetadataProof();
    console.log(JSON.stringify({ proof: "metadata", ...result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "metadata proof failed";
    console.error(JSON.stringify({ proof: "metadata", passed: false, error: message }));
    process.exitCode = 1;
  }
}
