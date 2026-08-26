import type { AccountSummary, StructuredErrorCode } from "../contracts.js";
import type { GmailAliasSession } from "../gmail/client.js";

export type AccountSession = GmailAliasSession;

export interface AccountProvider {
  listAccounts(): Promise<AccountSummary[]>;
  openSession(alias: string): Promise<AccountSession>;
}

export class AccountProviderError extends Error {
  readonly code: StructuredErrorCode;
  readonly account?: string;

  constructor(code: StructuredErrorCode, message: string, account?: string) {
    super(message);
    this.name = "AccountProviderError";
    this.code = code;
    if (account !== undefined) this.account = account;
  }
}
