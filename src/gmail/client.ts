import type { gmail_v1 } from "googleapis";
import type { CreateDraftResult, DraftInput, SendInput, SendMessageResult, StructuredErrorCode } from "../contracts.js";
import { COMPOSE_SCOPE, SEND_SCOPE } from "../storage/config.js";
import { buildRawMessage, GmailComposeError, type ThreadingHeaders } from "./compose.js";
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
  send(
    params: gmail_v1.Params$Resource$Users$Messages$Send,
  ): Promise<{ data: gmail_v1.Schema$Message }>;
}

export interface GmailDraftsClient {
  create(
    params: gmail_v1.Params$Resource$Users$Drafts$Create,
  ): Promise<{ data: gmail_v1.Schema$Draft }>;
  send(
    params: gmail_v1.Params$Resource$Users$Drafts$Send,
  ): Promise<{ data: gmail_v1.Schema$Message }>;
}

export interface GmailThreadsClient {
  get(
    params: gmail_v1.Params$Resource$Users$Threads$Get,
  ): Promise<{ data: gmail_v1.Schema$Thread }>;
}

export interface GmailApiClient {
  users: {
    messages: GmailMessagesClient;
    drafts: GmailDraftsClient;
    threads: GmailThreadsClient;
  };
}
export interface GmailAliasSession {
  alias: string;
  scopes: readonly string[];
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
      return new GmailClientError("missing_scope", `The selected account does not grant the required Gmail scope. Run auth reauthorize --alias ${alias}.`, alias);
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
const draftOwners = new Map<string, string>();

function requireScopes(aliasSession: GmailAliasSession, required: readonly string[]): void {
  const granted = new Set(aliasSession.scopes ?? []);
  if (required.every((scope) => granted.has(scope))) return;
  throw new GmailClientError(
    "missing_scope",
    `The selected account does not grant the required Gmail compose and send scopes. Run auth reauthorize --alias ${aliasSession.alias}.`,
    aliasSession.alias,
  );
}

function composeInput(alias: string, input: {
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
}): { to: string[]; cc?: string[]; subject: string; body: string } {
  if (!Array.isArray(input.to) || input.to.length === 0
    || typeof input.subject !== "string" || typeof input.body !== "string") {
    throw new GmailClientError("invalid_local_configuration", "The message input is incomplete.", alias);
  }
  return {
    to: input.to,
    ...(input.cc === undefined ? {} : { cc: input.cc }),
    subject: input.subject,
    body: input.body,
  };
}

async function threadHeaders(aliasSession: GmailAliasSession, threadId: string): Promise<ThreadingHeaders> {
  const response = await requestOnce(aliasSession.alias, () => aliasSession.gmailClient.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: ["Message-ID", "References"],
  }));
  const firstMessage = response.data.messages?.[0];
  if (firstMessage === undefined) return {};
  const messageId = headerValue(firstMessage, "Message-ID");
  const references = headerValue(firstMessage, "References");
  return {
    ...(messageId === undefined ? {} : { messageId }),
    ...(references === undefined ? {} : { references }),
  };
}
function composeRaw(alias: string, input: {
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
}, threading: ThreadingHeaders | undefined): string {
  try {
    return buildRawMessage(composeInput(alias, input), threading);
  } catch (error) {
    if (error instanceof GmailClientError) throw error;
    if (error instanceof GmailComposeError) {
      throw new GmailClientError("invalid_local_configuration", "The message input is invalid.", alias);
    }
    throw error;
  }
}

function responseId(value: string | null | undefined, alias: string, kind: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new GmailClientError("network_failure", `Gmail did not return a ${kind} ID.`, alias);
}

export async function createDraft(aliasSession: GmailAliasSession, input: DraftInput): Promise<CreateDraftResult> {
  requireScopes(aliasSession, [COMPOSE_SCOPE, SEND_SCOPE]);
  const parentHeaders = input.threadId === undefined
    ? undefined
    : await threadHeaders(aliasSession, input.threadId);
  const raw = composeRaw(aliasSession.alias, input, parentHeaders);
  const response = await requestOnce(aliasSession.alias, () => aliasSession.gmailClient.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      },
    },
  }));
  const draftId = responseId(response.data.id, aliasSession.alias, "draft");
  draftOwners.set(draftId, aliasSession.alias);
  const returnedThreadId = response.data.message?.threadId;
  return {
    account: aliasSession.alias,
    draftId,
    ...(typeof returnedThreadId === "string"
      ? { threadId: returnedThreadId }
      : input.threadId === undefined ? {} : { threadId: input.threadId }),
  };
}

export async function sendMessage(aliasSession: GmailAliasSession, input: SendInput): Promise<SendMessageResult> {
  if (input.confirm !== true) {
    throw new GmailClientError("confirmation_required", "Explicit confirmation is required immediately before sending.", aliasSession.alias);
  }
  requireScopes(aliasSession, [COMPOSE_SCOPE, SEND_SCOPE]);
  const draftId = input.draftId;
  if (draftId !== undefined) {
    const owner = draftOwners.get(draftId);
    if (owner !== undefined && owner !== aliasSession.alias) {
      throw new GmailClientError("message_not_found", "The requested Gmail draft was not found in the selected account.", aliasSession.alias);
    }
    const response = await requestOnce(aliasSession.alias, () => aliasSession.gmailClient.users.drafts.send({
      userId: "me",
      requestBody: { id: draftId },
    }));
    const messageId = responseId(response.data.id, aliasSession.alias, "message");
    draftOwners.delete(draftId);
    return {
      account: aliasSession.alias,
      messageId,
      ...(typeof response.data.threadId === "string" ? { threadId: response.data.threadId } : {}),
    };
  }
  const parentHeaders = input.threadId === undefined
    ? undefined
    : await threadHeaders(aliasSession, input.threadId);
  const raw = composeRaw(aliasSession.alias, input, parentHeaders);
  const response = await requestOnce(aliasSession.alias, () => aliasSession.gmailClient.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    },
  }));
  const messageId = responseId(response.data.id, aliasSession.alias, "message");
  const returnedThreadId = response.data.threadId;
  return {
    account: aliasSession.alias,
    messageId,
    ...(typeof returnedThreadId === "string"
      ? { threadId: returnedThreadId }
      : input.threadId === undefined ? {} : { threadId: input.threadId }),
  };
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
