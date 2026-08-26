import assert from "node:assert/strict";
import test from "node:test";
import { buildRawMessage, buildRfc5322Message } from "../../dist/gmail/compose.js";

function decode(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

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
