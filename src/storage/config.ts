import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";

export const CONFIG_VERSION = 1 as const;
export const KEYCHAIN_SERVICE = "multig-mcp.v1";
export const OAUTH_CLIENT_KEYCHAIN_ACCOUNT = "oauth-client";
export const READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

export type AccountMetadata = {
  email: string;
  scopes: string[];
  keychainService: string;
  keychainAccount: string;
};

export type MetadataConfig = {
  version: typeof CONFIG_VERSION;
  accounts: Record<string, AccountMetadata>;
};

export type AtomicWriteOptions = {
  beforeRename?: () => void | Promise<void>;
};

const LOCK_SUFFIX = ".lock";
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 30_000;

export class LocalConfigurationError extends Error {
  readonly code = "invalid_local_configuration" as const;

  constructor(message = "invalid_local_configuration") {
    super(message);
    this.name = "LocalConfigurationError";
  }
}

export class MetadataWriteError extends Error {
  readonly code = "invalid_local_configuration" as const;

  constructor(message = "metadata_write_failed") {
    super(message);
    this.name = "MetadataWriteError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeAlias(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(normalized)) {
    throw new LocalConfigurationError("invalid_account_alias");
  }
  return normalized;
}

export function keychainAccountForAlias(alias: string): string {
  return `gmail:${normalizeAlias(alias)}`;
}

function validateAccount(alias: string, value: unknown): AccountMetadata {
  if (!isRecord(value)) throw new LocalConfigurationError("invalid_local_configuration");
  if (normalizeAlias(alias) !== alias) throw new LocalConfigurationError("invalid_local_configuration");
  if (typeof value.email !== "string" || value.email.trim().length === 0) {
    throw new LocalConfigurationError("invalid_local_configuration");
  }
  if (!Array.isArray(value.scopes) || value.scopes.some((scope) => typeof scope !== "string" || scope.length === 0)) {
    throw new LocalConfigurationError("invalid_local_configuration");
  }
  if (typeof value.keychainService !== "string" || value.keychainService !== KEYCHAIN_SERVICE) {
    throw new LocalConfigurationError("invalid_local_configuration");
  }
  if (typeof value.keychainAccount !== "string" || value.keychainAccount !== keychainAccountForAlias(alias)) {
    throw new LocalConfigurationError("invalid_local_configuration");
  }
  return {
    email: value.email,
    scopes: [...value.scopes],
    keychainService: value.keychainService,
    keychainAccount: value.keychainAccount,
  };
}

export function validateConfig(value: unknown): MetadataConfig {
  if (!isRecord(value) || value.version !== CONFIG_VERSION || !isRecord(value.accounts)) {
    throw new LocalConfigurationError();
  }
  const accounts: Record<string, AccountMetadata> = {};
  for (const [alias, account] of Object.entries(value.accounts)) {
    accounts[alias] = validateAccount(alias, account);
  }
  return { version: CONFIG_VERSION, accounts };
}

export function emptyConfig(): MetadataConfig {
  return { version: CONFIG_VERSION, accounts: {} };
}

export function getConfigPath(): string {
  const override = process.env.MULTIG_CONFIG_HOME?.trim();
  if (override !== undefined && override.length > 0) return join(override, "config.json");
  return join(homedir(), "Library", "Application Support", "multig-mcp", "config.json");
}

async function ensureParent(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

const LOCK_OWNER = "owner";

type LockHandle = {
  close: () => Promise<void>;
};

async function breakStaleLock(lockPath: string): Promise<boolean> {
  const ownerPath = join(lockPath, LOCK_OWNER);
  let details;
  try {
    details = await stat(ownerPath);
  } catch (error) {
    if (!isMissing(error)) return false;
    try {
      details = await stat(lockPath);
    } catch (lockError) {
      return isMissing(lockError);
    }
    if (Date.now() - details.mtimeMs < LOCK_STALE_MS) return false;
    try {
      await rmdir(lockPath);
      return true;
    } catch (removeError) {
      return isMissing(removeError);
    }
  }
  if (Date.now() - details.mtimeMs < LOCK_STALE_MS) return false;
  let contents: string;
  try {
    contents = await readFile(ownerPath, "utf8");
  } catch (error) {
    return isMissing(error);
  }
  const pid = Number.parseInt(contents.split("\n", 1)[0] ?? "", 10);
  if (processIsAlive(pid)) return false;
  try {
    await unlink(ownerPath);
  } catch (error) {
    if (!isMissing(error)) return false;
  }
  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    return isMissing(error);
  }
}

async function acquireLock(lockPath: string): Promise<LockHandle> {
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath, 0o700);
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw new MetadataWriteError();
      if (await breakStaleLock(lockPath)) continue;
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        throw new MetadataWriteError("metadata_write_locked");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }

    const ownerPath = join(lockPath, LOCK_OWNER);
    let ownerHandle: FileHandle | undefined;
    let ownerCreated = false;
    try {
      ownerHandle = await open(ownerPath, "wx", 0o600);
      ownerCreated = true;
      await ownerHandle.writeFile(`${process.pid}\n${Date.now()}\n${randomUUID()}\n`, "utf8");
      await ownerHandle.sync();
      const ownerIdentity = await ownerHandle.stat();
      let released = false;
      return {
        close: async () => {
          if (released) return;
          released = true;
          await ownerHandle?.close().catch(() => undefined);
          let currentIdentity;
          try {
            currentIdentity = await stat(ownerPath);
          } catch {
            return;
          }
          if (currentIdentity.dev !== ownerIdentity.dev || currentIdentity.ino !== ownerIdentity.ino) return;
          await unlink(ownerPath).catch(() => undefined);
          await rmdir(lockPath).catch(() => undefined);
        },
      };
    } catch (error) {
      await ownerHandle?.close().catch(() => undefined);
      if (ownerCreated) await unlink(ownerPath).catch(() => undefined);
      await rmdir(lockPath).catch(() => undefined);
      if (error instanceof MetadataWriteError) throw error;
      throw new MetadataWriteError();
    }
  }
}

async function readConfigIfPresent(path: string): Promise<MetadataConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return emptyConfig();
    throw new LocalConfigurationError();
  }
  try {
    return validateConfig(JSON.parse(text) as unknown);
  } catch {
    throw new LocalConfigurationError();
  }
}

export async function readConfig(path = getConfigPath()): Promise<MetadataConfig> {
  return readConfigIfPresent(path);
}

async function writeLocked(path: string, config: MetadataConfig, options: AtomicWriteOptions): Promise<void> {
  validateConfig(config);
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
    if (error instanceof LocalConfigurationError || error instanceof MetadataWriteError) throw error;
    throw new MetadataWriteError();
  }
}

export async function writeConfigAtomic(
  path: string,
  config: MetadataConfig,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await ensureParent(path);
  const lockPath = `${path}${LOCK_SUFFIX}`;
  const lock = await acquireLock(lockPath);
  try {
    await writeLocked(path, config, options);
  } finally {
    await lock.close().catch(() => undefined);
  }
}

export async function mutateConfig(
  path: string,
  mutator: (config: MetadataConfig) => MetadataConfig | void | Promise<MetadataConfig | void>,
  options: AtomicWriteOptions = {},
): Promise<MetadataConfig> {
  await ensureParent(path);
  const lockPath = `${path}${LOCK_SUFFIX}`;
  const lock = await acquireLock(lockPath);
  try {
    const current = await readConfigIfPresent(path);
    const changed = await mutator(current);
    const next = changed === undefined ? current : changed;
    const validated = validateConfig(next);
    await writeLocked(path, validated, options);
    return validated;
  } finally {
    await lock.close().catch(() => undefined);
  }
}

export async function cleanupStaleTemps(path = getConfigPath()): Promise<number> {
  const directory = dirname(path);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw new LocalConfigurationError();
  }
  const prefix = `${basename(path)}.`;
  let removed = 0;
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".tmp")) {
      await unlink(join(directory, entry.name));
      removed += 1;
    }
  }
  return removed;
}
