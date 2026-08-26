import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { deferred } from "./deferred.js";
import {
  KEYCHAIN_SERVICE,
  OAUTH_CLIENT_KEYCHAIN_ACCOUNT,
  keychainAccountForAlias,
  normalizeAlias,
} from "./config.js";

export { KEYCHAIN_SERVICE, OAUTH_CLIENT_KEYCHAIN_ACCOUNT, keychainAccountForAlias };

export type KeychainOperation = "create" | "replace" | "read" | "delete";

export class KeychainError extends Error {
  readonly operation: KeychainOperation;
  readonly status: number | null;
  readonly kind: "duplicate" | "not_found" | "invalid_record" | "unavailable" | "input" | "output";

  constructor(
    operation: KeychainOperation,
    kind: KeychainError["kind"],
    status: number | null,
  ) {
    super(kind === "not_found" ? "keychain_record_not_found" : kind === "duplicate" ? "keychain_record_exists" : "keychain_operation_failed");
    this.name = "KeychainError";
    this.operation = operation;
    this.status = status;
    this.kind = kind;
  }
}

type HelperCapture = {
  stdout: Buffer[];
  stderr: Buffer[];
  fd3: Buffer[];
};

export type KeychainStoreOptions = {
  helperPath?: string;
};

function defaultHelperPath(): string {
  return fileURLToPath(new URL("../../dist/native/multig-keychain", import.meta.url));
}

function collect(stream: Readable, target: Buffer[]): Promise<void> {
  const result = deferred<void>();
  stream.on("data", (chunk: Buffer | string) => {
    target.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  stream.once("end", result.resolve);
  return result.promise;
}

function classify(operation: KeychainOperation, status: number | null): KeychainError["kind"] {
  if (status === 10) return "duplicate";
  if (status === 11) return "not_found";
  if (status === 3) return "invalid_record";
  if (status === 4) return "input";
  if (status === 13) return "output";
  return "unavailable";
}

async function invoke(
  helperPath: string,
  operation: KeychainOperation,
  record: string,
  secret: Buffer | undefined,
): Promise<Buffer> {
  const child = spawn(helperPath, [operation, record], {
    shell: false,
    env: {},
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const capture: HelperCapture = { stdout: [], stderr: [], fd3: [] };
  const stdoutDone = collect(child.stdout as Readable, capture.stdout);
  const stderrDone = collect(child.stderr as Readable, capture.stderr);
  const fd3Done = collect(child.stdio[3] as Readable, capture.fd3);
  const exit = deferred<number | null>();
  child.once("error", () => exit.reject(new KeychainError(operation, "unavailable", null)));
  child.once("exit", (status) => exit.resolve(status));
  if (secret !== undefined) child.stdin.end(secret);
  else child.stdin.end();
  let status: number | null;
  try {
    status = await exit.promise;
  } catch (error) {
    await Promise.all([stdoutDone, stderrDone, fd3Done]).catch(() => undefined);
    if (error instanceof KeychainError) throw error;
    throw new KeychainError(operation, "unavailable", null);
  }
  await Promise.all([stdoutDone, stderrDone, fd3Done]);
  if (status !== 0) throw new KeychainError(operation, classify(operation, status), status);
  if (capture.stdout.length > 0 || capture.stderr.length > 0) {
    throw new KeychainError(operation, "output", status);
  }
  return Buffer.concat(capture.fd3);
}

function recordFor(record: string): string {
  if (record === OAUTH_CLIENT_KEYCHAIN_ACCOUNT) return record;
  if (record.startsWith("gmail:")) return keychainAccountForAlias(record.slice("gmail:".length));
  throw new KeychainError("read", "invalid_record", 3);
}

export class KeychainStore {
  readonly helperPath: string;

  constructor(options: KeychainStoreOptions = {}) {
    this.helperPath = options.helperPath ?? defaultHelperPath();
  }

  async createSecret(record: string, secret: Buffer | string): Promise<void> {
    const canonical = recordFor(record);
    await invoke(this.helperPath, "create", canonical, Buffer.isBuffer(secret) ? secret : Buffer.from(secret));
  }

  async replaceSecret(record: string, secret: Buffer | string): Promise<void> {
    const canonical = recordFor(record);
    await invoke(this.helperPath, "replace", canonical, Buffer.isBuffer(secret) ? secret : Buffer.from(secret));
  }

  async readSecret(record: string): Promise<Buffer> {
    const canonical = recordFor(record);
    return invoke(this.helperPath, "read", canonical, undefined);
  }

  async readSecretIfPresent(record: string): Promise<Buffer | undefined> {
    try {
      return await this.readSecret(record);
    } catch (error) {
      if (error instanceof KeychainError && error.kind === "not_found") return undefined;
      throw error;
    }
  }

  async deleteSecret(record: string, allowMissing = false): Promise<void> {
    const canonical = recordFor(record);
    try {
      await invoke(this.helperPath, "delete", canonical, undefined);
    } catch (error) {
      if (allowMissing && error instanceof KeychainError && error.kind === "not_found") return;
      throw error;
    }
  }

  async hasSecret(record: string): Promise<boolean> {
    return (await this.readSecretIfPresent(record)) !== undefined;
  }

  async createOAuthClient(secret: string): Promise<void> {
    await this.createSecret(OAUTH_CLIENT_KEYCHAIN_ACCOUNT, secret);
  }

  async replaceOAuthClient(secret: string): Promise<void> {
    await this.replaceSecret(OAUTH_CLIENT_KEYCHAIN_ACCOUNT, secret);
  }

  async readOAuthClient(): Promise<Buffer> {
    return this.readSecret(OAUTH_CLIENT_KEYCHAIN_ACCOUNT);
  }

  async createAccountRefreshToken(alias: string, secret: string): Promise<void> {
    await this.createSecret(keychainAccountForAlias(normalizeAlias(alias)), secret);
  }

  async replaceAccountRefreshToken(alias: string, secret: string): Promise<void> {
    await this.replaceSecret(keychainAccountForAlias(normalizeAlias(alias)), secret);
  }

  async readAccountRefreshToken(alias: string): Promise<Buffer | undefined> {
    return this.readSecretIfPresent(keychainAccountForAlias(normalizeAlias(alias)));
  }

  async deleteAccountRefreshToken(alias: string, allowMissing = false): Promise<void> {
    await this.deleteSecret(keychainAccountForAlias(normalizeAlias(alias)), allowMissing);
  }
}
