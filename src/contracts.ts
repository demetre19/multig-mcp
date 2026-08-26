export type AccountStatus =
  | "connected"
  | "reauthorization_required"
  | "invalid_configuration";

export interface AccountSummary {
  alias: string;
  email: string;
  scopes: string[];
  status: AccountStatus;
}
export const GMAIL_ACCOUNTS_TOOL = "gmail_accounts" as const;
export const GMAIL_SEARCH_TOOL = "gmail_search" as const;
export const GMAIL_GET_MESSAGE_TOOL = "gmail_get_message" as const;
export const GMAIL_CREATE_DRAFT_TOOL = "gmail_create_draft" as const;
export const GMAIL_SEND_MESSAGE_TOOL = "gmail_send_message" as const;
export const GMAIL_TOOL_NAMES = [
  GMAIL_ACCOUNTS_TOOL,
  GMAIL_SEARCH_TOOL,
  GMAIL_GET_MESSAGE_TOOL,
  GMAIL_CREATE_DRAFT_TOOL,
  GMAIL_SEND_MESSAGE_TOOL,
] as const;

export interface GmailSearchInput {
  account: string;
  query: string;
  limit?: number;
}

export interface DraftInput {
  account: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  threadId?: string;
}

export interface SendInput {
  account: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  threadId?: string;
  draftId?: string;
  confirm: true;
}

export interface CreateDraftResult {
  account: string;
  draftId: string;
  threadId?: string;
}

export interface SendMessageResult {
  account: string;
  messageId: string;
  threadId?: string;
}

export interface GmailSearchResultMetadata {
  id: string;
  threadId: string;
  snippet?: string;
  subject?: string;
  from?: string;
  timestamp?: string;
}

export interface GmailSearchResult {
  account: string;
  messages: GmailSearchResultMetadata[];
  nextPageToken?: string;
}

export interface GmailGetMessageInput {
  account: string;
  messageId: string;
}

export interface GmailAttachmentMetadata {
  attachmentId?: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
}

export interface NormalizedGmailMessage {
  account: string;
  id: string;
  threadId: string;
  sender: string;
  recipients: string[];
  subject: string;
  timestamp: string;
  textBody: string;
  labels: string[];
  attachments: GmailAttachmentMetadata[];
}

export const STRUCTURED_ERROR_CODES = [
  "unknown_account",
  "oauth_client_not_configured",
  "reauthorization_required",
  "missing_scope",
  "confirmation_required",
  "invalid_gmail_query",
  "message_not_found",
  "gmail_rate_limited",
  "gmail_temporarily_unavailable",
  "network_failure",
  "invalid_local_configuration",
] as const;

export type StructuredErrorCode = (typeof STRUCTURED_ERROR_CODES)[number];

export interface StructuredError {
  code: StructuredErrorCode;
  message: string;
  account?: string;
  remediation?: string;
}

