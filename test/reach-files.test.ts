import { installGlobalFakeSprites } from "./support/fake-sprites.ts";

const fakeSprites = installGlobalFakeSprites();
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildTestApp } from "./support/test-app.ts";
import { createServer } from "../src/api/server.ts";
import { recordingOutbound } from "./support/recording-outbound.ts";
import { reachPost } from "../src/reach/reach.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";

const SECRET = "reach-files-secret".repeat(3);

describe("POST /v1/reach with files", () => {
  let server: Server;
  let bare: Server;
  let noSandbox: Server;
  let base: string;
  let bareBase: string;
  let noSandboxBase: string;
  let built: ReturnType<typeof buildTestApp>;

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
    built = buildTestApp(testConfig({ signingSecret: SECRET }));
    await built.app.upsertDirectory([
      { principalId: "U-carol", displayName: "Carol", type: "internal" },
      { principalId: "U-alice", displayName: "Alice", type: "internal" },
    ]);
    await selectDefaultSandbox(built, "U-carol", scopeId("personal", "U-carol"));
    server = createServer(built.app, {
      signingSecret: SECRET,
      sandbox: built.sandbox,
      blobTransfer: built.blobTransfer,
      files: built.files,
      environments: built.environments,
      auditLog: built.auditLog,
      sandboxResources: built.sandboxResources,
    });
    bare = createServer(built.app, { signingSecret: SECRET });
    noSandbox = createServer(built.app, {
      signingSecret: SECRET,
      blobTransfer: built.blobTransfer,
      files: built.files,
      environments: built.environments,
    });
    await new Promise<void>((resolve) => noSandbox.listen(0, resolve));
    noSandboxBase = `http://localhost:${(noSandbox.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => server.listen(0, resolve));
    await new Promise<void>((resolve) => bare.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    bareBase = `http://localhost:${(bare.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => bare.close(() => resolve()));
    await new Promise<void>((resolve) => noSandbox.close(() => resolve()));
  });

  const storeFile = async (owner: string, name: string, data: string) => {
    const id = `file-${owner}-${name}-${Math.random().toString(36).slice(2)}`;
    await built.files.put({
      id,
      ownerScopeId: scopeId("personal", owner),
      createdBy: owner,
      name,
      path: `artifacts/${id}/${name}`,
      mimetype: "text/plain",
      data: Buffer.from(data),
      direction: "out",
    });
    return id;
  };

  const secondSandbox = async (actorId: string) => {
    const scope = scopeId("personal", actorId);
    const resources = built.sandboxResources.forTurn({ actorId, scopeId: scope, isCurrent: async () => true });
    return resources.create(actorId, scope, resources.defaultBackend());
  };

  const readDelivered = async () => {
    const d = (await built.posts.pending("principal")).at(-1);
    assert.ok(d?.attachments?.length);
    const out: string[] = [];
    for (const a of d!.attachments!) {
      const opened = await built.blobTransfer.open(a.blobId);
      const chunks: Buffer[] = [];
      for await (const c of opened!.stream) chunks.push(c as Buffer);
      out.push(`${a.name}:${Buffer.concat(chunks).toString()}`);
    }
    return out;
  };

  it("attaches a stored Files ID the sender can view", async () => {
    const id = await storeFile("U-carol", "stored.txt", "from Files\n");
    const res = await post(
      base,
      "/v1/reach",
      { text: "stored", recipient: "Alice", files: [{ file_id: id }] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await readDelivered(), ["stored.txt:from Files\n"]);
  });

  it("refuses a stored Files ID the sender cannot view, without revealing it", async () => {
    const id = await storeFile("U-alice", "private.txt", "alice only\n");
    const res = await post(
      base,
      "/v1/reach",
      { text: "steal", recipient: "Alice", files: [{ file_id: id }] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, "attach_failed");
    assert.doesNotMatch(body.message, /alice only/);
  });

  it("sends stored Files IDs on a server with no sandbox, but refuses workspace paths there", async () => {
    const id = await storeFile("U-carol", "nobox.txt", "no box\n");
    const ok = await post(
      noSandboxBase,
      "/v1/reach",
      { text: "stored only", recipient: "Alice", files: [{ file_id: id }], sandbox_id: "ignored" },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await readDelivered(), ["nobox.txt:no box\n"]);
    const refused = await post(
      noSandboxBase,
      "/v1/reach",
      { text: "path", recipient: "Alice", files: [{ file_id: id }, "reports/report.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(refused.status, 501);
  });

  it("rolls back a staged stored file when a later workspace path in the batch is missing", async () => {
    const id = await storeFile("U-carol", "staged.txt", "staged\n");
    await built.blobTransfer.sweep(0);
    const before = (await built.files.listOwnedByScopes([scopeId("personal", "U-carol")])).files.length;
    const res = await post(
      base,
      "/v1/reach",
      { text: "mixed", recipient: "Alice", files: [{ file_id: id }, "reports/absent.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).message, /reports\/absent\.md \(not found\)/);
    assert.equal(await built.blobTransfer.sweep(0), 0, "no orphaned transfer blob");
    assert.equal(
      (await built.files.listOwnedByScopes([scopeId("personal", "U-carol")])).files.length,
      before,
      "no orphaned outbound artifact",
    );
  });

  it("reads workspace paths from an explicitly named sandbox_id instead of the default", async () => {
    const extra = await secondSandbox("U-carol");
    const handle = await built.sandbox.provision(
      [{ scopeId: scopeId("personal", "U-carol"), mountPath: "", mode: "rw" }],
      { sandboxId: extra.id },
    );
    await built.sandbox.writeFile(handle, "only-here.md", "second box\n");
    await built.sandbox.teardown(handle, { keepWarm: true });
    const viaDefault = await post(
      base,
      "/v1/reach",
      { text: "default", recipient: "Alice", files: ["only-here.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(viaDefault.status, 400, "the default box doesn't have it");
    const res = await post(
      base,
      "/v1/reach",
      { text: "named", recipient: "Alice", files: ["only-here.md"], sandbox_id: extra.id },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await readDelivered(), ["only-here.md:second box\n"]);
  });

  it("refuses an unauthorized, unknown, or retired sandbox_id instead of falling back to the default", async () => {
    await seedFile("U-carol", "reports/fallback.md", "default box\n");
    const alices = await secondSandbox("U-alice");
    const retired = await secondSandbox("U-carol");
    await built.sandboxResources.retire("U-carol", retired.id);
    for (const sandbox_id of [alices.id, "no-such-sandbox", retired.id]) {
      const res = await post(
        base,
        "/v1/reach",
        { text: "x", recipient: "Alice", files: ["reports/fallback.md"], sandbox_id },
        { "x-agent-capability": await capDm("U-carol") },
      );
      assert.equal(res.status, 403, sandbox_id);
      assert.equal(((await res.json()) as any).error, "forbidden");
    }
    const access = built.sandboxResources.access;
    built.sandboxResources.access = async () => {
      throw new Error("record store unavailable");
    };
    try {
      const failed = await post(
        base,
        "/v1/reach",
        { text: "x", recipient: "Alice", files: ["reports/fallback.md"], sandbox_id: alices.id },
        { "x-agent-capability": await capDm("U-carol") },
      );
      assert.equal(failed.status, 500, "a store failure is not reported as an access denial");
    } finally {
      built.sandboxResources.access = access;
    }
    const malformed = await post(
      base,
      "/v1/reach",
      { text: "x", recipient: "Alice", files: ["reports/fallback.md"], sandbox_id: 7 },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(malformed.status, 400);
  });

  it("composes named workspace files into the delivery as attachments (the silent-drop bug)", async () => {
    await seedFile("U-carol", "reports/report.md", "# hello Alice\n");
    const res = await post(
      base,
      "/v1/reach",
      { text: "here's the report", recipient: "Alice", files: ["reports/report.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 200);
    const d = (await built.posts.pending("principal")).at(-1);
    assert.ok(d, "posted to the principal surface");
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
    const beforeCount = (await built.posts.pending("principal")).length;
    const res = await post(
      base,
      "/v1/reach",
      { text: "doomed", recipient: "Alice", files: ["reports/nope.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, "attach_failed");
    assert.match(body.message, /reports\/nope\.md \(not found\)/);
    assert.match(body.message, /nothing was sent/);
    assert.equal((await built.posts.pending("principal")).length, beforeCount, "no text-only delivery leaked out");
  });

  it("rolls back the good file's staging when a mixed list fails — no orphaned blob or artifact behind the 400", async () => {
    await seedFile("U-carol", "reports/kept.md", "the good file\n");
    await built.blobTransfer.sweep(0);
    const res = await post(
      base,
      "/v1/reach",
      { text: "mixed", recipient: "Alice", files: ["reports/kept.md", "reports/gone.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, "attach_failed");
    assert.match(body.message, /reports\/gone\.md \(not found\)/);
    assert.equal(await built.blobTransfer.sweep(0), 0, "no orphaned transfer blob for the good file");
    const owned = await built.files.listOwnedByScopes([scopeId("personal", "U-carol")]);
    assert.ok(!owned.files.some((f) => f.name === "kept.md"), "no orphaned artifact for the good file");
    await seedFile("U-carol", "reports/kept2.md", "also good\n");
    const res2 = await post(
      base,
      "/v1/reach",
      { text: "mixed2", recipient: "Alice", files: ["reports/gone.md", "reports/kept2.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res2.status, 400);
    assert.equal(await built.blobTransfer.sweep(0), 0, "no orphaned transfer blob when the bad path comes first");
    const owned2 = await built.files.listOwnedByScopes([scopeId("personal", "U-carol")]);
    assert.ok(!owned2.files.some((f) => f.name === "kept2.md"), "no orphaned artifact when the bad path comes first");
  });

  it("resolves the target BEFORE staging files: a bad recipient refuses with nothing created", async () => {
    await seedFile("U-carol", "reports/orphan.md", "would leak\n");
    const res = await post(
      base,
      "/v1/reach",
      { text: "to no one", recipient: "Nobody Realname", files: ["reports/orphan.md"] },
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
      { text: "x", recipient: "Alice", files: "reports/report.md" },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).message, /files must be/);
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
      { text: "x", recipient: "Alice", files: ["reports/../../etc/passwd"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res2.status, 400);
  });

  it("rejects files on a react/delete (attachments compose into a text post only)", async () => {
    const res = await post(
      base,
      "/v1/reach",
      { react: { ts: "123.456", emoji: "tada" }, channel: "eng", files: ["reports/report.md"] },
      { "x-agent-capability": await capDm("U-carol") },
    );
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).message, /files compose into a text post/);
  });

  it("501s honestly when the server has no sandbox/blob store wired — never a lying 200", async () => {
    const res = await post(
      bareBase,
      "/v1/reach",
      { text: "x", recipient: "Alice", files: ["reports/report.md"] },
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
    const d = (await built.posts.pending("principal")).at(-1);
    assert.ok(d);
    assert.equal(d!.text, "no files here");
    assert.equal(d!.attachments, undefined);
  });
});

describe("reachPost cross-scope delivery", () => {
  it("a delivery composed in one scope carries text AND attachments into another (person-keyed parity, §10)", async () => {
    const outbound = recordingOutbound();
    await reachPost({
      outbound,
      destination: { type: "slack", target: "C-eng", audienceScopeId: scopeId("channel", "C-eng") },
      text: "composed output",
      attachments: [{ name: "report.txt", mimetype: "text/plain", sizeBytes: 6, blobId: "b1" }],
      idempotencyKey: "k-cross-scope",
    });
    const d = outbound.posts.at(-1)!;
    assert.equal(d.text, "composed output");
    assert.equal(d.attachments?.length, 1, "attachments ride the delivery");
  });
});
