import { test } from "node:test";
import assert from "node:assert/strict";
import { collectOutbound, materializeInbound, type ArtifactRegistration } from "../src/core/attachments.ts";
import { createToolContext } from "../src/tools/primitives.ts";
import { createMemoryFileArtifactStore, type FileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeId } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const owner = scopeId("channel", "C1");
const HANDLE = { id: "h", rootDir: "/workspace" } as SandboxHandle;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);

function memSandbox(seed: Record<string, Uint8Array | string> = {}): {
  sandbox: Sandbox;
  files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(seed)) files.set(k, typeof v === "string" ? Buffer.from(v) : v);
  const sandbox = {
    async listDir(_h: SandboxHandle, dir: string) {
      return [...files.keys()].filter((k) => k === dir || k.startsWith(`${dir}/`));
    },
    async readFileBytes(_h: SandboxHandle, rel: string) {
      return files.get(rel) ?? null;
    },
    async writeFileBytes(_h: SandboxHandle, rel: string, data: Uint8Array) {
      files.set(rel, data);
    },
    async writeFile(_h: SandboxHandle, rel: string, data: string) {
      files.set(rel, Buffer.from(data));
    },
    async readFile(_h: SandboxHandle, rel: string) {
      const b = files.get(rel);
      return b ? Buffer.from(b).toString("utf8") : null;
    },
  } as unknown as Sandbox;
  return { sandbox, files };
}

function reg(store: FileArtifactStore, over: Partial<ArtifactRegistration> = {}): ArtifactRegistration {
  return { store, ownerScopeId: owner, createdBy: "U1", createdInScope: owner, seed: "run-1", ...over };
}

async function drain(store: FileArtifactStore, id: string): Promise<Buffer> {
  const o = await store.open(id);
  assert.ok(o, "expected openable bytes");
  const chunks: Buffer[] = [];
  for await (const c of o!.stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

test("collectOutbound registers an 'out' artifact at the registration owner, openable", async () => {
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const { sandbox } = memSandbox({ "outbox/flag.png": PNG });

  const out = await collectOutbound(sandbox, HANDLE, createMemoryBlobTransferStore(), reg(store));
  assert.equal(out.attachments.length, 1, "the file is still delivered");

  const page = await store.listOwnedByScopes([owner]);
  assert.equal(page.files.length, 1);
  const a = page.files[0]!;
  assert.equal(out.attachments[0]!.artifactId, a.id, "delivery attachment points at its durable artifact");
  assert.equal(out.attachments[0]!.artifactViewerId, "U1", "surface replay can re-open as the creator");
  assert.equal(a.direction, "out");
  assert.equal(a.ownerScopeId, owner);
  assert.equal(a.name, "flag.png");
  assert.deepEqual(await drain(store, a.id), PNG, "bytes captured into the doc store");
});

test("collectOutbound is idempotent on re-run with the same seed (G6 requeue: no dup row)", async () => {
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const { sandbox } = memSandbox({ "outbox/a.txt": "one", "outbox/b.txt": "two" });

  await collectOutbound(sandbox, HANDLE, createMemoryBlobTransferStore(), reg(store));
  await collectOutbound(sandbox, HANDLE, createMemoryBlobTransferStore(), reg(store));
  assert.equal((await store.listOwnedByScopes([owner])).files.length, 2, "two files, not four");
});

test("a doc-store fault does NOT break delivery (best-effort registration)", async () => {
  const throwing = {
    put: async () => {
      throw new Error("doc store down");
    },
  } as unknown as FileArtifactStore;
  const { sandbox } = memSandbox({ "outbox/report.csv": "a,b,c" });
  const errors: unknown[] = [];

  const out = await collectOutbound(
    sandbox,
    HANDLE,
    createMemoryBlobTransferStore(),
    reg(throwing, { onError: (e) => errors.push(e) }),
  );
  assert.equal(out.attachments.length, 1, "delivery still succeeds despite the store fault");
  assert.equal(errors.length, 1, "the fault is reported, not swallowed silently");
});

test("materializeInbound registers an 'in' artifact, openable", async () => {
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const transfer = createMemoryBlobTransferStore();
  const { blobId } = await transfer.put(PNG);
  const { sandbox } = memSandbox();

  const inb = await materializeInbound(
    sandbox,
    HANDLE,
    [{ name: "shared.png", mimetype: "image/png", sizeBytes: PNG.length, blobId }],
    transfer,
    reg(store),
  );
  assert.equal(inb.metas.length, 1);

  const page = await store.listOwnedByScopes([owner]);
  assert.equal(page.files.length, 1);
  assert.equal(page.files[0]!.direction, "in");
  assert.deepEqual(await drain(store, page.files[0]!.id), PNG);
  assert.equal(
    inb.metas[0]!.artifactId,
    page.files[0]!.id,
    "the persisted meta points at its durable artifact (surfaces re-render from it)",
  );
  assert.equal(
    inb.images[0]!.artifactId,
    page.files[0]!.id,
    "the exact model image carries the same durable ref for tape replay",
  );
});

test("materializeInbound omits artifactId when registration fails or is absent", async () => {
  const transfer = createMemoryBlobTransferStore();
  const { blobId } = await transfer.put(PNG);
  const { sandbox } = memSandbox();
  const noReg = await materializeInbound(
    sandbox,
    HANDLE,
    [{ name: "a.png", mimetype: "image/png", sizeBytes: PNG.length, blobId }],
    transfer,
  );
  assert.equal(noReg.metas[0]!.artifactId, undefined);

  const throwing = {
    put: async () => {
      throw new Error("doc store down");
    },
  } as unknown as FileArtifactStore;
  const { blobId: blob2 } = await transfer.put(PNG);
  const errors: unknown[] = [];
  const failed = await materializeInbound(
    sandbox,
    HANDLE,
    [{ name: "b.png", mimetype: "image/png", sizeBytes: PNG.length, blobId: blob2 }],
    transfer,
    reg(throwing, { onError: (e) => errors.push(e) }),
  );
  assert.equal(failed.metas.length, 1, "the file still reaches the inbox");
  assert.equal(failed.metas[0]!.artifactId, undefined, "no artifactId is fabricated on a store fault");
  assert.equal(errors.length, 1);
});

test("write+share registers an artifact keyed on the SAME (owner, path) as the grant", async () => {
  const store = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "popshare-")));
  const grantee = scopeId("personal", "U2");
  const { sandbox } = memSandbox({ "redline.md": "v1 redline" });

  const ctx = createToolContext({
    sandbox,
    provision: async () => HANDLE,
    layers: [{ scopeId: owner, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace,
    deploy: {} as never,
    acl,
    files: store,
    createdBy: "U1",
    persistWritesToStore: { excludeDirs: ["inbox", "outbox"] },
  });

  await ctx.write("redline.md", undefined, [{ scope: grantee, permission: "read" }]);

  assert.equal((await acl.grantsFor(owner, "redline.md")).length, 1);
  const shared = await store.resolveByOwnerPaths([{ ownerScopeId: owner, path: "redline.md" }]);
  assert.equal(shared.length, 1);
  assert.equal(shared[0]!.name, "redline.md");
  assert.deepEqual(await drain(store, shared[0]!.id), Buffer.from("v1 redline"));
});
