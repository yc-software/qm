import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createSessionMethods } from "../src/api/app-sessions.ts";
import { Readable } from "node:stream";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sharedMessages, type SessionShare } from "../src/sessions/session-share.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryConfigStore, type PersistedScopedFlag } from "../src/resolution/config-store.ts";
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

const original = [
  ...entries,
  entry("user", { text: "File", attachments: [{ artifactId: "f1", secret: "SECRET" }] }, 12),
];

const org = scopeId("org", "default-org");
const alice = scopeId("personal", "alice");

async function sharingHarness(t: TestContext) {
  const bytes = createMemoryDurableByteStore();
  const h = {
    visible: original,
    accessible: true,
    fileData: "<script>attachment contents</script>" as string | null,
    liveSessionScope: alice as string | null,
    puts: 0,
    base: "",
    store: createMemoryMap<SessionShare>(),
    identity: createIdentityService(),
    deliveries: createDeliveryStore(),
    config: createMemoryConfigStore("default-org"),
    create: (audience = "internal", principalId = "alice") =>
      fetch(`${h.base}/v1/sessions/s1/share`, { method: "POST", body: JSON.stringify({ audience, principalId }) }),
    read: (token: string, audience = "internal", tail = "", viewer = "bob") =>
      fetch(
        `${h.base}/v1/${audience === "external" ? "public-shares" : "shared-sessions"}/${token}${tail}?viewer=${viewer}&inline=1`,
      ),
    audiences: (viewer = "alice") => fetch(`${h.base}/v1/sessions/s1/share?viewer=${viewer}`),
  };
  const countedBytes = {
    ...bytes,
    put: async (...args: Parameters<typeof bytes.put>) => {
      h.puts++;
      return bytes.put(...args);
    },
  };
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
      deps: {
        identity: h.identity,
        sessionShares: h.store,
        sessionShareBytes: countedBytes,
        deliveries: h.deliveries,
        config: h.config,
        sessions: { get: async () => (h.liveSessionScope ? { id: "s1", scopeId: h.liveSessionScope } : null) },
      },
      app: {
        canViewSessionSnapshot: async (_id: string, user: string, bounds: { minSeq: number }) =>
          h.accessible && user === "alice" && h.visible.some((entry) => entry.seq === bounds.minSeq),
        getSessionForViewer: async (_id: string, user: string) =>
          h.accessible && user === "alice"
            ? { session: { id: "s1", threadRef: "web:alice:s1", scopeId: alice }, entries: h.visible }
            : null,
        openFileForViewer: async (id: string, user: string) =>
          id === "f1" && user === "alice" && h.fileData !== null
            ? {
                name: "example.html",
                mimetype: "text/html",
                sizeBytes: Buffer.byteLength(h.fileData),
                stream: Readable.from(h.fileData),
              }
            : null,
      },
    } as unknown as ApiCtx);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  h.base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return h;
}

async function shareToken(response: Promise<Response>): Promise<string> {
  return ((await (await response).json()) as { share: { token: string } }).share.token;
}

async function firstFileId(response: Promise<Response>): Promise<string> {
  const data = (await (await response).json()) as { messages: Array<{ attachments?: Array<{ id: string }> }> };
  return data.messages.at(-1)!.attachments![0]!.id;
}

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

test("work phases and approval decisions remain outside the shared message snapshot", () => {
  assert.deepEqual(
    sharedMessages([
      entry("user", { text: "Run the check" }, 1),
      entry("text_start", { phase: "commentary", streamOffset: 0 }, 2),
      entry("text", { text: "PRIVATE_WORK_NARRATION" }, 3),
      entry("approval_request", { requestId: "r", command: "PRIVATE_COMMAND" }, 4),
      entry("approval_resolved", { requestId: "r", command: "PRIVATE_COMMAND", approved: false }, 5),
      entry("approval_request", { requestId: "r", command: "PRIVATE_COMMAND" }, 6),
      entry("approval_resolved", { requestId: "r", command: "PRIVATE_COMMAND", approved: true, scope: "once" }, 7),
      entry("text_start", { phase: "final_answer", streamOffset: 22 }, 8),
      entry("assistant", { text: "Check complete", stopped: true }, 9),
    ]),
    [
      { role: "user", text: "Run the check" },
      { role: "assistant", text: "Check complete" },
    ],
  );
});

test("fresh shares freeze messages and authorized attachments with separate audiences", async (t) => {
  const h = await sharingHarness(t);
  assert.equal((await h.create("invalid")).status, 400);
  assert.equal((await h.create("internal", "bob")).status, 404);
  const token = await shareToken(h.create());
  const response = await h.read(token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.ok(text.includes("Published reply"));
  for (const privateField of ["SECRET", "blobKey", "createdBy", "attachmentIds"])
    assert.equal(text.includes(privateField), false);
  const data = JSON.parse(text);
  const fileId = data.messages.at(-1).attachments[0].id;
  assert.notEqual(fileId, "f1");
  assert.equal((await h.read(token, "external")).status, 404);
  assert.equal((await h.read(token, "internal", "", "")).status, 403);
  h.visible = [...original, entry("user", { text: "New message" }, 13)];
  const second = await shareToken(h.create());
  assert.notEqual(second, token);
  assert.equal((await (await h.read(token)).text()).includes("New message"), false);
  assert.equal((await (await h.read(second)).text()).includes("New message"), true);
  const external = await shareToken(h.create("external"));
  assert.equal((await h.read(external, "external", "", "")).status, 200);
  assert.equal((await h.read(external)).status, 404);
  assert.equal((await h.read(second, "internal", `/files/${fileId}`)).status, 404);
  h.visible = [entry("user", { text: "Generate file" }, 1), entry("assistant", { text: "Generated" }, 2)];
  const delivery = await h.deliveries.enqueue({
    destination: { type: "web", target: "web:alice:s1" },
    text: "Generated",
    attachments: [{ artifactId: "f1", blobId: "blob-f1", name: "example.html", mimetype: "text/html", sizeBytes: 34 }],
    provenance: {
      sourceSessionId: "s1",
      sourceThreadRef: "web:alice:s1",
      sourceScopeId: alice,
      sourceAssistantEntrySeq: 2,
      trigger: "conversation",
      surface: "web",
      fireKey: "test",
    },
    idempotencyKey: "generated",
  });
  const pendingShare = await shareToken(h.create());
  assert.equal((await (await h.read(pendingShare)).text()).includes("example.html"), false);
  for (const [index, change] of [
    { shadow: true },
    { destination: { type: "web", target: "another-thread" } },
    { provenance: { ...delivery.provenance!, sourceSessionId: "another-session" } },
    { provenance: { ...delivery.provenance!, sourceAssistantEntrySeq: 99 } },
  ].entries()) {
    const rejected = await h.deliveries.enqueue({
      destination: delivery.destination,
      text: "PRIVATE_DELIVERY_TEXT",
      attachments: delivery.attachments,
      provenance: delivery.provenance,
      ...change,
      idempotencyKey: `excluded-${index}`,
    });
    await h.deliveries.ack(rejected.id, Date.now());
  }
  const excludedShare = await shareToken(h.create());
  const excludedText = await (await h.read(excludedShare)).text();
  assert.equal(excludedText.includes("example.html"), false);
  assert.equal(excludedText.includes("PRIVATE_DELIVERY_TEXT"), false);
  await h.deliveries.ack(delivery.id, Date.now());
  const generatedShare = await shareToken(h.create());
  assert.equal((await (await h.read(generatedShare)).text()).includes("example.html"), true);
  h.visible = original;
  const beforePuts = h.puts;
  h.visible = [...original, entry("user", { attachments: [{ artifactId: "missing" }] }, 13)];
  assert.equal((await h.create()).status, 409);
  assert.equal(h.puts, beforePuts);
  h.visible = original;
  h.fileData = null;
  const download = await h.read(token, "internal", `/files/${fileId}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/octet-stream");
  assert.match(download.headers.get("content-disposition")!, /^attachment;/);
  assert.match(download.headers.get("content-security-policy")!, /sandbox/);
  assert.equal(await download.text(), "<script>attachment contents</script>");
  assert.equal((await h.create()).status, 409);
  h.visible = h.visible.slice(1);
  assert.equal((await h.read(token)).status, 404);
  h.visible = original;
  await h.identity.deactivate("bob");
  assert.equal((await h.read(token)).status, 403);
  h.accessible = false;
  assert.equal((await h.read(external, "external")).status, 404);
  assert.equal((await fetch(`${h.base}/v1/sessions/s1/share`, { method: "DELETE" })).status, 404);
});

test("authenticated-only sharing governs external shares at creation and on every read", async (t) => {
  const h = await sharingHarness(t);
  const finance = scopeId("team", "finance");
  const publicRead = (token: string, tail = "") => h.read(token, "external", tail, "");
  assert.deepEqual(await (await h.audiences()).json(), { audiences: ["internal", "external"] });
  assert.equal((await h.audiences("bob")).status, 404);
  assert.equal((await h.audiences("")).status, 403);
  const external = await shareToken(h.create("external"));
  const fileId = await firstFileId(publicRead(external));
  assert.equal((await publicRead(external, `/files/${fileId}`)).status, 200);

  await h.config.setAuthenticatedOnlySharing(org, true);
  const storedShares = (await h.store.all()).length;
  const storedBytes = h.puts;
  const rejected = await h.create("external");
  assert.equal(rejected.status, 403);
  assert.equal(((await rejected.json()) as { error: string }).error, "external_sharing_prohibited");
  assert.equal((await h.store.all()).length, storedShares);
  assert.equal(h.puts, storedBytes);
  assert.deepEqual(await (await h.audiences()).json(), { audiences: ["internal"] });
  await h.config.setAuthenticatedOnlySharing(alice, false);
  assert.equal((await h.create("external")).status, 403);
  assert.equal((await publicRead(external)).status, 404);
  assert.equal((await publicRead(external, `/files/${fileId}`)).status, 404);
  assert.equal((await h.read(external, "internal", "", "alice")).status, 404);
  const internal = await shareToken(h.create("internal"));
  const internalFileId = await firstFileId(h.read(internal));
  assert.equal((await h.read(internal, "internal", `/files/${internalFileId}`)).status, 200);

  await h.config.setAuthenticatedOnlySharing(org, false);
  assert.equal((await publicRead(external)).status, 200);
  assert.equal((await publicRead(external, `/files/${fileId}`)).status, 200);
  await h.config.setAuthenticatedOnlySharing(alice, true);
  assert.equal((await h.create("external")).status, 403);
  assert.equal((await publicRead(external)).status, 404);
  assert.deepEqual(await (await h.audiences()).json(), { audiences: ["internal"] });
  await h.config.setAuthenticatedOnlySharing(alice, false);
  await h.config.setAuthenticatedOnlySharing(finance, true);
  assert.equal((await h.create("external")).status, 200);
  assert.equal((await publicRead(external)).status, 200);

  h.liveSessionScope = finance;
  assert.equal((await publicRead(external)).status, 404);
  assert.equal((await publicRead(external, `/files/${fileId}`)).status, 404);
  h.liveSessionScope = null;
  assert.equal((await publicRead(external)).status, 404);
  assert.equal((await publicRead(external, `/files/${fileId}`)).status, 404);
  h.liveSessionScope = alice;
  assert.equal((await publicRead(external)).status, 200);
  const config = h.config;
  h.config = undefined as unknown as typeof config;
  assert.equal((await h.create("external")).status, 403);
  assert.equal((await h.create("internal")).status, 200);
  assert.equal((await publicRead(external)).status, 404);
  h.config = config;
  assert.equal((await publicRead(external)).status, 200);

  h.accessible = false;
  assert.equal((await publicRead(external)).status, 404);
  assert.equal((await publicRead(external, `/files/${fileId}`)).status, 404);
  assert.equal((await h.audiences()).status, 404);
});

test("authenticated-only sharing is the organization setting or the scope's own and never loosens", async () => {
  const shared = createMemoryMap<PersistedScopedFlag>();
  const a = createMemoryConfigStore("default-org", { authenticatedOnlySharing: shared });
  const b = createMemoryConfigStore("default-org", { authenticatedOnlySharing: shared });
  const finance = scopeId("team", "finance");
  const sales = scopeId("team", "sales");
  assert.equal(await a.getAuthenticatedOnlySharingDurable(finance), false);
  await a.setAuthenticatedOnlySharing(finance, true);
  assert.equal(await b.getAuthenticatedOnlySharingDurable(finance), true);
  assert.equal(await b.getAuthenticatedOnlySharingDurable(sales), false);
  await a.setAuthenticatedOnlySharing(org, true);
  await a.setAuthenticatedOnlySharing(finance, false);
  assert.equal(await b.getAuthenticatedOnlySharingDurable(finance), true);
  assert.equal(await b.getAuthenticatedOnlySharingDurable(sales), true);
  await a.setAuthenticatedOnlySharing(org, false);
  assert.equal(await b.getAuthenticatedOnlySharingDurable(finance), false);
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
