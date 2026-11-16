import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { Readable } from "node:stream";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sharedMessages, type SessionShare } from "../src/sessions/session-share.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { sessionSharingRoutes } from "../src/api/routes/session-sharing.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { scopeId } from "../src/types.ts";
import { storedItem, type Item, type NewItem } from "../src/sessions/items.ts";
import { testMap } from "./support/test-database.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

function at(item: NewItem, seq: number): Item {
  return storedItem(item, { sessionId: "s1", seq, createdAt: seq });
}

const transcript = [
  at(
    {
      kind: "UserMessage",
      text: "RAW_CONTEXT_SECRET",
      body: { display: "Hello", attachments: [{ secret: "ATTACHMENT_SECRET" }] },
    },
    1,
  ),
  at({ kind: "Reasoning", text: "THINKING_SECRET" }, 2),
  at({ kind: "ToolCall", callId: "exec", body: { action: "execute", command: "COMMAND_SECRET" } }, 3),
  at({ kind: "ToolResult", callId: "exec", text: "RESULT_SECRET" }, 4),
  at({ kind: "AgentMessage", variant: "narration", text: "INTERMEDIATE_SECRET" }, 5),
  at({ kind: "AgentMessage", text: "Hello back", body: { metadata: "METADATA_SECRET" } }, 6),
  at({ kind: "UserMessage", text: "HIDDEN_SECRET", hidden: true }, 7),
  at({ kind: "UserMessage", text: "OVERHEARD_SECRET", body: { overheard: true } }, 8),
  at({ kind: "ToolCall", callId: "post", body: { action: "post", text: "Published reply", secret: "POST_SECRET" } }, 9),
  at({ kind: "ToolResult", callId: "post", body: { ok: true, secret: "POST_RESULT_SECRET" } }, 10),
  at({ kind: "AgentMessage", text: "UNPUBLISHED_SECRET" }, 11),
  at({ kind: "SteeringMessage", text: "COPIED_HIDDEN_STEER_SECRET", body: { hidden: true } }, 12),
];

test("shared transcript allowlists visible message fields and published replies", () => {
  assert.deepEqual(sharedMessages(transcript), [
    { role: "user", text: "Hello" },
    { role: "assistant", text: "Hello back" },
    { role: "assistant", text: "Published reply" },
  ]);
  assert.equal(JSON.stringify(sharedMessages(transcript)).includes("SECRET"), false);
  assert.deepEqual(
    sharedMessages([
      at({ kind: "ToolCall", callId: "p", body: { action: "post", text: "FAILED_SECRET" } }, 1),
      at({ kind: "ToolResult", callId: "p", body: { ok: false } }, 2),
      at({ kind: "AgentMessage", text: "Final answer" }, 3),
    ]),
    [{ role: "assistant", text: "Final answer" }],
  );
});

test("a delivery into the conversation is shared as the assistant's message", () => {
  assert.deepEqual(
    sharedMessages([
      at({ kind: "UserMessage", text: "remind me" }, 1),
      at({ kind: "AgentMessage", text: "Standup now" }, 2),
    ]),
    [
      { role: "user", text: "remind me" },
      { role: "assistant", text: "Standup now" },
    ],
  );
});

test("work phases and approval decisions remain outside the shared message snapshot", () => {
  assert.deepEqual(
    sharedMessages([
      at({ kind: "UserMessage", text: "Run the check" }, 1),
      at({ kind: "AgentMessage", variant: "narration", text: "PRIVATE_WORK_NARRATION" }, 3),
      at({ kind: "Elicitation", elicitId: "r", body: { command: "PRIVATE_COMMAND" } }, 4),
      at({ kind: "ElicitationResponse", elicitId: "r", approved: false, body: { command: "PRIVATE_COMMAND" } }, 5),
      at({ kind: "Elicitation", elicitId: "r", body: { command: "PRIVATE_COMMAND" } }, 6),
      at(
        {
          kind: "ElicitationResponse",
          elicitId: "r",
          approved: true,
          body: { command: "PRIVATE_COMMAND", scope: "once" },
        },
        7,
      ),
      at({ kind: "AgentMessage", text: "Check complete", body: { stopped: true } }, 9),
    ]),
    [
      { role: "user", text: "Run the check" },
      { role: "assistant", text: "Check complete" },
    ],
  );
});

test("fresh shares freeze messages and authorized attachments with separate audiences", async (t) => {
  const store = testMap<SessionShare>();
  const bytes = createMemoryDurableByteStore();
  let puts = 0;
  const countedBytes = {
    ...bytes,
    put: async (...args: Parameters<typeof bytes.put>) => {
      puts++;
      return bytes.put(...args);
    },
  };
  const identity = createIdentityService(testMap(), { externalMembers: testMap() });
  const deliveries = createDeliveryStore();
  const original = [
    ...transcript,
    at({ kind: "UserMessage", text: "File", body: { attachments: [{ artifactId: "f1", secret: "SECRET" }] } }, 12),
  ];
  let visible = original;
  let accessible = true;
  let fileData: string | null = "<script>attachment contents</script>";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const parts = url.pathname.split("/");
    const method = req.method!;
    const route = sessionSharingRoutes.find(
      (route) =>
        "method" in route &&
        route.method === method &&
        "path" in route &&
        route.path.split("/")[2] === parts[2] &&
        route.path.split("/").length === parts.length,
    );
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    await route.handle({
      req,
      res,
      method,
      url,
      pathname: url.pathname,
      params: { id: "s1", token: parts[3], fileId: parts[5] },
      body: body ? JSON.parse(body) : null,
      tenant,
      actor: null,
      deps: { identity, sessionShares: store, sessionShareBytes: countedBytes, deliveries },
      app: {
        canViewSessionSnapshot: async (_id: string, user: string) => accessible && user === "alice",
        getSessionForViewer: async (_id: string, user: { actorId: string }) =>
          accessible && user.actorId === "alice"
            ? {
                session: { id: "s1", threadRef: "web:alice:s1", scopeId: scopeId("personal", "alice") },
                items: visible,
              }
            : null,
        openFileForViewer: async (_tenant: unknown, id: string, user: string) =>
          id === "f1" && user === "alice" && fileData !== null
            ? {
                name: "example.html",
                mimetype: "text/html",
                sizeBytes: Buffer.byteLength(fileData),
                stream: Readable.from(fileData),
              }
            : null,
      },
    } as unknown as ApiCtx);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const create = (audience = "internal", principalId = "alice") =>
    fetch(`${base}/v1/sessions/s1/share`, { method: "POST", body: JSON.stringify({ audience, principalId }) });
  const read = (token: string, audience = "internal", tail = "", viewer = "bob") =>
    fetch(
      `${base}/v1/${audience === "external" ? "public-shares" : "shared-sessions"}/${token}${tail}?viewer=${viewer}&inline=1`,
    );
  assert.equal((await create("invalid")).status, 400);
  assert.equal((await create("internal", "bob")).status, 404);
  const first = (await (await create()).json()) as { share: { token: string } };
  const token = first.share.token;
  const response = await read(token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.ok(text.includes("Published reply"));
  for (const privateField of ["SECRET", "blobKey", "createdBy", "attachmentIds"])
    assert.equal(text.includes(privateField), false);
  const data = JSON.parse(text);
  const fileId = data.messages.at(-1).attachments[0].id;
  assert.notEqual(fileId, "f1");
  assert.equal((await read(token, "external")).status, 404);
  assert.equal((await read(token, "internal", "", "")).status, 403);
  visible = [...original, at({ kind: "UserMessage", text: "New message" }, 13)];
  const second = (await (await create()).json()) as { share: { token: string } };
  assert.notEqual(second.share.token, token);
  assert.equal((await (await read(token)).text()).includes("New message"), false);
  assert.equal((await (await read(second.share.token)).text()).includes("New message"), true);
  const external = (await (await create("external")).json()) as { share: { token: string } };
  assert.equal((await read(external.share.token, "external", "", "")).status, 200);
  assert.equal((await read(external.share.token)).status, 404);
  assert.equal((await read(second.share.token, "internal", `/files/${fileId}`)).status, 404);
  visible = [at({ kind: "UserMessage", text: "Generate file" }, 1), at({ kind: "AgentMessage", text: "Generated" }, 2)];
  const delivery = await deliveries.enqueue({
    destination: { type: "web", target: "web:alice:s1" },
    text: "Generated",
    attachments: [{ artifactId: "f1", blobId: "blob-f1", name: "example.html", mimetype: "text/html", sizeBytes: 34 }],
    provenance: {
      sourceSessionId: "s1",
      sourceThreadRef: "web:alice:s1",
      sourceScopeId: scopeId("personal", "alice"),
      sourceAssistantEntrySeq: 2,
      trigger: "conversation",
      surface: "web",
      fireKey: "test",
    },
    idempotencyKey: "generated",
  });
  const pendingShare = (await (await create()).json()) as { share: { token: string } };
  assert.equal((await (await read(pendingShare.share.token)).text()).includes("example.html"), false);
  for (const [index, change] of [
    { shadow: true },
    { destination: { type: "web", target: "another-thread" } },
    { provenance: { ...delivery.provenance!, sourceSessionId: "another-session" } },
    { provenance: { ...delivery.provenance!, sourceAssistantEntrySeq: 99 } },
  ].entries()) {
    const rejected = await deliveries.enqueue({
      destination: delivery.destination,
      text: "PRIVATE_DELIVERY_TEXT",
      attachments: delivery.attachments,
      provenance: delivery.provenance,
      ...change,
      idempotencyKey: `excluded-${index}`,
    });
    await deliveries.ack(rejected.id, Date.now());
  }
  const excludedShare = (await (await create()).json()) as { share: { token: string } };
  const excludedText = await (await read(excludedShare.share.token)).text();
  assert.equal(excludedText.includes("example.html"), false);
  assert.equal(excludedText.includes("PRIVATE_DELIVERY_TEXT"), false);
  await deliveries.ack(delivery.id, Date.now());
  const generatedShare = (await (await create()).json()) as { share: { token: string } };
  assert.equal((await (await read(generatedShare.share.token)).text()).includes("example.html"), true);
  visible = original;
  const beforePuts = puts;
  visible = [...original, at({ kind: "UserMessage", body: { attachments: [{ artifactId: "missing" }] } }, 13)];
  assert.equal((await create()).status, 409);
  assert.equal(puts, beforePuts);
  visible = original;
  fileData = null;
  const download = await read(token, "internal", `/files/${fileId}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.match(download.headers.get("content-disposition")!, /^attachment;/);
  assert.match(download.headers.get("content-security-policy")!, /sandbox/);
  assert.equal(await download.text(), "<script>attachment contents</script>");
  assert.equal((await create()).status, 409);
  await identity.deactivate("bob");
  assert.equal((await read(token)).status, 403);
  accessible = false;
  assert.equal((await read(external.share.token, "external")).status, 404);
  assert.equal((await fetch(`${base}/v1/sessions/s1/share`, { method: "DELETE" })).status, 404);
});

test("attachment projection includes only user and delivered attachments", () => {
  const messages = sharedMessages([
    at({ kind: "UserMessage", body: { attachments: [{ artifactId: "user" }] } }, 1),
    at({ kind: "ToolResult", tool: "execute", callId: "", body: { files: [{ artifactId: "private" }] } }, 2),
    at(
      { kind: "ToolResult", tool: "attach", isError: true, callId: "", body: { files: [{ artifactId: "failed" }] } },
      3,
    ),
    at({ kind: "ToolResult", tool: "attach", callId: "", body: { files: [{ artifactId: "old", name: "a" }] } }, 4),
    at({ kind: "ToolResult", tool: "attach", callId: "", body: { files: [{ artifactId: "new", name: "a" }] } }, 5),
    at({ kind: "AgentMessage", text: "Here" }, 6),
    at({ kind: "ToolCall", callId: "p", body: { action: "post", text: "Posted" } }, 8),
    at({ kind: "ToolResult", callId: "p", body: { files: [{ artifactId: "posted" }] } }, 9),
    at({ kind: "AgentMessage", text: "private final" }, 10),
  ]);
  assert.deepEqual(messages, [
    { role: "user", text: "", attachmentIds: ["user"] },
    { role: "assistant", text: "Here" },
    { role: "assistant", text: "Posted", attachmentIds: ["posted"] },
  ]);
});

test("staged tool attachments are never shared without confirmed delivery", () => {
  const staged = at(
    {
      kind: "ToolResult",
      tool: "attach",
      callId: "",
      body: { ok: true, files: [{ artifactId: "PRIVATE_STAGED_FILE" }] },
    },
    1,
  );
  for (const following of [
    [],
    [at({ kind: "AgentMessage", text: "Done" }, 2)],
    [at({ kind: "UserMessage", text: "Next turn" }, 2)],
    [
      at({ kind: "ToolCall", callId: "p", body: { action: "post", text: "Posted" } }, 2),
      at({ kind: "ToolResult", callId: "p", body: { ok: true } }, 3),
    ],
  ]) {
    assert.equal(JSON.stringify(sharedMessages([staged, ...following])).includes("PRIVATE_STAGED_FILE"), false);
  }
});
