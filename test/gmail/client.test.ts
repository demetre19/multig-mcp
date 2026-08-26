import assert from "node:assert/strict";
import test from "node:test";
import {
  createDraft,
  GmailClientError,
  getMessage,
  search,
  sendMessage,
  type GmailApiClient,
} from "../../dist/gmail/client.js";

function encoded(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function session(
  list: (params: Record<string, unknown>) => Promise<unknown>,
  get: (params: Record<string, unknown>) => Promise<unknown>,
) {
  return {
    alias: "personal",
    gmailClient: {
      users: {
        messages: { list, get },
      },
    } as unknown as GmailApiClient,
  };
}

test("search consumes one bounded list page and fetches compact metadata per selected ID", async () => {
  const listParams: Record<string, unknown>[] = [];
  const getParams: Record<string, unknown>[] = [];
  const gmail = session(
    async (params) => {
      listParams.push(params);
      return {
        data: {
          messages: [
            { id: "one", threadId: "thread-one" },
            { id: "two", threadId: "thread-two" },
            { id: "three", threadId: "thread-three" },
          ],
          nextPageToken: "must-not-be-consumed",
        },
      };
    },
    async (params) => {
      getParams.push(params);
      const id = params.id;
      return {
        data: {
          id,
          threadId: `thread-${id}`,
          snippet: `snippet-${id}`,
          payload: {
            headers: [
              { name: "From", value: "sender@example.test" },
              { name: "To", value: "recipient@example.test" },
              { name: "Cc", value: "copy@example.test" },
              { name: "Subject", value: `subject-${id}` },
              { name: "Date", value: "Tue, 01 Jan 2030 00:00:00 +0000" },
            ],
          },
        },
      };
    },
  );

  const result = await search(gmail, { query: "from:example.test", limit: 2 });
  assert.deepEqual(listParams, [{ userId: "me", q: "from:example.test", maxResults: 2 }]);
  assert.deepEqual(getParams, [
    { userId: "me", id: "one", format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] },
    { userId: "me", id: "two", format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject", "Date"] },
  ]);
  assert.deepEqual(result, {
    account: "personal",
    messages: [
      {
        id: "one",
        threadId: "thread-one",
        snippet: "snippet-one",
        from: "sender@example.test",
        to: "recipient@example.test",
        cc: "copy@example.test",
        subject: "subject-one",
        date: "Tue, 01 Jan 2030 00:00:00 +0000",
      },
      {
        id: "two",
        threadId: "thread-two",
        snippet: "snippet-two",
        from: "sender@example.test",
        to: "recipient@example.test",
        cc: "copy@example.test",
        subject: "subject-two",
        date: "Tue, 01 Jan 2030 00:00:00 +0000",
      },
    ],
  });
});

test("search validates the query and limit bounds before contacting Gmail", async () => {
  let calls = 0;
  const gmail = session(
    async () => {
      calls += 1;
      return { data: {} };
    },
    async () => ({ data: {} }),
  );

  for (const options of [
    { query: "", limit: 10 },
    { query: "in:anywhere", limit: 0 },
    { query: "in:anywhere", limit: 51 },
    { query: "in:anywhere", limit: 1.5 },
  ]) {
    await assert.rejects(search(gmail, options), (error: unknown) => {
      return error instanceof GmailClientError && error.code === "invalid_gmail_query";
    });
  }
  assert.equal(calls, 0);
});

test("getMessage requests full format and returns normalized content without raw payloads", async () => {
  const params: Record<string, unknown>[] = [];
  const gmail = session(
    async () => ({ data: {} }),
    async (request) => {
      params.push(request);
      return {
        data: {
          id: "message-1",
          threadId: "thread-1",
          internalDate: "1700000000000",
          labelIds: ["INBOX"],
          payload: {
            mimeType: "text/plain",
            headers: [{ name: "From", value: "sender@example.test" }],
            body: { data: encoded("safe body") },
          },
          raw: "must not cross boundary",
        },
      };
    },
  );

  const message = await getMessage(gmail, { messageId: "message-1" });
  assert.deepEqual(params, [{ userId: "me", id: "message-1", format: "full" }]);
  assert.equal(message.account, "personal");
  assert.equal(message.textBody, "safe body");
  assert.equal("raw" in message, false);
});

test("maps quota, permission, invalid query, not found, transient, and network failures without exposing remote details or adding retries over googleapis-common defaults", async () => {
  const cases: Array<{ error: unknown; code: string }> = [
    { error: { code: 429, message: "token=secret" }, code: "gmail_rate_limited" },
    { error: { response: { status: 403, data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } } }, code: "gmail_rate_limited" },
    { error: { response: { status: 403, data: { error: { errors: [{ reason: "forbidden" }] } } } }, code: "invalid_local_configuration" },
    { error: { response: { status: 403, data: { error: { errors: [{ reason: "insufficientPermissions" }] } } } }, code: "missing_scope" },
    { error: { response: { status: 400, data: { error: { message: "Invalid query syntax for secret" } } } }, code: "invalid_gmail_query" },
    { error: { response: { status: 404, data: { message: "private body" } } }, code: "message_not_found" },
  ];

  for (const scenario of cases) {
    const gmail = session(async () => ({ data: { messages: [] } }), async () => { throw scenario.error; });
    await assert.rejects(getMessage(gmail, { messageId: "message-1" }), (error: unknown) => {
      return error instanceof GmailClientError && error.code === scenario.code && !error.message.includes("secret") && !error.message.includes("body");
    });
  }

  let dependencyAttempts = 0;
  async function dependencyRequest(): Promise<unknown> {
    dependencyAttempts += 1;
    if (dependencyAttempts === 1) return dependencyRequest();
    throw { response: { status: 503, data: { message: "credential=redacted" } } };
  }
  const temporary = session(
    dependencyRequest,
    async () => ({ data: {} }),
  );
  await assert.rejects(search(temporary, { query: "is:unread" }), (error: unknown) => {
    return error instanceof GmailClientError && error.code === "gmail_temporarily_unavailable";
  });
  assert.equal(dependencyAttempts, 2);

  const network = session(async () => { throw Object.assign(new Error("refresh token network detail"), { code: "ECONNRESET" }); }, async () => ({ data: {} }));
  await assert.rejects(search(network, { query: "is:unread" }), (error: unknown) => {
    return error instanceof GmailClientError && error.code === "network_failure" && !error.message.includes("refresh token");
  });
});

test("blocks draft creation for readonly-only sessions with actionable scope remediation", async () => {
  let calls = 0;
  const gmail = session(
    async () => ({ data: {} }),
    async () => ({ data: {} }),
  );
  await assert.rejects(
    createDraft(gmail, { account: "personal", to: ["recipient@example.test"], subject: "subject", body: "body" }),
    (error: unknown) => error instanceof GmailClientError
      && error.code === "missing_scope"
      && error.message.includes("auth reauthorize --alias personal"),
  );
  await assert.rejects(
    sendMessage(gmail, { account: "personal", draftId: "draft-1", confirm: true }),
    (error: unknown) => error instanceof GmailClientError && error.code === "missing_scope",
  );
  assert.equal(calls, 0);
});

test("maps draft creation and draft sending to one alias and returns Gmail IDs", async () => {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const gmail = {
    alias: "personal",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    gmailClient: {
      users: {
        messages: {
          async list() { return { data: {} }; },
          async get() { return { data: {} }; },
          async send(params: Record<string, unknown>) {
            calls.push({ name: "messages.send", params });
            return { data: { id: "message-2", threadId: "thread-2" } };
          },
        },
        drafts: {
          async create(params: Record<string, unknown>) {
            calls.push({ name: "drafts.create", params });
            return { data: { id: "draft-1", message: { threadId: "thread-1" } } };
          },
          async send(params: Record<string, unknown>) {
            calls.push({ name: "drafts.send", params });
            return { data: { id: "message-1", threadId: "thread-1" } };
          },
        },
        threads: {
          async get() { return { data: { messages: [] } }; },
        },
      },
    },
  } as unknown as Parameters<typeof search>[0];

  const draft = await createDraft(gmail, {
    account: "personal",
    to: ["recipient@example.test"],
    subject: "subject",
    body: "body",
  });
  assert.deepEqual(draft, { account: "personal", draftId: "draft-1", threadId: "thread-1" });
  const createCall = calls[0];
  assert.equal(createCall?.name, "drafts.create");
  const requestBody = createCall?.params.requestBody as { message?: { raw?: string } } | undefined;
  const raw = requestBody?.message?.raw;
  assert.equal(typeof raw, "string");
  const decoded = Buffer.from(raw as string, "base64url").toString("utf8");
  assert.match(decoded, /^To: recipient@example\.test\r\nSubject: subject\r\n/u);
  assert.match(decoded, /\r\n\r\nbody$/u);

  const sent = await sendMessage(gmail, { account: "personal", draftId: "draft-1", confirm: true });
  assert.deepEqual(sent, { account: "personal", messageId: "message-1", threadId: "thread-1" });
  assert.deepEqual(calls[1], { name: "drafts.send", params: { userId: "me", requestBody: { id: "draft-1" } } });
});
