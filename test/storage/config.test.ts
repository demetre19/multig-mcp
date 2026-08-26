import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
} from "../../dist/storage/config.js";

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
