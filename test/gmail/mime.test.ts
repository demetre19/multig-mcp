import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_BODY_BYTES,
  TRUNCATION_MARKER,
  normalizeMessage,
  normalizeMime,
} from "../../dist/gmail/mime.js";

function encoded(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

test("normalizes a plain message and top-level metadata", () => {
  const message = normalizeMessage({
    id: "message-1",
    threadId: "thread-1",
    internalDate: "1700000000000",
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Sender <sender@example.test>" },
        { name: "To", value: "One <one@example.test>, two@example.test" },
        { name: "Cc", value: "copy@example.test" },
        { name: "Subject", value: "Synthetic subject" },
        { name: "Date", value: "unused fallback date" },
      ],
      body: { data: encoded("Hello, mailbox") },
    },
  });

  assert.equal(message.id, "message-1");
  assert.equal(message.threadId, "thread-1");
  assert.equal(message.sender, "Sender <sender@example.test>");
  assert.deepEqual(message.recipients, ["One <one@example.test>", "two@example.test", "copy@example.test"]);
  assert.equal(message.subject, "Synthetic subject");
  assert.equal(message.timestamp, "2023-11-14T22:13:20.000Z");
  assert.equal(message.textBody, "Hello, mailbox");
  assert.deepEqual(message.labels, ["INBOX", "UNREAD"]);
});

test("prefers nested plain text over HTML and records attachments without their bodies", () => {
  const normalized = normalizeMime({
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: encoded("<p>HTML should lose</p>") } },
          { mimeType: "text/plain", body: { data: encoded("Plain wins") } },
        ],
      },
      {
        partId: "attachment-1",
        filename: "report.pdf",
        mimeType: "application/pdf",
        body: { size: 1234, attachmentId: "external-1", data: encoded("must not be returned") },
      },
    ],
  });

  assert.equal(normalized.textBody, "Plain wins");
  assert.deepEqual(normalized.attachments, [{
    partId: "attachment-1",
    filename: "report.pdf",
    mimeType: "application/pdf",
    size: 1234,
    attachmentId: "external-1",
  }]);
});

test("safely converts HTML-only content and decodes base64url text", () => {
  const normalized = normalizeMime({
    mimeType: "text/html",
    body: { data: encoded("<p>Hello &amp; welcome<br><script>alert('ignore')</script>world</p>") },
  });
  assert.equal(normalized.textBody, "Hello & welcome\nworld");
});

test("malformed and externalized text is omitted and marked without attachment fetches", () => {
  const normalized = normalizeMime({
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: "not base64!" } },
      { mimeType: "text/plain", body: { attachmentId: "body-1", size: 99 } },
    ],
  });
  assert.equal(normalized.textBody, TRUNCATION_MARKER);
  assert.equal(normalized.omittedBodyParts, 1);
  assert.deepEqual(normalized.attachments, [{
    partId: "",
    filename: "",
    mimeType: "text/plain",
    size: 99,
    attachmentId: "body-1",
  }]);
});

test("enforces the explicit body boundary with a deterministic marker", () => {
  const normalized = normalizeMime({
    mimeType: "text/plain",
    body: { data: encoded("1234567890") },
  }, 8);
  assert.equal(DEFAULT_MAX_BODY_BYTES, 64 * 1024);
  assert.equal(normalized.textBody, `12345678\n${TRUNCATION_MARKER}`);
});
