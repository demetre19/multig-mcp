import { Auth, google } from "googleapis";
import { z } from "zod";
type OAuth2Client = Auth.OAuth2Client;
import type { AccountStatus, AccountSummary, StructuredErrorCode } from "../contracts.js";
import {
  getConfigPath,
  keychainAccountForAlias,
  KEYCHAIN_SERVICE,
  LocalConfigurationError,
  normalizeAlias,
  OAUTH_CLIENT_KEYCHAIN_ACCOUNT,
  READONLY_SCOPE,
  readConfig,
} from "../storage/config.js";
import { KeychainError, KeychainStore } from "../storage/keychain.js";

const StoredClient = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });

export type AccountManagerOptions = {
  configPath?: string;
  keychain?: KeychainStore;
  helperPath?: string;
};

export type AccountSession = OAuth2Client;

export type AccountManagerDependencies = {
  clientFactory?: (clientId: string, clientSecret: string) => OAuth2Client;
};

export class AccountSessionError extends Error {
  readonly code: StructuredErrorCode;
  readonly account?: string;

  constructor(code: StructuredErrorCode, account?: string) {
    super(code);
    this.name = "AccountSessionError";
    this.code = code;
    if (account !== undefined) this.account = account;
  }
}

type CachedSession = {
  client: OAuth2Client;
  refreshToken: string;
  accessToken?: string;
  expiryDate?: number;
};

const EXPIRY_SAFETY_WINDOW_MS = 60_000;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry));
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/(?:access|refresh)?_?(?:token|secret|credential|password)|authorization|client.?secret|code_verifier|code_challenge/iu.test(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = redactSensitive(entry);
      }
    }
    return output;
  }
  return value;
}

function responseStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const response = (error as { response?: unknown }).response;
  if (response === null || typeof response !== "object") return undefined;
  const status = (response as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function mapGoogleError(error: unknown, account?: string): AccountSessionError {
  const status = responseStatus(error);
  const code = errorCode(error);
  if (code === "invalid_grant" || status === 401) return new AccountSessionError("reauthorization_required", account);
  if (status === 403) return new AccountSessionError("missing_scope", account);
  if (status === 429) return new AccountSessionError("gmail_rate_limited", account);
  if (status !== undefined && status >= 500) return new AccountSessionError("gmail_temporarily_unavailable", account);
  if (code === "ENOTFOUND" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN") {
    return new AccountSessionError("network_failure", account);
  }
  return new AccountSessionError("network_failure", account);
}

function isUsableMetadata(account: { scopes: string[]; keychainService: string; keychainAccount: string }, alias: string): boolean {
  return account.keychainService === KEYCHAIN_SERVICE
    && account.keychainAccount === keychainAccountForAlias(alias)
    && account.scopes.length === 1
    && account.scopes[0] === READONLY_SCOPE;
}

function tokenFromBuffer(buffer: Buffer | undefined, alias: string): string {
  if (buffer === undefined) throw new AccountSessionError("reauthorization_required", alias);
  const token = buffer.toString("utf8");
  if (token.trim().length === 0) throw new AccountSessionError("reauthorization_required", alias);
  return token;
}

export class AccountManager {
  readonly configPath: string;
  readonly keychain: KeychainStore;
  readonly clientFactory: (clientId: string, clientSecret: string) => OAuth2Client;
  #sessions = new Map<string, CachedSession>();

  constructor(options: AccountManagerOptions = {}, dependencies: AccountManagerDependencies = {}) {
    this.configPath = options.configPath ?? getConfigPath();
    this.keychain = options.keychain ?? new KeychainStore(options.helperPath === undefined ? {} : { helperPath: options.helperPath });
    this.clientFactory = dependencies.clientFactory ?? ((clientId, clientSecret) => new google.auth.OAuth2(clientId, clientSecret));
  }

  async listAccounts(): Promise<AccountSummary[]> {
    let config;
    try {
      config = await readConfig(this.configPath);
    } catch {
      throw new AccountSessionError("invalid_local_configuration");
    }
    let clientConfigured = true;
    try {
      const storedClient = await this.keychain.readSecret(OAUTH_CLIENT_KEYCHAIN_ACCOUNT);
      clientConfigured = StoredClient.safeParse(JSON.parse(storedClient.toString("utf8")) as unknown).success;
    } catch (error) {
      if (error instanceof KeychainError && error.kind === "not_found") clientConfigured = false;
      else clientConfigured = false;
    }
    const summaries: AccountSummary[] = [];
    for (const alias of Object.keys(config.accounts).sort()) {
      const metadata = config.accounts[alias];
      if (metadata === undefined) continue;
      let status: AccountStatus = "connected";
      if (!clientConfigured || !isUsableMetadata(metadata, alias)) {
        status = "invalid_configuration";
      } else {
        try {
          const token = await this.keychain.readAccountRefreshToken(alias);
          if (token === undefined || token.toString("utf8").trim().length === 0) status = "reauthorization_required";
        } catch {
          status = "invalid_configuration";
        }
      }
      summaries.push({ alias, email: metadata.email, scopes: [...metadata.scopes], status });
    }
    return summaries;
  }

  async getAccountSession(aliasInput: string): Promise<AccountSession> {
    let alias: string;
    try {
      alias = normalizeAlias(aliasInput);
    } catch {
      throw new AccountSessionError("unknown_account");
    }
    let config;
    try {
      config = await readConfig(this.configPath);
    } catch {
      throw new AccountSessionError("invalid_local_configuration");
    }
    const metadata = config.accounts[alias];
    if (metadata === undefined) throw new AccountSessionError("unknown_account", alias);
    if (!isUsableMetadata(metadata, alias)) throw new AccountSessionError("missing_scope", alias);

    const existing = this.#sessions.get(alias);
    if (existing !== undefined) {
      try {
        await this.ensureAccessToken(alias, existing);
        return existing.client;
      } catch (error) {
        if (error instanceof AccountSessionError) throw error;
        throw mapGoogleError(error, alias);
      }
    }

    let clientBytes: Buffer;
    try {
      clientBytes = await this.keychain.readOAuthClient();
    } catch (error) {
      if (error instanceof KeychainError && error.kind === "not_found") {
        throw new AccountSessionError("oauth_client_not_configured", alias);
      }
      throw new AccountSessionError("invalid_local_configuration", alias);
    }
    let clientCredentials: { clientId: string; clientSecret: string };
    try {
      const parsed = StoredClient.parse(JSON.parse(clientBytes.toString("utf8")) as unknown);
      clientCredentials = { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    } catch {
      throw new AccountSessionError("invalid_local_configuration", alias);
    }
    let storedToken: Buffer | undefined;
    try {
      storedToken = await this.keychain.readAccountRefreshToken(alias);
    } catch {
      throw new AccountSessionError("invalid_local_configuration", alias);
    }
    const refreshToken = tokenFromBuffer(storedToken, alias);
    const client = this.clientFactory(clientCredentials.clientId, clientCredentials.clientSecret);
    client.setCredentials({ refresh_token: refreshToken });
    const cached: CachedSession = { client, refreshToken };
    this.#sessions.set(alias, cached);
    client.on("tokens", (tokens) => {
      const newRefreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token.trim().length > 0
        ? tokens.refresh_token
        : undefined;
      if (newRefreshToken !== undefined && newRefreshToken !== cached.refreshToken) {
        cached.refreshToken = newRefreshToken;
        void this.keychain.replaceAccountRefreshToken(alias, newRefreshToken).catch(() => undefined);
      }
      if (typeof tokens.access_token === "string" && tokens.access_token.length > 0) cached.accessToken = tokens.access_token;
      if (typeof tokens.expiry_date === "number") cached.expiryDate = tokens.expiry_date;
    });
    try {
      await this.ensureAccessToken(alias, cached);
      return client;
    } catch (error) {
      this.#sessions.delete(alias);
      if (error instanceof AccountSessionError) throw error;
      throw mapGoogleError(error, alias);
    }
  }

  private async ensureAccessToken(alias: string, cached: CachedSession): Promise<void> {
    const now = Date.now();
    if (cached.accessToken !== undefined && cached.expiryDate !== undefined && cached.expiryDate - now > EXPIRY_SAFETY_WINDOW_MS) {
      cached.client.setCredentials({
        access_token: cached.accessToken,
        expiry_date: cached.expiryDate,
        refresh_token: cached.refreshToken,
      });
      return;
    }
    try {
      const result = await cached.client.getAccessToken();
      const token = result.token;
      if (typeof token !== "string" || token.length === 0) throw new AccountSessionError("reauthorization_required", alias);
      cached.accessToken = token;
      cached.expiryDate = cached.client.credentials.expiry_date ?? now + 5 * 60_000;
      cached.client.setCredentials({
        access_token: cached.accessToken,
        expiry_date: cached.expiryDate,
        refresh_token: cached.refreshToken,
      });
    } catch (error) {
      if (error instanceof AccountSessionError) throw error;
      throw mapGoogleError(error, alias);
    }
  }
}

let defaultManager: AccountManager | undefined;

function getDefaultManager(): AccountManager {
  if (defaultManager === undefined) defaultManager = new AccountManager();
  return defaultManager;
}

export async function listAccounts(options?: AccountManagerOptions): Promise<AccountSummary[]> {
  if (options !== undefined) return new AccountManager(options).listAccounts();
  return getDefaultManager().listAccounts();
}

export async function getAccountSession(alias: string, options?: AccountManagerOptions): Promise<AccountSession> {
  if (options !== undefined) return new AccountManager(options).getAccountSession(alias);
  return getDefaultManager().getAccountSession(alias);
}

export function structuredError(error: unknown, account?: string): { code: StructuredErrorCode; message: string; account?: string } {
  const mapped = error instanceof AccountSessionError ? error : mapGoogleError(error, account);
  const result: { code: StructuredErrorCode; message: string; account?: string } = {
    code: mapped.code,
    message: mapped.code,
  };
  if (mapped.account !== undefined) result.account = mapped.account;
  return result;
}

export { KEYCHAIN_SERVICE, READONLY_SCOPE, OAUTH_CLIENT_KEYCHAIN_ACCOUNT, LocalConfigurationError };
