import type { gmail_v1 } from "googleapis";
import type { StructuredErrorCode } from "../contracts.js";
import { normalizeMessage, type NormalizedMessageData } from "./mime.js";

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;

const QUOTA_ERROR_REASONS = new Set([
  "dailylimitexceeded",
  "userratelimitexceeded",
  "ratelimitexceeded",
  "quotaexceeded",
]);
const MISSING_SCOPE_ERROR_REASONS = new Set([
  "insufficientpermissions",
  "insufficientscope",
  "insufficientscopes",
]);

export interface GmailMessagesClient {
  list(
    params: gmail_v1.Params$Resource$Users$Messages$List,
  ): Promise<{ data: gmail_v1.Schema$ListMessagesResponse }>;
  get(
    params: gmail_v1.Params$Resource$Users$Messages$Get,
  ): Promise<{ data: gmail_v1.Schema$Message }>;
}

export interface GmailApiClient {
  users: {
    messages: GmailMessagesClient;
  };
}

export interface GmailAliasSession {
  alias: string;
  gmailClient: GmailApiClient;
}

export interface GmailSearchOptions {
  query: string;
  limit?: number;
}

export interface GmailSearchMessage {
  id: string;
  threadId: string;
  snippet?: string;
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  date?: string;
}

export interface GmailSearchResponse {
  account: string;
  messages: GmailSearchMessage[];
}

export interface GmailMessage extends Omit<NormalizedMessageData, "omittedBodyParts"> {
  account: string;
}

export class GmailClientError extends Error {
  readonly code: StructuredErrorCode;
  readonly account: string;

  constructor(code: StructuredErrorCode, message: string, account: string) {
    super(message);
    this.name = "GmailClientError";
    this.code = code;
    this.account = account;
  }
}

function objectValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return Reflect.get(value, key);
}

function statusCode(error: unknown): number | undefined {
  const direct = objectValue(error, "code") ?? objectValue(error, "status");
  if (typeof direct === "number") return direct;
  if (typeof direct === "string" && /^\d+$/u.test(direct)) return Number(direct);

  const response = objectValue(error, "response");
  const responseStatus = objectValue(response, "status");
  if (typeof responseStatus === "number") return responseStatus;
  if (typeof responseStatus === "string" && /^\d+$/u.test(responseStatus)) return Number(responseStatus);
  return undefined;
}

function errorHints(error: unknown): string {
  const values: string[] = [];
  const directMessage = objectValue(error, "message");
  if (typeof directMessage === "string") values.push(directMessage);
  const response = objectValue(error, "response");
  const responseData = objectValue(response, "data");
  const responseError = objectValue(responseData, "error");
  for (const candidate of [responseData, responseError]) {
    const message = objectValue(candidate, "message");
    const reason = objectValue(candidate, "reason");
    if (typeof message === "string") values.push(message);
    if (typeof reason === "string") values.push(reason);
  }
  return values.join(" ").toLowerCase();
}

function errorReasons(error: unknown): string[] {
  const response = objectValue(error, "response");
  const responseData = objectValue(response, "data");
  const responseError = objectValue(responseData, "error");
  const reasons: string[] = [];

  for (const candidate of [responseData, responseError]) {
    const reason = objectValue(candidate, "reason");
    if (typeof reason === "string") reasons.push(reason.toLowerCase());
    const nestedErrors = objectValue(candidate, "errors");
    if (Array.isArray(nestedErrors)) {
      for (const nestedError of nestedErrors) {
        const nestedReason = objectValue(nestedError, "reason");
        if (typeof nestedReason === "string") reasons.push(nestedReason.toLowerCase());
      }
    }
  }
  return reasons;
}


function isInvalidQueryFailure(error: unknown): boolean {
  const hints = errorHints(error);
  return /(?:invalid[ _-]?query|malformed[ _-]?query|bad[ _-]?query|query syntax)/iu.test(hints);
}

function mapGmailError(error: unknown, alias: string): GmailClientError {
  if (error instanceof GmailClientError) return error;
  const status = statusCode(error);

  if (status === 404) {
    return new GmailClientError("message_not_found", "The requested Gmail message was not found.", alias);
  }
  if (status === 403) {
    const reasons = errorReasons(error);
    if (reasons.some((reason) => QUOTA_ERROR_REASONS.has(reason))) {
      return new GmailClientError("gmail_rate_limited", "Gmail temporarily rejected the request because of quota or rate limits.", alias);
    }
    if (reasons.some((reason) => MISSING_SCOPE_ERROR_REASONS.has(reason))) {
      return new GmailClientError("missing_scope", "The selected account does not grant the required Gmail read-only scope.", alias);
    }
    return new GmailClientError("invalid_local_configuration", "The local account configuration is invalid.", alias);
  }
  if (status === 429) {
    return new GmailClientError("gmail_rate_limited", "Gmail temporarily rejected the request because of quota or rate limits.", alias);
  }
  if (status === 401) {
    return new GmailClientError("reauthorization_required", "The selected Gmail account requires reauthorization.", alias);
  }
  if (status === 400 && isInvalidQueryFailure(error)) {
    return new GmailClientError("invalid_gmail_query", "Gmail rejected the search query; check its Gmail search syntax.", alias);
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return new GmailClientError("gmail_temporarily_unavailable", "Gmail is temporarily unavailable; try again shortly.", alias);
  }
  return new GmailClientError("network_failure", "The Gmail request could not be completed.", alias);
}

/**
 * googleapis-common 8.0.3 enables retries by default for googleapis 176.0.0.
 * Keep this adapter single-attempt so it does not multiply dependency retries.
 */
async function requestOnce<T>(alias: string, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw mapGmailError(error, alias);
  }
}


function validatedLimit(limit: number | undefined, alias: string): number {
  const selected = limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(selected) || selected < 1 || selected > MAX_SEARCH_LIMIT) {
    throw new GmailClientError("invalid_gmail_query", "Search limit must be an integer from 1 to 50.", alias);
  }
  return selected;
}

function headerValue(message: gmail_v1.Schema$Message, name: string): string | undefined {
  const value = message.payload?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactSearchMessage(message: gmail_v1.Schema$Message): GmailSearchMessage {
  const compact: GmailSearchMessage = {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
  };
  if (typeof message.snippet === "string") compact.snippet = message.snippet;
  const from = headerValue(message, "From");
  const to = headerValue(message, "To");
  const cc = headerValue(message, "Cc");
  const subject = headerValue(message, "Subject");
  const date = headerValue(message, "Date");
  if (from !== undefined) compact.from = from;
  if (to !== undefined) compact.to = to;
  if (cc !== undefined) compact.cc = cc;
  if (subject !== undefined) compact.subject = subject;
  if (date !== undefined) compact.date = date;
  return compact;
}

export async function search(aliasSession: GmailAliasSession, options: GmailSearchOptions): Promise<GmailSearchResponse> {
  const { query } = options;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new GmailClientError("invalid_gmail_query", "Gmail search query must be a non-empty string.", aliasSession.alias);
  }
  const limit = validatedLimit(options.limit, aliasSession.alias);
  const listed = await requestOnce(aliasSession.alias, () => aliasSession.gmailClient.users.messages.list({
    userId: "me",
    q: query,
    maxResults: limit,
  }));

  const selectedMessages = (listed.data.messages ?? [])
    .filter((message) => typeof message.id === "string" && message.id.length > 0)
    .slice(0, limit);
  const messages = await Promise.all(selectedMessages.map(async (listedMessage) => {
    const fetched = await requestOnce(aliasSession.alias, () => aliasSession.gmailClient.users.messages.get({
      userId: "me",
      id: listedMessage.id ?? "",
      format: "metadata",
      metadataHeaders: ["From", "To", "Cc", "Subject", "Date"],
    }));
    return compactSearchMessage(fetched.data);
  }));

  return { account: aliasSession.alias, messages };
}

export async function getMessage(aliasSession: GmailAliasSession, options: { messageId: string }): Promise<GmailMessage> {
  if (typeof options.messageId !== "string" || options.messageId.trim().length === 0) {
    throw new GmailClientError("message_not_found", "Gmail message ID must be a non-empty string.", aliasSession.alias);
  }
  const response = await requestOnce(aliasSession.alias, () => aliasSession.gmailClient.users.messages.get({
    userId: "me",
    id: options.messageId,
    format: "full",
  }));
  const normalized = normalizeMessage(response.data);
  const { omittedBodyParts: _omittedBodyParts, ...message } = normalized;
  return { account: aliasSession.alias, ...message };
}
