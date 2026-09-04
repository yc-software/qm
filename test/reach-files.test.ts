import { installGlobalFakeSprites } from "./support/fake-sprites.ts";

const fakeSprites = installGlobalFakeSprites();
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { reachEnqueue } from "../src/reach/reach.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "reach-files-secret".repeat(3);

describe("POST /v1/reach with files", () => {
  let server: Server;
  let bare: Server;
  let base: string;
  let bareBase: string;
  let built: BuiltApp;

  const capDm = async (actorId: string) =>
    await mintCapabilityToken(
      { actorId, scopeId: scopeId("personal", actorId), exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );

  const post = (b: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${b}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  const seedFile = async (actorId: string, relPath: string, data: string) => {
    const handle = await built.sandbox.provision([
      { scopeId: scopeId("personal", actorId), mountPath: "", mode: "rw" },
    ]);
    await built.sandbox.writeFile(handle, relPath, data);
    await built.sandbox.teardown(handle, { keepWarm: true });
  };

  before(async () => {
    void fakeSprites;
    built = buildApp(testConfig({ signingSecret: SECRET }));
    await built.app.upsertDirectory([
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
      { principalId: "U-alice", displayName: "Alice", type: "internal" },
    ]);
    server = createServer(built.app, {
      signingSecret: SECRET,
      sandbox: built.sandbox,
      blobTransfer: built.blobTransfer,
      files: built.files,
      environments: built.environments,
      auditLog: built.auditLog,
    });
    bare = createServer(built.app, { signingSecret: SECRET });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    await new Promise<void>((resolve) => bare.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    bareBase = `http://localhost:${(bare.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  });

  it("composes named workspace files into the delivery as attachments (the silent-drop bug)", async () => {
    await seedFile("U-carol", "outbox/report.md", "# hello Alice\n");
    const res = await post(
      base,
      "/v1/reach",
      { text: "here's the report", recipient: "Alice", files: ["outbox/report.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    const d = (await built.app.pendingDeliveries("principal")).find((x) => x.id === body.deliveryId);
    assert.ok(d, "delivery is in the principal queue");
    assert.equal(d!.attachments?.length, 1, "the named file rides the delivery as an attachment");
    const a = d!.attachments![0]!;
    assert.equal(a.name, "report.md");
    assert.ok(a.blobId, "attachment is blob-backed");
    assert.equal(a.sizeBytes, "# hello Alice\n".length);
    assert.ok(a.artifactId, "attachment is registered as a durable file artifact (blobs are TTL-swept)");
    const opened = await built.blobTransfer.open(a.blobId);
    assert.ok(opened);
    const chunks: Buffer[] = [];
    for await (const c of opened!.stream) chunks.push(c as Buffer);
    assert.equal(Buffer.concat(chunks).toString(), "# hello Alice\n");
  });

  it("is all-or-nothing: a missing path refuses the WHOLE call and enqueues nothing", async () => {
    const beforeCount = (await built.app.pendingDeliveries("principal")).length;
    const res = await post(
      base,
      "/v1/reach",
      { text: "doomed", recipient: "Alice", files: ["outbox/nope.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, "attach_failed");
    assert.match(body.message, /outbox\/nope\.md \(not found\)/);
    assert.match(body.message, /nothing was sent/);
    assert.equal(
      (await built.app.pendingDeliveries("principal")).length,
      beforeCount,
      "no text-only delivery leaked out",
    );
  });

  it("rolls back the good file's staging when a mixed list fails — no orphaned blob or artifact behind the 400", async () => {
    await seedFile("U-carol", "outbox/kept.md", "the good file\n");
    await built.blobTransfer.sweep(0);
    const res = await post(
      base,
      "/v1/reach",
      { text: "mixed", recipient: "Alice", files: ["outbox/kept.md", "outbox/gone.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, "attach_failed");
    assert.match(body.message, /outbox\/gone\.md \(not found\)/);
    assert.equal(await built.blobTransfer.sweep(0), 0, "no orphaned transfer blob for the good file");
    const owned = await built.files.listOwnedByScopes([scopeId("personal", "U-carol")]);
    assert.ok(!owned.files.some((f) => f.name === "kept.md"), "no orphaned artifact for the good file");
    await seedFile("U-carol", "outbox/kept2.md", "also good\n");
    const res2 = await post(
      base,
      "/v1/reach",
      { text: "mixed2", recipient: "Alice", files: ["outbox/gone.md", "outbox/kept2.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res2.status, 400);
    assert.equal(await built.blobTransfer.sweep(0), 0, "no orphaned transfer blob when the bad path comes first");
    const owned2 = await built.files.listOwnedByScopes([scopeId("personal", "U-carol")]);
    assert.ok(!owned2.files.some((f) => f.name === "kept2.md"), "no orphaned artifact when the bad path comes first");
  });

  it("resolves the target BEFORE staging files: a bad recipient refuses with nothing created", async () => {
    await seedFile("U-carol", "outbox/orphan.md", "would leak\n");
    const res = await post(
      base,
      "/v1/reach",
      { text: "to no one", recipient: "Nobody Realname", files: ["outbox/orphan.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as any).error, "recipient_not_found");
    const owned = await built.files.listOwnedByScopes([scopeId("personal", "U-carol")]);
    assert.ok(
      !owned.files.some((f) => f.name === "orphan.md"),
      "no artifact registered for a failed target resolution",
    );
  });

  it("rejects a malformed files field instead of ignoring it", async () => {
    const res = await post(
      base,
      "/v1/reach",
      { text: "x", recipient: "Alice", files: "outbox/report.md" },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).message, /files must be an array/);
    const res2 = await post(
      base,
      "/v1/reach",
      { text: "x", recipient: "Alice", files: [42] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res2.status, 400);
  });

  it("rejects a path that climbs out of the workspace (.. segments)", async () => {
    const res = await post(
      base,
      "/v1/reach",
      { text: "x", recipient: "Alice", files: ["../home-secret.txt"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).message, /no \.\. path segments/);
    const res2 = await post(
      base,
      "/v1/reach",
      { text: "x", recipient: "Alice", files: ["outbox/../../etc/passwd"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res2.status, 400);
  });

  it("rejects files on a react/delete (attachments compose into a text post only)", async () => {
    const res = await post(
      base,
      "/v1/reach",
      { react: { ts: "123.456", emoji: "tada" }, channel: "eng", files: ["outbox/report.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).message, /files compose into a text post/);
  });

  it("501s honestly when the server has no sandbox/blob store wired — never a lying 200", async () => {
    const res = await post(
      bareBase,
      "/v1/reach",
      { text: "x", recipient: "Alice", files: ["outbox/report.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 501);
    assert.equal(((await res.json()) as any).error, "not_configured");
  });

  it("a plain text-only reach still works unchanged", async () => {
    const res = await post(
      base,
      "/v1/reach",
      { text: "no files here", recipient: "Alice" },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    const d = (await built.app.pendingDeliveries("principal")).find((x) => x.id === body.deliveryId);
    assert.ok(d);
    assert.equal(d!.attachments, undefined);
  });
});

describe("reachEnqueue cross-scope delivery", () => {
  it("a delivery composed in one scope carries text AND attachments into another (person-keyed parity, §10)", async () => {
    const deliveries = createDeliveryStore();
    const d = await reachEnqueue({
      deliveries,
      destination: { type: "channel", target: "C-eng", audienceScopeId: scopeId("channel", "C-eng") },
      text: "composed output",
      attachments: [{ name: "report.txt", mimetype: "text/plain", sizeBytes: 6, blobId: "b1" }],
      idempotencyKey: "k-cross-scope",
    });
    assert.equal(d.text, "composed output");
    assert.equal(d.attachments?.length, 1, "attachments ride the delivery");
  });
});
