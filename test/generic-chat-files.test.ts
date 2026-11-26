import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "../src/api/app-types.ts";
import { createGenericChatClient } from "../src/surfaces/generic-chat/client.ts";
import { createGenericChatInbound } from "../src/surfaces/generic-chat/inbound.ts";
import { genericChatSender } from "../src/surfaces/generic-chat/outbound.ts";
import { signGenericChat } from "../src/surfaces/generic-chat/protocol.ts";
import { createGenericChatTransport } from "../src/surfaces/generic-chat/transport.ts";
import { runSurfaceTurn } from "../src/surfaces/turn-driver.ts";
import type { TurnFlow } from "../src/surfaces/turn-flow.ts";
import type { Delivery, TurnRequest } from "../src/types.ts";
import { withTenant } from "../src/tenants/context.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";

const SECRET = "generic-chat-test-secret-0123456789abcdef";
const accountTenant = async () => TEST_TENANT;

function chatHost(respond: (path: string, body: Record<string, unknown>) => Response) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = createGenericChatClient({
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

test("files attached to a chat message reach the turn as staged attachments, and unreadable ones as logged notes", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { client, calls } = chatHost((_path, body) =>
    Response.json({ url: `https://storage.example/${String(body.file_id)}` }),
  );
  const turns: TurnRequest[] = [];
  const inbound = createGenericChatInbound({
    registerGroup: async () => {},
    secret: SECRET,
    accountTenant,
    client,
    onAction: async () => {},
    stageBlob: async (bytes) => ({ blobId: `blob-${Buffer.from(bytes).toString()}` }),
    storageFetch: async (url) =>
      String(url).endsWith("/31") ? new Response("deck bytes") : new Response("gone", { status: 403 }),
    app: {
      ingestSurfaceEvents: async () => ({ upserted: 1 }),
      onContextRequestCreated: () => () => {},
      turn: async (request: TurnRequest) => (turns.push(request), { runId: "r1" }),
    } as unknown as App,
    surfaceCache: { readMessages: async () => [] },
    isInternalEmail: async () => true,
    unansweredReply: async () => {},
    guestReply: async () => {},
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
    assert.equal((await inbound.handle(ts, signGenericChat(SECRET, ts, raw), raw)).status, 200);
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
  assert.equal(
    logged.mock.calls[0]?.arguments[0],
    '[generic-chat] attachment unreadable account=7001 chat=88 file="notes.txt" type=text/plain reason=HTTP 403',
  );
});

function sending(respond: Parameters<typeof chatHost>[0]) {
  const host = chatHost(respond);
  const stored: Array<{ url: string; fields: Record<string, string> }> = [];
  const send = genericChatSender({
    accountTenant,
    client: host.client,
    app: {
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

test("a delivery whose files cannot be uploaded still posts its text, says the files are missing and logs why", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
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
  assert.match(
    String(logged.mock.calls[0]?.arguments[0]),
    /^\[generic-chat\] attachment upload failed account=7001 chat=88 files="huge.bin":application\/zip reason=generic-chat 413/,
  );
});

test("a live turn names unread files, shows typing, posts its status, then the reply with its files once and its reaction", async () => {
  const { client, calls } = chatHost((path, body) =>
    Response.json(
      path === "/agent_app/files/upload"
        ? { file_id: "61", upload: { url: "https://storage.example/up", fields: {} } }
        : { message_id: body.client_message_id === "run:r1" ? "44" : "43" },
    ),
  );
  const transport = createGenericChatTransport(
    {
      client,
      app: { readSurfaceMessages: async () => [], ingestSurfaceEvents: async () => ({ upserted: 1 }) },
      blobs: { readBlob: async () => Buffer.from("chart bytes"), readFileArtifact: async () => Buffer.alloc(0) },
      storageFetch: async () => new Response(null, { status: 204 }),
    },
    { where: { account: "7001", kind: "dm", chat: "88" }, authorId: "5", trigger: "1793649600.00000000000000001001" },
  );
  const acked: string[] = [];
  const editRefs: string[][] = [];
  const flow: TurnFlow = {
    inFlightRuns: { add() {}, delete() {}, has: () => false },
    ackRunDelivery: (runId) => void acked.push(runId),
    callCore: async (_body, hooks) => {
      await hooks?.onQueued?.("r1");
      hooks?.onReplying?.();
      hooks?.onFirstBlock?.("On it.");
      await new Promise((r) => setTimeout(r, 50));
      const attachments = [{ name: "chart.png", mimetype: "image/png", sizeBytes: 11, blobId: "b1" }];
      return { status: "ok", reply: "Here is the chart. [[react: tada]]", attachments };
    },
  };
  await runSurfaceTurn(
    { flow, label: "partner-chat", reportEditRef: async (runId, ref) => void editRefs.push([runId, ref]) },
    transport,
    {
      kind: "dm",
      trigger: "1793649600.00000000000000001001",
      where: "test",
      ackEmoji: { candidates: () => ["eyes"], pick: async () => undefined },
      prepare: async () => ({ text: "chart please", inboundNotes: [`I couldn't read "scan.pdf" (HTTP 403)`] }) as never,
    },
  );
  assert.deepEqual(
    calls.map(({ path, body }) => [
      path.replace("/agent_app/", ""),
      body.client_message_id ?? body.typing ?? body.name,
    ]),
    [
      ["messages", "inbound-files:1793649600.00000000000000001001"],
      ["typing", true],
      ["messages", "status:run:r1"],
      ["typing", false],
      ["files/upload", "chart.png"],
      ["messages", "run:r1"],
      ["reactions/add", "tada"],
    ],
  );
  assert.equal(
    calls[0]!.body.body,
    `Some of your files didn't come through, so I haven't read them: I couldn't read "scan.pdf" (HTTP 403).`,
  );
  assert.deepEqual(calls[5]!.body, {
    client_message_id: "run:r1",
    chat_id: "88",
    body: "Here is the chart.",
    file_ids: ["61"],
  });
  assert.deepEqual(calls[6]!.body, { chat_id: "88", message_id: "1001", name: "tada" });
  assert.deepEqual([acked, editRefs.map(([runId]) => runId)], [["r1"], ["r1"]]);
});
