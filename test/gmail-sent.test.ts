import assert from "node:assert/strict";
import { test } from "node:test";
import { GmailReadError, getSentEmail, listSentEmails } from "../src/connectors/gmail-sent.ts";

test("sent mail reads only SENT messages, paginates, and includes mail sent outside QM", async () => {
  const calls: URL[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
    if (url.pathname.endsWith("/profile")) return Response.json({ emailAddress: "sam@example.com" });
    if (url.pathname.endsWith("/messages"))
      return Response.json({ messages: [{ id: "older" }, { id: "newer" }, { id: "deleted" }], nextPageToken: "next" });
    if (url.pathname.endsWith("/deleted")) return new Response(null, { status: 404 });
    const id = url.pathname.split("/").at(-1);
    return Response.json({
      id,
      threadId: `thread-${id}`,
      internalDate: id === "newer" ? "2000" : "1000",
      snippet: "Hello",
      payload: {
        headers: [
          { name: "To", value: "recipient@example.com" },
          { name: "Subject", value: "Outside QM" },
        ],
      },
    });
  };
  const result = await listSentEmails("test-token", "cursor", fakeFetch);
  assert.equal(calls[0]!.searchParams.get("labelIds"), "SENT");
  assert.equal(calls[0]!.searchParams.get("pageToken"), "cursor");
  assert.equal(calls[0]!.searchParams.get("maxResults"), "25");
  assert.deepEqual(
    result.messages.map((message) => message.id),
    ["newer", "older"],
  );
  assert.equal(result.messages[0]!.to, "recipient@example.com");
  assert.equal(result.nextPageToken, "next");
  assert.equal(result.accountEmail, "sam@example.com");
});

test("Gmail errors do not expose upstream response bodies or tokens", async () => {
  await assert.rejects(
    listSentEmails("private-token", undefined, async () => new Response("private upstream response", { status: 403 })),
    (error: unknown) => error instanceof GmailReadError && error.status === 403 && !error.message.includes("private"),
  );
});

test("sent message details decode MIME text and reject non-sent messages", async () => {
  const payload = {
    id: "m1",
    threadId: "t1",
    labelIds: ["SENT"],
    payload: {
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from("Full email body").toString("base64url") } },
        { filename: "report.pdf", mimeType: "application/pdf" },
      ],
    },
  };
  const result = await getSentEmail("token", "m1", async () => Response.json(payload));
  assert.equal(result.body, "Full email body");
  assert.deepEqual(result.attachments, ["report.pdf"]);
  await assert.rejects(
    getSentEmail("token", "m1", async () => Response.json({ ...payload, labelIds: ["INBOX"] })),
    (error: unknown) => error instanceof GmailReadError && error.status === 404,
  );
});

test("sent message bodies are decoded with their declared charset", async () => {
  const body = (data: Buffer, contentType: string) => ({
    id: "m1",
    threadId: "t1",
    labelIds: ["SENT"],
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: contentType }],
      body: { data: data.toString("base64url") },
    },
  });
  const latin1 = await getSentEmail("token", "m1", async () =>
    Response.json(body(Buffer.from("Café crème", "latin1"), 'text/plain; charset="ISO-8859-1"')),
  );
  assert.equal(latin1.body, "Café crème");
  const sjis = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
  const japanese = await getSentEmail("token", "m1", async () =>
    Response.json(body(sjis, "text/plain; charset=Shift_JIS")),
  );
  assert.equal(japanese.body, "こんにちは");
  const unknown = await getSentEmail("token", "m1", async () =>
    Response.json(body(Buffer.from("plain"), "text/plain; charset=x-made-up")),
  );
  assert.equal(unknown.body, "plain");
});
