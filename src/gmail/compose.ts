import type { DraftInput } from "../contracts.js";

export type ComposeInput = Pick<DraftInput, "to" | "subject" | "body"> & Pick<Partial<DraftInput>, "cc">;

export type ThreadingHeaders = {
  messageId?: string;
  references?: string;
};

export class GmailComposeError extends Error {
  constructor(message = "The Gmail message could not be composed safely.") {
    super(message);
    this.name = "GmailComposeError";
  }
}

function assertHeaderSafe(value: string): void {
  if (/[\r\n]/u.test(value)) throw new GmailComposeError();
}

const MAX_ENCODED_WORD_BYTES = 45;

function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function encodeHeaderText(value: string): string {
  assertHeaderSafe(value);
  if (!/[^\x00-\x7F]/u.test(value)) return value;

  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (chunk.length > 0 && chunkBytes + characterBytes > MAX_ENCODED_WORD_BYTES) {
      words.push(encodedWord(chunk));
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk.length > 0) words.push(encodedWord(chunk));
  return words.join("\r\n ");
}

function encodeAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new GmailComposeError();
  assertHeaderSafe(trimmed);
  const angle = /^(.*?)(\s*<[^<>]+>)$/u.exec(trimmed);
  if (angle !== null) {
    const display = angle[1]?.trim() ?? "";
    const address = angle[2]?.trim() ?? "";
    if (display.length === 0) return address;
    return `${encodeHeaderText(display)} ${address}`;
  }
  return encodeHeaderText(trimmed);
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n|\r|\n/gu, "\r\n");
}

function threadingLines(threading: ThreadingHeaders | undefined): string[] {
  if (threading === undefined) return [];
  const lines: string[] = [];
  const messageId = threading.messageId?.trim();
  const references = threading.references?.trim();
  if (messageId !== undefined && messageId.length > 0) {
    assertHeaderSafe(messageId);
    lines.push(`In-Reply-To: ${messageId}`);
  }
  if (references !== undefined && references.length > 0) assertHeaderSafe(references);
  const allReferences = [references, messageId].filter((value): value is string => value !== undefined && value.length > 0).join(" ");
  if (allReferences.length > 0) lines.push(`References: ${allReferences}`);
  return lines;
}

export function buildRfc5322Message(input: ComposeInput, threading?: ThreadingHeaders): string {
  if (!Array.isArray(input.to) || input.to.length === 0) throw new GmailComposeError();
  if (typeof input.subject !== "string" || typeof input.body !== "string") throw new GmailComposeError();
  const lines = [
    `To: ${input.to.map(encodeAddress).join(", ")}`,
    ...(input.cc === undefined || input.cc.length === 0 ? [] : [`Cc: ${input.cc.map(encodeAddress).join(", ")}`]),
    `Subject: ${encodeHeaderText(input.subject)}`,
    ...threadingLines(threading),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizeBody(input.body),
  ];
  return lines.join("\r\n");
}

export function buildRawMessage(input: ComposeInput, threading?: ThreadingHeaders): string {
  return Buffer.from(buildRfc5322Message(input, threading), "utf8").toString("base64url");
}
