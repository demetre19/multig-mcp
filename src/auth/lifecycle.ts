import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { google } from "googleapis";
import { z } from "zod";
import { invalidateAccountSession, listAccounts, type AccountManagerOptions } from "../accounts/index.js";
import type { AccountSummary } from "../contracts.js";
import {
  getConfigPath,
  keychainAccountForAlias,
  KEYCHAIN_SERVICE,
  mutateConfig,
  normalizeAlias,
  OAUTH_CLIENT_KEYCHAIN_ACCOUNT,
  READONLY_SCOPE,
  readConfig,
} from "../storage/config.js";
import { KeychainError, KeychainStore } from "../storage/keychain.js";
import {
  OAuthFlowError,
  runOAuthFlow,
  type OAuthClientCredentials,
  type OAuthFlowResult,
} from "./oauth.js";

const CredentialShape = z.object({
  client_id: z.string().trim().min(1),
  client_secret: z.string().min(1),
  redirect_uris: z.array(z.string().trim().min(1)).min(1),
});
const DesktopCredentialFile = z.object({
  installed: CredentialShape.optional(),
  web: CredentialShape.optional(),
}).refine((value) => value.installed !== undefined || value.web !== undefined);
const StoredClient = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) });

export type AuthLifecycleOptions = {
  configPath?: string;
  keychain?: KeychainStore;
  helperPath?: string;
  oauthFlow?: (credentials: OAuthClientCredentials, alias: string) => Promise<OAuthFlowResult>;
  isPreviousRefreshTokenUsable?: (credentials: OAuthClientCredentials, refreshToken: string) => Promise<boolean>;
};

export class AuthLifecycleError extends Error {
  readonly code: string;
  readonly alias?: string;

  constructor(code: string, alias?: string) {
    super(code);
    this.name = "AuthLifecycleError";
    this.code = code;
    if (alias !== undefined) this.alias = alias;
  }
}

export type ImportedOAuthClient = OAuthClientCredentials;

export function parseDesktopCredentials(value: unknown): ImportedOAuthClient {
  try {
    const parsed = DesktopCredentialFile.parse(value);
    const shape = parsed.installed ?? parsed.web;
    if (shape === undefined) throw new AuthLifecycleError("invalid_oauth_credentials");
    return { clientId: shape.client_id, clientSecret: shape.client_secret };
  } catch {
    throw new AuthLifecycleError("invalid_oauth_credentials");
  }
}

function lifecycleContext(options: AuthLifecycleOptions): { configPath: string; keychain: KeychainStore } {
  return {
    configPath: options.configPath ?? getConfigPath(),
    keychain: options.keychain ?? new KeychainStore(options.helperPath === undefined ? {} : { helperPath: options.helperPath }),
  };
}

async function readClientCredentials(keychain: KeychainStore): Promise<OAuthClientCredentials> {
  let value: Buffer;
  try {
    value = await keychain.readSecret(OAUTH_CLIENT_KEYCHAIN_ACCOUNT);
  } catch (error) {
    if (error instanceof KeychainError && error.kind === "not_found") throw new AuthLifecycleError("oauth_client_not_configured");
    throw new AuthLifecycleError("invalid_local_configuration");
  }
  try {
    const parsed = StoredClient.parse(JSON.parse(value.toString("utf8")) as unknown);
    return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
  } catch {
    throw new AuthLifecycleError("invalid_local_configuration");
  }
}

function accountMetadata(alias: string, email: string): {
  email: string;
  scopes: [typeof READONLY_SCOPE];
  keychainService: typeof KEYCHAIN_SERVICE;
  keychainAccount: string;
} {
  return {
    email,
    scopes: [READONLY_SCOPE],
    keychainService: KEYCHAIN_SERVICE,
    keychainAccount: keychainAccountForAlias(alias),
  };
}

function nonEmptyRefreshToken(result: OAuthFlowResult): string | undefined {
  if (result.refreshToken === undefined || result.refreshToken.trim().length === 0) return undefined;
  return result.refreshToken;
}

function equalEmail(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left.trim().toLowerCase(), "utf8");
  const rightBytes = Buffer.from(right.trim().toLowerCase(), "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function executeOAuth(
  credentials: OAuthClientCredentials,
  alias: string,
  options: AuthLifecycleOptions,
): Promise<OAuthFlowResult> {
  if (options.oauthFlow !== undefined) return options.oauthFlow(credentials, alias);
  try {
    return await runOAuthFlow(credentials);
  } catch (error) {
    if (error instanceof OAuthFlowError) throw error;
    throw new AuthLifecycleError("oauth_failed", alias);
  }
}

export async function configureOAuthClient(
  credentialsPath: string,
  options: AuthLifecycleOptions & { replace?: boolean } = {},
): Promise<void> {
  let credentials: OAuthClientCredentials;
  try {
    credentials = parseDesktopCredentials(JSON.parse(await readFile(credentialsPath, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof AuthLifecycleError) throw error;
    throw new AuthLifecycleError("invalid_oauth_credentials");
  }
  const { keychain } = lifecycleContext(options);
  try {
    await keychain.readOAuthClient();
    if (options.replace !== true) throw new AuthLifecycleError("oauth_client_already_configured");
    await keychain.replaceOAuthClient(JSON.stringify(credentials));
  } catch (error) {
    if (error instanceof AuthLifecycleError) throw error;
    if (error instanceof KeychainError && error.kind === "not_found") {
      await keychain.createOAuthClient(JSON.stringify(credentials));
      return;
    }
    throw new AuthLifecycleError("invalid_local_configuration");
  }
}

export async function addAccount(aliasInput: string, options: AuthLifecycleOptions = {}): Promise<OAuthFlowResult> {
  let alias: string;
  try {
    alias = normalizeAlias(aliasInput);
  } catch {
    throw new AuthLifecycleError("invalid_account_alias");
  }
  const { configPath, keychain } = lifecycleContext(options);
  const config = await readConfig(configPath);
  if (config.accounts[alias] !== undefined) throw new AuthLifecycleError("account_alias_exists", alias);
  const credentials = await readClientCredentials(keychain);
  const result = await executeOAuth(credentials, alias, options);
  const refreshToken = nonEmptyRefreshToken(result);
  if (refreshToken === undefined) throw new AuthLifecycleError("refresh_token_required", alias);
  let created = false;
  try {
    await keychain.createAccountRefreshToken(alias, refreshToken);
    created = true;
    await mutateConfig(configPath, (current) => {
      if (current.accounts[alias] !== undefined) throw new AuthLifecycleError("account_alias_exists", alias);
      current.accounts[alias] = accountMetadata(alias, result.email);
    });
  } catch (error) {
    if (created) await keychain.deleteAccountRefreshToken(alias, true).catch(() => undefined);
    throw error;
  }
  invalidateAccountSession(configPath, alias);
  return result;
}

async function defaultRefreshUsabilityCheck(credentials: OAuthClientCredentials, refreshToken: string): Promise<boolean> {
  const client = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  try {
    const result = await client.getAccessToken();
    return typeof result.token === "string" && result.token.length > 0;
  } catch {
    return false;
  }
}

export async function reauthorizeAccount(aliasInput: string, options: AuthLifecycleOptions = {}): Promise<OAuthFlowResult> {
  let alias: string;
  try {
    alias = normalizeAlias(aliasInput);
  } catch {
    throw new AuthLifecycleError("invalid_account_alias");
  }
  const { configPath, keychain } = lifecycleContext(options);
  const config = await readConfig(configPath);
  const prior = config.accounts[alias];
  if (prior === undefined) throw new AuthLifecycleError("unknown_account", alias);
  const credentials = await readClientCredentials(keychain);
  const priorToken = await keychain.readAccountRefreshToken(alias);
  const priorRefreshToken = priorToken === undefined ? undefined : priorToken.toString("utf8");
  const result = await executeOAuth(credentials, alias, options);
  if (!equalEmail(prior.email, result.email)) throw new AuthLifecycleError("account_identity_mismatch", alias);
  const replacement = nonEmptyRefreshToken(result);
  let nextToken = replacement;
  if (nextToken === undefined && priorRefreshToken !== undefined && priorRefreshToken.trim().length > 0) {
    const check = options.isPreviousRefreshTokenUsable ?? defaultRefreshUsabilityCheck;
    if (await check(credentials, priorRefreshToken)) nextToken = priorRefreshToken;
  }

  if (replacement !== undefined) {
    try {
      await keychain.replaceAccountRefreshToken(alias, replacement);
    } catch (error) {
      if (error instanceof KeychainError && error.kind === "not_found") await keychain.createAccountRefreshToken(alias, replacement);
      else throw error;
    }
  } else if (nextToken === undefined) {
    await keychain.deleteAccountRefreshToken(alias, true);
  }
  await mutateConfig(configPath, (current) => {
    if (current.accounts[alias] === undefined) throw new AuthLifecycleError("unknown_account", alias);
    current.accounts[alias] = accountMetadata(alias, result.email);
  });
  invalidateAccountSession(configPath, alias);
  return result;
}

export async function removeAccount(aliasInput: string, options: AuthLifecycleOptions = {}): Promise<void> {
  let alias: string;
  try {
    alias = normalizeAlias(aliasInput);
  } catch {
    throw new AuthLifecycleError("invalid_account_alias");
  }
  const { configPath, keychain } = lifecycleContext(options);
  const config = await readConfig(configPath);
  if (config.accounts[alias] === undefined) throw new AuthLifecycleError("unknown_account", alias);
  await keychain.deleteAccountRefreshToken(alias, true);
  await mutateConfig(configPath, (current) => {
    delete current.accounts[alias];
  });
  invalidateAccountSession(configPath, alias);
}

export async function listAuthAccounts(options: AuthLifecycleOptions = {}): Promise<AccountSummary[]> {
  const { configPath, keychain } = lifecycleContext(options);
  const accountOptions: AccountManagerOptions = { configPath, keychain };
  return listAccounts(accountOptions);
}
