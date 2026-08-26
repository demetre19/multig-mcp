import type { gmail_v1 } from "googleapis";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** Text after the bounded body content when one or more text parts are omitted. */
export const TRUNCATION_MARKER = "[message body truncated at 65536 bytes]";

export type GmailMessagePart = gmail_v1.Schema$MessagePart;

export interface NormalizedAttachmentMetadata {
  partId: string;
  filename: string;
  mimeType: string;
  size?: number;
  attachmentId?: string;
}

export interface NormalizedMime {
  textBody: string;
  attachments: NormalizedAttachmentMetadata[];
  omittedBodyParts: number;
}

export interface NormalizedMessageData extends NormalizedMime {
  id: string;
  threadId: string;
  sender: string;
  recipients: string[];
  subject: string;
  timestamp: string;
  labels: string[];
}

type TextCandidate = {
  text: string;
  truncated: boolean;
};

type MimeState = {
  plain: TextCandidate;
  html: TextCandidate;
  attachments: NormalizedAttachmentMetadata[];
  omittedBodyParts: number;
};


function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Decode only validated Gmail base64url text, never arbitrary attachment data. */
export function decodeBase64UrlText(data: unknown, maxBytes: number): string | undefined {
  if (typeof data !== "string" || !/^[A-Za-z0-9_-]*$/u.test(data) || data.length % 4 === 1) {
    return undefined;
  }
  if (Math.floor((data.length * 3) / 4) > maxBytes) {
    return undefined;
  }

  try {
    const decoded = Buffer.from(data, "base64url");
    if (decoded.byteLength > maxBytes) {
      return undefined;
    }
    return decoded.toString("utf8");
  } catch {
    return undefined;
  }
}

function decodeBase64UrlPrefix(data: unknown, maxBytes: number): string | undefined {
  if (typeof data !== "string" || !/^[A-Za-z0-9_-]*$/u.test(data) || data.length % 4 === 1) {
    return undefined;
  }
  const encodedBytes = Math.min(data.length, Math.ceil(maxBytes / 3) * 4);
  try {
    return Buffer.from(data.slice(0, encodedBytes), "base64url").subarray(0, maxBytes).toString("utf8");
  } catch {
    return undefined;
  }
}

function decodeHtmlEntity(entity: string): string {
  const normalized = entity.toLowerCase();
  if (normalized === "&nbsp;") return " ";
  if (normalized === "&amp;") return "&";
  if (normalized === "&lt;") return "<";
  if (normalized === "&gt;") return ">";
  if (normalized === "&quot;") return '"';
  if (normalized === "&apos;") return "'";

  const numeric = normalized.match(/^&#(?:x([\da-f]+)|([\d]+));$/u);
  if (numeric) {
    const codePoint = Number.parseInt(numeric[1] ?? numeric[2] ?? "", numeric[1] ? 16 : 10);
    if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return entity;
      }
    }
  }
  return entity;
}

/**
 * Convert HTML to plain text without parsing or executing it as a document.
 * Scripts, styles, tags, links, and event attributes are treated as data and removed.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, "")
    .replace(/<(?:br|hr)\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article)\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&(?:#x[\da-f]+|#[\d]+|[a-z]+);/giu, decodeHtmlEntity)
    .replace(/[ \t]+/gu, " ")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function headerValue(part: GmailMessagePart | undefined, name: string): string | undefined {
  const header = part?.headers?.find((candidate) => candidate.name?.toLowerCase() === name.toLowerCase());
  return isNonEmptyString(header?.value) ? header.value : undefined;
}

function hasAttachmentDisposition(part: GmailMessagePart): boolean {
  return part.headers?.some((header) => {
    return header.name?.toLowerCase() === "content-disposition" && /(?:^|[;\s])attachment(?:[;\s]|$)/iu.test(header.value ?? "");
  }) ?? false;
}

function isAttachmentPart(part: GmailMessagePart): boolean {
  return isNonEmptyString(part.filename) || hasAttachmentDisposition(part);
}

function attachmentMetadata(part: GmailMessagePart): NormalizedAttachmentMetadata {
  const metadata: NormalizedAttachmentMetadata = {
    partId: part.partId ?? "",
    filename: part.filename ?? "",
    mimeType: part.mimeType ?? "application/octet-stream",
  };
  if (typeof part.body?.size === "number" && Number.isFinite(part.body.size) && part.body.size >= 0) {
    metadata.size = part.body.size;
  }
  if (isNonEmptyString(part.body?.attachmentId)) {
    metadata.attachmentId = part.body.attachmentId;
  }
  return metadata;
}

function appendBounded(candidate: TextCandidate, text: string, maxBodyBytes: number): void {
  const separator = candidate.text.length > 0 ? "\n" : "";
  const available = maxBodyBytes - Buffer.byteLength(candidate.text, "utf8") - Buffer.byteLength(separator, "utf8");
  if (available <= 0) {
    candidate.truncated = true;
    return;
  }

  const textBytes = Buffer.byteLength(text, "utf8");
  if (textBytes <= available) {
    candidate.text += separator + text;
    return;
  }

  const prefix = Buffer.from(text, "utf8").subarray(0, available).toString("utf8");
  candidate.text += separator + prefix;
  candidate.truncated = true;
}

function walkPart(part: GmailMessagePart, state: MimeState, maxBodyBytes: number): void {
  const body = part.body;
  const externalized = isNonEmptyString(body?.attachmentId);

  if (isAttachmentPart(part) || (externalized && (part.parts?.length ?? 0) === 0)) {
    state.attachments.push(attachmentMetadata(part));
    return;
  }

  const mimeType = part.mimeType?.toLowerCase();
  if ((mimeType === "text/plain" || mimeType === "text/html") && body?.data !== undefined) {
    const decoded = decodeBase64UrlText(body.data, maxBodyBytes);
    const bounded = decoded ?? decodeBase64UrlPrefix(body.data, maxBodyBytes);
    if (bounded === undefined) {
      state.omittedBodyParts += 1;
    } else if (mimeType === "text/plain") {
      appendBounded(state.plain, bounded, maxBodyBytes);
      if (decoded === undefined) state.plain.truncated = true;
    } else {
      appendBounded(state.html, bounded, maxBodyBytes);
      if (decoded === undefined) state.html.truncated = true;
    }
  }

  for (const child of part.parts ?? []) {
    if (child !== null && typeof child === "object") {
      walkPart(child, state, maxBodyBytes);
    }
  }
}

function assertBodyBoundary(maxBodyBytes: number): void {
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new RangeError("body size boundary must be a positive integer");
  }
}

export function normalizeMime(root: GmailMessagePart | null | undefined, maxBodyBytes = DEFAULT_MAX_BODY_BYTES): NormalizedMime {
  assertBodyBoundary(maxBodyBytes);
  const state: MimeState = {
    plain: { text: "", truncated: false },
    html: { text: "", truncated: false },
    attachments: [],
    omittedBodyParts: 0,
  };

  if (root !== null && root !== undefined && typeof root === "object") {
    walkPart(root, state, maxBodyBytes);
  } else {
    state.omittedBodyParts = 1;
  }

  const usingPlain = state.plain.text.length > 0 || state.plain.truncated;
  const selected = usingPlain ? state.plain : state.html;
  const selectedText = usingPlain ? selected.text : htmlToText(selected.text);
  const selectedTruncated = selected.truncated || Buffer.byteLength(selectedText, "utf8") > maxBodyBytes;
  const boundedText = selectedTruncated && Buffer.byteLength(selectedText, "utf8") > maxBodyBytes
    ? Buffer.from(selectedText, "utf8").subarray(0, maxBodyBytes).toString("utf8")
    : selectedText;
  const textBody = boundedText.length > 0
    ? boundedText + (selectedTruncated || state.omittedBodyParts > 0 ? `\n${TRUNCATION_MARKER}` : "")
    : state.omittedBodyParts > 0 || selectedTruncated
      ? TRUNCATION_MARKER
      : "";

  return {
    textBody,
    attachments: state.attachments,
    omittedBodyParts: state.omittedBodyParts,
  };
}

function splitRecipients(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value.split(",").map((recipient) => recipient.trim()).filter((recipient) => recipient.length > 0);
}

function normalizeTimestamp(internalDate: string | null | undefined, dateHeader: string | undefined): string {
  if (internalDate !== null && internalDate !== undefined && /^\d+$/u.test(internalDate)) {
    const milliseconds = Number(internalDate);
    if (Number.isSafeInteger(milliseconds) && milliseconds >= 0) {
      return new Date(milliseconds).toISOString();
    }
  }
  return dateHeader ?? "";
}

export function normalizeMessage(message: gmail_v1.Schema$Message, maxBodyBytes = DEFAULT_MAX_BODY_BYTES): NormalizedMessageData {
  const payload = message.payload;
  const from = headerValue(payload, "From") ?? "";
  const recipients = [
    ...splitRecipients(headerValue(payload, "To")),
    ...splitRecipients(headerValue(payload, "Cc")),
  ];
  const mime = normalizeMime(payload ?? {}, maxBodyBytes);

  return {
    id: message.id ?? "",
    threadId: message.threadId ?? "",
    sender: from,
    recipients,
    subject: headerValue(payload, "Subject") ?? "",
    timestamp: normalizeTimestamp(message.internalDate, headerValue(payload, "Date")),
    textBody: mime.textBody,
    labels: message.labelIds?.filter((label): label is string => typeof label === "string") ?? [],
    attachments: mime.attachments,
    omittedBodyParts: mime.omittedBodyParts,
  };
}

export const normalizeGmailMessage = normalizeMessage;
