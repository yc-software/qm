import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createSessionMethods } from "../src/api/app-sessions.ts";
import { Readable } from "node:stream";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sharedMessages, type SessionShare } from "../src/sessions/session-share.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { sessionSharingRoutes } from "../src/api/routes/session-sharing.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { scopeId, type SessionEntry } from "../src/types.ts";

function entry(type: SessionEntry["type"], payload: unknown, seq: number): SessionEntry {
  return {
    sessionId: "s1",
    seq,
    parentSeq: null,
    type,
    payload,
    scopeLabel: scopeId("personal", "alice"),
    createdAt: seq,
  };
}

const entries = [
  entry("user", { text: "RAW_CONTEXT_SECRET", display: "Hello", attachments: [{ secret: "ATTACHMENT_SECRET" }] }, 1),
  entry("thinking", { text: "THINKING_SECRET" }, 2),
  entry("tool_call", { action: "execute", command: "COMMAND_SECRET", callId: "exec" }, 3),
  entry("tool_result", { text: "RESULT_SECRET", callId: "exec" }, 4),
  entry("text", { text: "INTERMEDIATE_SECRET" }, 5),
  entry("assistant", { text: "Hello back", metadata: "METADATA_SECRET" }, 6),
  entry("user", { text: "HIDDEN_SECRET", hidden: true }, 7),
  entry("user", { text: "OVERHEARD_SECRET", overheard: true }, 8),
  entry("tool_call", { action: "post", callId: "post", text: "Published reply", secret: "POST_SECRET" }, 9),
  entry("tool_result", { callId: "post", ok: true, secret: "POST_RESULT_SECRET" }, 10),
  entry("assistant", { text: "UNPUBLISHED_SECRET" }, 11),
];

test("shared transcript allowlists visible message fields and published replies", () => {
  assert.deepEqual(sharedMessages(entries), [
    { role: "user", text: "Hello" },
    { role: "assistant", text: "Hello back" },
    { role: "assistant", text: "Published reply" },
  ]);
  assert.equal(JSON.stringify(sharedMessages(entries)).includes("SECRET"), false);
  assert.deepEqual(
    sharedMessages([
      entry("tool_call", { action: "post", text: "FAILED_SECRET", callId: "p" }, 1),
      entry("tool_result", { callId: "p", ok: false }, 2),
      entry("assistant", { text: "Final answer" }, 3),
    ]),
    [{ role: "assistant", text: "Final answer" }],
  );
});

test("fresh shares freeze messages and authorized attachments with separate audiences", async (t) => {
  const store = createMemoryMap<SessionShare>();
  const bytes = createMemoryDurableByteStore();
  let puts = 0;
  const countedBytes = {
    ...bytes,
    put: async (...args: Parameters<typeof bytes.put>) => {
      puts++;
      return bytes.put(...args);
    },
  };
  const identity = createIdentityService();
  const deliveries = createDeliveryStore();
  const original = [
    ...entries,
    entry("user", { text: "File", attachments: [{ artifactId: "f1", secret: "SECRET" }] }, 12),
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
      actor: null,
      deps: { identity, sessionShares: store, sessionShareBytes: countedBytes, deliveries },
      app: {
        canViewSessionSnapshot: async (_id: string, user: string, bounds: { minSeq: number }) =>
          accessible && user === "alice" && visible.some((entry) => entry.seq === bounds.minSeq),
        getSessionForViewer: async (_id: string, user: string) =>
          accessible && user === "alice"
            ? {
                session: { id: "s1", threadRef: "web:alice:s1", scopeId: scopeId("personal", "alice") },
                entries: visible,
              }
            : null,
        openFileForViewer: async (id: string, user: string) =>
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
  visible = [...original, entry("user", { text: "New message" }, 13)];
  const second = (await (await create()).json()) as { share: { token: string } };
  assert.notEqual(second.share.token, token);
  assert.equal((await (await read(token)).text()).includes("New message"), false);
  assert.equal((await (await read(second.share.token)).text()).includes("New message"), true);
  const external = (await (await create("external")).json()) as { share: { token: string } };
  assert.equal((await read(external.share.token, "external", "", "")).status, 200);
  assert.equal((await read(external.share.token)).status, 404);
  assert.equal((await read(second.share.token, "internal", `/files/${fileId}`)).status, 404);
  visible = [entry("user", { text: "Generate file" }, 1), entry("assistant", { text: "Generated" }, 2)];
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
  visible = [...original, entry("user", { attachments: [{ artifactId: "missing" }] }, 13)];
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
  visible = visible.slice(1);
  assert.equal((await read(token)).status, 404);
  visible = original;
  await identity.deactivate("bob");
  assert.equal((await read(token)).status, 403);
  accessible = false;
  assert.equal((await read(external.share.token, "external")).status, 404);
  assert.equal((await fetch(`${base}/v1/sessions/s1/share`, { method: "DELETE" })).status, 404);
});

test("attachment projection includes only user and delivered attachments", () => {
  const messages = sharedMessages([
    entry("user", { attachments: [{ artifactId: "user" }] }, 1),
    entry("tool_result", { tool: "execute", files: [{ artifactId: "private" }] }, 2),
    entry("tool_result", { tool: "attach", files: [{ artifactId: "failed" }], isError: true }, 3),
    entry("tool_result", { tool: "attach", files: [{ artifactId: "old", name: "a" }] }, 4),
    entry("tool_result", { tool: "attach", files: [{ artifactId: "new", name: "a" }] }, 5),
    entry("assistant", { text: "Here" }, 6),
    entry("delivery", { files: [{ artifactId: "new" }] }, 7),
    entry("tool_call", { action: "post", callId: "p", text: "Posted" }, 8),
    entry("tool_result", { callId: "p", files: [{ artifactId: "posted" }] }, 9),
    entry("assistant", { text: "private final" }, 10),
  ]);
  assert.deepEqual(messages, [
    { role: "user", text: "", attachmentIds: ["user"] },
    { role: "assistant", text: "Here", attachmentIds: ["new"] },
    { role: "assistant", text: "Posted", attachmentIds: ["posted"] },
  ]);
});

test("snapshot authorization checks mixed tenure bounds without reading transcript payloads", async () => {
  let allowed = true;
  let window = {
    principalId: "alice",
    validFrom: 100,
    validTo: 500,
    validFromSeq: 2 as number | null,
    validToSeq: null as number | null,
  };
  const methods = createSessionMethods(
    { sessions: { participantWindowsOf: async () => [window] } } as unknown as Parameters<
      typeof createSessionMethods
    >[0],
    { sessionForViewer: async () => (allowed ? {} : null) } as unknown as Parameters<typeof createSessionMethods>[1],
  );
  const bounds = { minSeq: 2, maxSeq: 9, minCreatedAt: 50, maxCreatedAt: 499 };
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", bounds), true);
  assert.equal(await methods.canViewSessionSnapshot("s1", "bob", bounds), false);
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, minSeq: 1 }), false);
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, maxCreatedAt: 500 }), false);
  window = { ...window, validFromSeq: null, validToSeq: 10 };
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", bounds), false);
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, minCreatedAt: 100 }), true);
  assert.equal(
    await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, minCreatedAt: 100, maxSeq: 10 }),
    false,
  );
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, minSeq: NaN }), false);
  allowed = false;
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, minCreatedAt: 100 }), false);
});

test("staged tool attachments are never shared without confirmed delivery", () => {
  const staged = entry("tool_result", { tool: "attach", ok: true, files: [{ artifactId: "PRIVATE_STAGED_FILE" }] }, 1);
  for (const following of [
    [],
    [entry("assistant", { text: "Done" }, 2)],
    [entry("user", { text: "Next turn" }, 2)],
    [
      entry("tool_call", { action: "post", callId: "p", text: "Posted" }, 2),
      entry("tool_result", { callId: "p", ok: true }, 3),
    ],
  ]) {
    assert.equal(JSON.stringify(sharedMessages([staged, ...following])).includes("PRIVATE_STAGED_FILE"), false);
  }
});
