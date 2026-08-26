import assert from "node:assert/strict";
import { existsSync, watch } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

function waitForPath(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), (_event, filename) => {
    if (filename?.toString() !== basename(path) || !existsSync(path)) return;
    watcher.close();
    resolve();
  });
  watcher.once("error", (error) => {
    watcher.close();
    reject(error);
  });
  if (existsSync(path)) {
    watcher.close();
    resolve();
  }
  return promise;
}

function waitForAnyPath(paths: string[]): Promise<string> {
  const found = paths.find((path) => existsSync(path));
  if (found !== undefined) return Promise.resolve(found);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const watcher = watch(join(paths[0]!, ".."), () => {
    const current = paths.find((path) => existsSync(path));
    if (current === undefined) return;
    watcher.close();
    resolve(current);
  });
  watcher.once("error", (error) => {
    watcher.close();
    reject(error);
  });
  const current = paths.find((path) => existsSync(path));
  if (current !== undefined) {
    watcher.close();
    resolve(current);
  }
  return promise;
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

  it("serializes deterministic stale-recovery races without destroying the replacement owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multig-mcp-storage-"));
    directories.push(directory);
    const path = join(directory, "config.json");
    const lockPath = `${path}.lock`;
    const barrier = join(directory, "barrier");
    await mkdir(lockPath, 0o700);
    await mkdir(barrier, 0o700);
    const ownerPath = join(lockPath, "owner");
    await writeFile(ownerPath, `${Number.MAX_SAFE_INTEGER}\n0\nstale-token\n`);
    const staleAt = new Date(Date.now() - 120_000);
    await utimes(ownerPath, staleAt, staleAt);

    const sourceUrl = new URL("../../src/storage/config.ts", import.meta.url).href;
    const worker = `
      import { existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { mutateConfig } from ${JSON.stringify(sourceUrl)};
      const [path, alias, role, barrier] = process.argv.slice(1);
      const originalNow = Date.now;
      if (role === "loser") Date.now = () => originalNow() + 60_000;
      const originalKill = process.kill.bind(process);
      const waitForRelease = (name) => {
        writeFileSync(join(barrier, name), "");
        const signal = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(join(barrier, name + "-release"))) Atomics.wait(signal, 0, 0, 5);
      };
      process.kill = (pid, signal) => {
        if (signal === 0 && pid === Number.MAX_SAFE_INTEGER) {
          waitForRelease("inspected-" + role);
          const error = Object.assign(new Error("no such process"), { code: "ESRCH" });
          throw error;
        }
        if (signal === 0 && role === "loser") writeFileSync(join(barrier, "loser-saw-live"), "");
        return originalKill(pid, signal);
      };
      await mutateConfig(path, (config) => {
        config.accounts[alias] = {
          email: alias + "@example.test",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          keychainService: "multig-mcp.v1",
          keychainAccount: "gmail:" + alias,
        };
      }, {
        beforeRename: async () => {
          if (role === "winner") {
            writeFileSync(join(barrier, "winner-acquired"), "");
            waitForRelease("winner");
          } else {
            writeFileSync(join(barrier, "loser-entered"), "");
          }
        },
      });
    `;
    const runWorker = (alias: string, role: string) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", worker, path, alias, role, barrier], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const done = Promise.withResolvers<void>();
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => done.reject(error));
      child.once("exit", (code) => {
        if (code === 0) done.resolve();
        else done.reject(new Error(`worker ${role} exited ${code}: ${stderr}`));
      });
      return done.promise;
    };

    const winnerDone = runWorker("winner", "winner");
    const loserDone = runWorker("loser", "loser");
    await Promise.all([
      waitForPath(join(barrier, "inspected-winner")),
      waitForPath(join(barrier, "inspected-loser")),
    ]);
    await writeFile(join(barrier, "inspected-winner-release"), "");
    await waitForPath(join(barrier, "winner-acquired"));
    await writeFile(join(barrier, "inspected-loser-release"), "");
    const loserState = await waitForAnyPath([
      join(barrier, "loser-saw-live"),
      join(barrier, "loser-entered"),
    ]);
    assert.equal(loserState, join(barrier, "loser-saw-live"));
    assert.equal(existsSync(join(barrier, "loser-entered")), false);
    await writeFile(join(barrier, "winner-release"), "");
    await Promise.all([winnerDone, loserDone]);
    assert.deepEqual(Object.keys((await readConfig(path)).accounts).sort(), ["loser", "winner"]);
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
