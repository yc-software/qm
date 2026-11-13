import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "../src/api/app-types.ts";
import { createPartnerChatClient } from "../src/surfaces/partner-chat/client.ts";
import { createPartnerChatInbound } from "../src/surfaces/partner-chat/inbound.ts";
import { partnerChatSender } from "../src/surfaces/partner-chat/outbound.ts";
import { signPartnerChat } from "../src/surfaces/partner-chat/protocol.ts";
import type { Delivery, TurnRequest } from "../src/types.ts";
import { withTenant } from "../src/tenants/context.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";

const SECRET = "partner-chat-test-secret-0123456789abcdef";
const tenantFor = async () => TEST_TENANT;

function chatHost(respond: (path: string, body: Record<string, unknown>) => Response) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = createPartnerChatClient({
    url: "https://chat.example",
    secret: SECRET,
    fetch: async (url, init) => {
      const call = { path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) };
      calls.push(call);
      return respond(call.path, call.body);
    },
  });
  return { client, calls };
}

test("files attached to a chat message reach the turn as staged attachments, and unreadable ones as notes", async () => {
  const { client, calls } = chatHost((_path, body) =>
    Response.json({ url: `https://storage.example/${String(body.file_id)}` }),
  );
  const turns: TurnRequest[] = [];
  const inbound = createPartnerChatInbound({
    secret: SECRET,
    client,
    onAction: async () => {},
    stageBlob: async (bytes) => ({ blobId: `blob-${Buffer.from(bytes).toString()}` }),
    storageFetch: async (url) =>
      String(url).endsWith("/31") ? new Response("deck bytes") : new Response("gone", { status: 403 }),
    app: {
      tenantFor,
      ingestSurfaceEvents: async () => ({ upserted: 1 }),
      onContextRequestCreated: () => () => {},
      turn: async (request: TurnRequest) => (turns.push(request), { runId: "r1" }),
    } as unknown as App,
    surfaceCache: { readMessages: async () => [] },
    isInternalEmail: async () => true,
    unansweredReply: async () => {},
    turns: { start: async (turn) => void turns.push(turn.body as TurnRequest) },
  });
  const ada = { id: "5", email: "ada@example.com", name: "Ada Lovelace" };
  const event = (protocol?: 2) => ({
    ...(protocol ? { protocol } : {}),
    event_id: "ev-1",
    type: "message.created",
    account: "7001",
    chat: { id: "88", kind: "dm", members: [ada, { id: "9", bot: true }] },
    message: {
      id: "1001",
      user: ada,
      body: "",
      created_at: "2026-11-02T20:00:00Z",
      files: [
        { id: "31", name: "deck.pdf", content_type: "application/pdf", size_bytes: 10 },
        { id: "32", name: "notes.txt", content_type: "text/plain" },
      ],
    },
  });
  const ts = String(Math.floor(Date.now() / 1000));
  for (const raw of [JSON.stringify(event()), JSON.stringify(event(2))])
    assert.equal((await inbound.handle(ts, signPartnerChat(SECRET, ts, raw), raw)).status, 200);
  assert.deepEqual(calls.slice(2), [
    { path: "/agent_app/files/url", body: { file_id: "31" } },
    { path: "/agent_app/files/url", body: { file_id: "32" } },
  ]);
  const { origin: _origin, async: _async, ...sharedRequest } = turns[0]!;
  assert.deepEqual(turns[1], sharedRequest);
  assert.deepEqual(turns[0]?.attachments, [
    {
      name: "deck.pdf",
      mimetype: "application/pdf",
      sizeBytes: 10,
      blobId: "blob-deck bytes",
      sourceId: "31",
      author: "Ada Lovelace",
    },
  ]);
  assert.deepEqual(turns[0]?.inboundNotes, [`I couldn't read "notes.txt" (HTTP 403)`]);
});

function sending(respond: Parameters<typeof chatHost>[0]) {
  const host = chatHost(respond);
  const stored: Array<{ url: string; fields: Record<string, string> }> = [];
  const send = partnerChatSender({
    client: host.client,
    app: {
      tenantFor,
      getApproval: async () => null,
      readSurfaceMessages: async () => [],
      ingestSurfaceEvents: async () => ({ upserted: 1 }),
    },
    blobs: {
      readBlob: async (blobId) => {
        if (blobId === "expired") throw new Error("blob expired");
        return Buffer.from(blobId === "empty" ? "" : "chart bytes");
      },
      readFileArtifact: async (artifactId, viewerId) => Buffer.from(`${artifactId} for ${viewerId}`),
    },
    storageFetch: async (url, init) => {
      const form = init?.body as FormData;
      const fields: Record<string, string> = {};
      for (const [name, value] of form) fields[name] = typeof value === "string" ? value : await value.text();
      stored.push({ url: String(url), fields });
      return new Response(null, { status: 204 });
    },
  });
  const deliver = (text: string, attachments: Delivery["attachments"]) =>
    withTenant(TEST_TENANT, (tenant) =>
      send(
        {
          id: "d1",
          idempotencyKey: "k1",
          destination: { type: "partner-chat", target: "partner-chat:7001:group:88:1001" },
          text,
          attachments,
        } as Delivery,
        tenant,
      ),
    );
  return { ...host, stored, deliver };
}

test("a delivery's attachments are uploaded to storage and posted on one message with its text", async () => {
  let nextFile = 70;
  const { calls, stored, deliver } = sending((path) =>
    path === "/agent_app/files/upload"
      ? Response.json({
          file_id: String(++nextFile),
          upload: { url: "https://storage.example/up", fields: { key: `k${nextFile}` } },
        })
      : Response.json({ message_id: "42" }),
  );
  await deliver("Here you go.", [
    { name: "chart.png", mimetype: "image/png", sizeBytes: 11, blobId: "live" },
    { name: "blank.txt", mimetype: "text/plain", sizeBytes: 0, blobId: "empty" },
    {
      name: "report.md",
      mimetype: "text/markdown",
      sizeBytes: 9,
      blobId: "expired",
      artifactId: "a1",
      artifactViewerId: "v1",
    },
  ]);
  assert.deepEqual(calls, [
    {
      path: "/agent_app/files/upload",
      body: { chat_id: "88", name: "chart.png", content_type: "image/png", size_bytes: 11 },
    },
    {
      path: "/agent_app/files/upload",
      body: { chat_id: "88", name: "report.md", content_type: "text/markdown", size_bytes: 9 },
    },
    {
      path: "/agent_app/messages",
      body: { client_message_id: "k1", chat_id: "88", thread_id: "1001", body: "Here you go.", file_ids: ["71", "72"] },
    },
  ]);
  assert.deepEqual(stored, [
    { url: "https://storage.example/up", fields: { key: "k71", file: "chart bytes" } },
    { url: "https://storage.example/up", fields: { key: "k72", file: "a1 for v1" } },
  ]);
});

test("a delivery whose files cannot be uploaded still posts its text and says the files are missing", async () => {
  const { calls, deliver } = sending((path) =>
    path === "/agent_app/files/upload"
      ? Response.json({ error: "file too large" }, { status: 413 })
      : Response.json({ message_id: "42" }),
  );
  await deliver("Here you go.", [{ name: "huge.bin", mimetype: "application/zip", sizeBytes: 11, blobId: "live" }]);
  assert.deepEqual(calls.at(-1), {
    path: "/agent_app/messages",
    body: {
      client_message_id: "k1",
      chat_id: "88",
      thread_id: "1001",
      body: "Here you go.\n\nI couldn't attach the file(s). Try again in a moment.",
    },
  });
});
