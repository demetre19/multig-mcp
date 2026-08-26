import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  cleanupStaleTemps,
  emptyConfig,
  LocalConfigurationError,
  mutateConfig,
  readConfig,
  writeConfigAtomic,
  type MetadataConfig,
} from "../../src/storage/config.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function account(alias: string) {
  return {
    email: `${alias}@example.test`,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    keychainService: "multig-mcp.v1",
    keychainAccount: `gmail:${alias}`,
  };
}

describe("metadata storage", () => {
  it("serializes concurrent mutations without losing accounts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-storage-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    await Promise.all(Array.from({ length: 12 }, (_, index) => mutateConfig(path, (config) => {
      const alias = `account-${index}`;
      config.accounts[alias] = account(alias);
    })));
    const config = await readConfig(path);
    assert.equal(Object.keys(config.accounts).length, 12);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it("recovers an abandoned stale owner without leaving a lock behind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-storage-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    const lockPath = `${path}.lock`;
    await mkdir(lockPath, 0o700);
    const ownerPath = join(lockPath, "owner");
    await writeFile(ownerPath, `${Number.MAX_SAFE_INTEGER}\n0\nstale-token\n`);
    const staleAt = new Date(Date.now() - 120_000);
    await utimes(ownerPath, staleAt, staleAt);
    await mutateConfig(path, (config) => {
      config.accounts.recovered = account("recovered");
    });
    assert.deepEqual(Object.keys((await readConfig(path)).accounts), ["recovered"]);
    await assert.rejects(stat(lockPath), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
  });

  it("serializes mutations from separate Node processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-storage-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    const sourceUrl = new URL("../../src/storage/config.ts", import.meta.url).href;
    const worker = `
      import { mutateConfig } from ${JSON.stringify(sourceUrl)};
      const [path, alias, hold] = process.argv.slice(1);
      await mutateConfig(path, (config) => {
        config.accounts[alias] = {
          email: alias + "@example.test",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          keychainService: "multig-mcp.v1",
          keychainAccount: "gmail:" + alias,
        };
      }, {
        beforeRename: async () => {
          if (hold === "yes") {
            process.stdout.write("ready\\n");
            for await (const chunk of process.stdin) {
              if (chunk.toString().includes("release")) break;
            }
          }
        },
      });
    `;
    const runWorker = (alias: string, hold: string) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", worker, path, alias, hold], {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const done = Promise.withResolvers<void>();
      const ready = Promise.withResolvers<void>();
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        if (chunk.toString().includes("ready")) ready.resolve();
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        ready.reject(error);
        done.reject(error);
      });
      child.once("exit", (code) => {
        if (code === 0) {
          if (hold !== "yes") ready.resolve();
          done.resolve();
        } else {
          const error = new Error(`worker ${alias} exited ${code}: ${stderr}`);
          ready.reject(error);
          done.reject(error);
        }
      });
      return { done: done.promise, ready: ready.promise, release: () => child.stdin?.end("release\\n") };
    };
    const first = runWorker("first", "yes");
    await first.ready;
    const second = runWorker("second", "no");
    first.release();
    await Promise.all([first.done, second.done]);
    assert.deepEqual(Object.keys((await readConfig(path)).accounts).sort(), ["first", "second"]);
  });

  it("keeps the previous document when rename is interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-storage-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    const original: MetadataConfig = { ...emptyConfig(), accounts: { primary: account("primary") } };
    await writeConfigAtomic(path, original);
    const replacement: MetadataConfig = { ...emptyConfig(), accounts: { replacement: account("replacement") } };
    await assert.rejects(
      writeConfigAtomic(path, replacement, { beforeRename: () => { throw new Error("interrupted"); } }),
      (error: unknown) => error instanceof Error && error.message === "metadata_write_failed",
    );
    assert.deepEqual(await readConfig(path), original);
    assert.equal(await cleanupStaleTemps(path), 0);
  });

  it("rejects malformed metadata and never accepts secret fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-storage-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ version: 1, accounts: { primary: { token: "not-allowed" } } }));
    await assert.rejects(readConfig(path), (error: unknown) => error instanceof LocalConfigurationError);
  });
});
