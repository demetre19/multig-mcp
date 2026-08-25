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

export interface GmailSearchInput {
  account: string;
  query: string;
  limit?: number;
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
}
