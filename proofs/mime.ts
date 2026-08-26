import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

type GmailBody = {
  data?: string;
  size?: number;
  attachmentId?: string;
};

export type MimePart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: GmailBody;
  parts?: MimePart[];
};

export type NormalizedAttachment = {
  partId?: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  attachmentId?: string;
};

export type NormalizedMime = {
  textBody: string;
  attachments: NormalizedAttachment[];
  omittedBodyParts: number;
};

function decodeBase64Url(data: string, maxBytes: number): string | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(data) || data.length % 4 === 1) return undefined;
  if (Math.floor((data.length * 3) / 4) > maxBytes) return undefined;
  try {
    const decoded = Buffer.from(data, "base64url");
    if (decoded.byteLength > maxBytes) return undefined;
    return decoded.toString("utf8");
  } catch {
    return undefined;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p\s*>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function isAttachment(part: MimePart): boolean {
  if (part.filename !== undefined && part.filename.length > 0) return true;
  return part.headers?.some((header) => header.name?.toLowerCase() === "content-disposition" && /attachment/iu.test(header.value ?? "")) ?? false;
}

function collect(
  part: MimePart,
  plain: string[],
  html: string[],
  attachments: NormalizedAttachment[],
  limit: number,
  omitted: { count: number },
): void {
  if (isAttachment(part)) {
    attachments.push({
      partId: part.partId,
      filename: part.filename ?? "",
      mimeType: part.mimeType ?? "application/octet-stream",
      sizeBytes: part.body?.size,
      attachmentId: part.body?.attachmentId,
    });
    return;
  }
  const mimeType = part.mimeType?.toLowerCase();
  if ((mimeType === "text/plain" || mimeType === "text/html") && part.body?.data !== undefined) {
    const decoded = decodeBase64Url(part.body.data, limit);
    if (decoded === undefined) {
      omitted.count += 1;
    } else if (mimeType === "text/plain") {
      plain.push(decoded);
    } else {
      html.push(decoded);
    }
  }
  for (const child of part.parts ?? []) collect(child, plain, html, attachments, limit, omitted);
}

export function normalizeMime(root: MimePart, maxBodyBytes = DEFAULT_MAX_BODY_BYTES): NormalizedMime {
  assert(Number.isInteger(maxBodyBytes) && maxBodyBytes > 0, "body size boundary must be positive");
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: NormalizedAttachment[] = [];
  const omitted = { count: 0 };
  collect(root, plain, html, attachments, maxBodyBytes, omitted);
  const textBody = plain.length > 0 ? plain.join("\n") : html.map(htmlToText).join("\n");
  return { textBody, attachments, omittedBodyParts: omitted.count };
}

function encoded(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export async function runMimeProof(): Promise<{ passed: true; fixtures: number }> {
  const plain = normalizeMime({ mimeType: "text/plain", body: { data: encoded("plain synthetic body") } });
  assert.deepEqual(plain, { textBody: "plain synthetic body", attachments: [], omittedBodyParts: 0 });

  const html = normalizeMime({ mimeType: "text/html", body: { data: encoded("<p>Hello <strong>synthetic</strong></p><script>throw new Error('should not run')</script>") } });
  assert.equal(html.textBody, "Hello synthetic");
  assert.equal(html.textBody.includes("throw"), false);

  const alternative = normalizeMime({
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/html", body: { data: encoded("<p>html version</p>") } },
      { mimeType: "text/plain", body: { data: encoded("plain version") } },
    ],
  });
  assert.equal(alternative.textBody, "plain version");

  const nested = normalizeMime({
    mimeType: "multipart/mixed",
    parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: encoded("nested plain") } }] }],
  });
  assert.equal(nested.textBody, "nested plain");

  const malformed = normalizeMime({ mimeType: "text/plain", body: { data: "not valid*base64url" } });
  assert.deepEqual(malformed, { textBody: "", attachments: [], omittedBodyParts: 1 });
  const missing = normalizeMime({ mimeType: "text/plain" });
  assert.deepEqual(missing, { textBody: "", attachments: [], omittedBodyParts: 0 });

  const attachmentData = "synthetic attachment bytes must not be decoded";
  const attachment = normalizeMime({
    mimeType: "multipart/mixed",
    parts: [{
      partId: "2",
      mimeType: "application/octet-stream",
      filename: "synthetic.bin",
      body: { data: encoded(attachmentData), size: attachmentData.length, attachmentId: "synthetic-attachment-id" },
    }],
  });
  assert.deepEqual(attachment.attachments, [{ partId: "2", filename: "synthetic.bin", mimeType: "application/octet-stream", sizeBytes: attachmentData.length, attachmentId: "synthetic-attachment-id" }]);
  assert.equal(attachment.textBody, "");
  assert.equal(JSON.stringify(attachment).includes(attachmentData), false);

  const boundary = normalizeMime({ mimeType: "text/plain", body: { data: encoded("12345") } }, 5);
  assert.equal(boundary.textBody, "12345");
  const overBoundary = normalizeMime({ mimeType: "text/plain", body: { data: encoded("123456") } }, 5);
  assert.deepEqual(overBoundary, { textBody: "", attachments: [], omittedBodyParts: 1 });
  assert.equal(Object.prototype.hasOwnProperty.call(plain, "payload"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(plain, "raw"), false);
  return { passed: true, fixtures: 8 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runMimeProof();
    console.log(JSON.stringify({ proof: "mime", ...result }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "MIME proof failed";
    console.error(JSON.stringify({ proof: "mime", passed: false, error: message }));
    process.exitCode = 1;
  }
}
