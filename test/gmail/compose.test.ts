import assert from "node:assert/strict";
import test from "node:test";
import { buildRawMessage, buildRfc5322Message } from "../../dist/gmail/compose.js";

function decode(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}
function headerLines(message: string, name: string): string[] {
  const lines = message.split("\r\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  assert.notEqual(start, -1);
  const end = lines.findIndex((line, index) => index > start && !/^[ \t]/u.test(line));
  return lines.slice(start, end === -1 ? lines.length : end);
}

function encodedWords(lines: string[]): string[] {
  return lines.join(" ").match(/=\?UTF-8\?B\?[^?]+\?=/gu) ?? [];
}


test("splits long multibyte subjects into bounded encoded words at UTF-8 boundaries", () => {
  const subject = "🚀漢字".repeat(10);
  const lines = headerLines(buildRfc5322Message({
    to: ["recipient@example.test"],
    subject,
    body: "body",
  }), "Subject");
  const words = encodedWords(lines);

  assert.ok(words.length > 1);
  assert.ok(words.every((word) => word.length <= 75));
  assert.ok(lines.slice(1).every((line) => /^[ \t]/u.test(line)));
  assert.equal(encodedWords(lines).map((word) => Buffer.from(word.slice("=?UTF-8?B?".length, -2), "base64").toString("utf8")).join(""), subject);
});

test("splits long multibyte display names into bounded encoded words at UTF-8 boundaries", () => {
  const displayName = "é🙂界".repeat(15);
  const lines = headerLines(buildRfc5322Message({
    to: [`${displayName} <recipient@example.test>`],
    subject: "subject",
    body: "body",
  }), "To");
  const words = encodedWords(lines);

  assert.ok(words.length > 1);
  assert.ok(words.every((word) => word.length <= 75));
  assert.ok(lines.slice(1).every((line) => /^[ \t]/u.test(line)));
  assert.equal(encodedWords(lines).map((word) => Buffer.from(word.slice("=?UTF-8?B?".length, -2), "base64").toString("utf8")).join(""), displayName);
});

test("buildRawMessage deterministically encodes recipients, UTF-8 subject, and plain text body", () => {
  const raw = buildRawMessage({
    to: ["Alice Example <alice@example.test>", "bob@example.test"],
    cc: ["Jörg Example <jorg@example.test>"],
    subject: "Résumé update",
    body: "first line\nsecond line",
  });

  assert.equal(decode(raw), [
    "To: Alice Example <alice@example.test>, bob@example.test",
    "Cc: =?UTF-8?B?SsO2cmcgRXhhbXBsZQ==?= <jorg@example.test>",
    "Subject: =?UTF-8?B?UsOpc3Vtw6kgdXBkYXRl?=",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    "first line\r\nsecond line",
  ].join("\r\n"));
  assert.match(raw, /^[A-Za-z0-9_-]+$/u);
});

test("threading headers append the first message ID to prior references", () => {
  const message = buildRfc5322Message(
    { to: ["recipient@example.test"], subject: "Re: topic", body: "reply" },
    { messageId: "<first@example.test>", references: "<root@example.test>" },
  );
  assert.match(message, /In-Reply-To: <first@example\.test>\r\n/u);
  assert.match(message, /References: <root@example\.test> <first@example\.test>\r\n/u);
});

test("header injection is rejected rather than copied into the RFC message", () => {
  assert.throws(() => buildRawMessage({
    to: ["recipient@example.test\r\nBcc: leaked@example.test"],
    subject: "subject",
    body: "body",
  }));
});
