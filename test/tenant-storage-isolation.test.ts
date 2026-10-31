import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import {
  collectBlob,
  createLocalBlobTransferStore,
  createMemoryBlobTransferStore,
  createS3BlobTransferStore,
  type BlobTransferStore,
} from "../src/persistence/blob-transfer.ts";
import {
  createLocalDurableByteStore,
  createMemoryDurableByteStore,
  createS3DurableByteStore,
  type DurableByteStore,
} from "../src/files/durable-byte-store.ts";
import { createMemorySnapshotStore, createS3SnapshotStore } from "../src/sandbox/home-snapshot.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { migrateDir, migrateObjects, renameScopes, rootScopeRenames } from "../src/tenants/storage-migration.ts";
import { scopeStorageKey } from "../cli/src/scope-storage-key.ts";
import { validateCoreSecretEnv } from "../src/deployment/secret-schema.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function fakeS3() {
  const objects = new Map<string, { body: Buffer; at: Date }>();
  const parts = new Map<string, Buffer[]>();
  const client = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof CreateMultipartUploadCommand) {
        parts.set(command.input.Key!, []);
        return { UploadId: command.input.Key };
      }
      if (command instanceof UploadPartCommand) {
        const body = command.input.Body;
        const chunk = Buffer.isBuffer(body) ? body : await collectBlob(body as Readable);
        parts.get(command.input.UploadId!)!.push(chunk);
        return { ETag: String(command.input.PartNumber) };
      }
      if (command instanceof CompleteMultipartUploadCommand) {
        objects.set(command.input.Key!, { body: Buffer.concat(parts.get(command.input.UploadId!)!), at: new Date() });
        return {};
      }
      if (command instanceof PutObjectCommand) {
        const body = command.input.Body;
        objects.set(command.input.Key!, {
          body: Buffer.isBuffer(body) ? body : Buffer.from(body as Uint8Array),
          at: new Date(),
        });
        return {};
      }
      if (command instanceof GetObjectCommand || command instanceof HeadObjectCommand) {
        const hit = objects.get(command.input.Key!);
        if (!hit) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return command instanceof HeadObjectCommand
          ? { LastModified: hit.at }
          : { Body: Readable.from(hit.body), ContentLength: hit.body.length };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key!);
        return {};
      }
      if (command instanceof CopyObjectCommand) {
        const source = decodeURIComponent(command.input.CopySource!.split("/").slice(1).join("/"));
        objects.set(command.input.Key!, { ...objects.get(source)!, at: new Date() });
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? "";
        const matching = [...objects].filter(([key]) => key.startsWith(prefix));
        const folder = (key: string): string | null => {
          const at = command.input.Delimiter ? key.indexOf(command.input.Delimiter, prefix.length) : -1;
          return at < 0 ? null : key.slice(0, at + 1);
        };
        const Contents = matching
          .filter(([key]) => folder(key) === null)
          .map(([Key, v]) => ({ Key, Size: v.body.length, LastModified: v.at }));
        const CommonPrefixes = [...new Set(matching.map(([key]) => folder(key)).filter((f) => f !== null))].map(
          (Prefix) => ({ Prefix }),
        );
        return { Contents, CommonPrefixes };
      }
      throw new Error(`unexpected ${(command as object).constructor.name}`);
    },
  };
  return { client, objects };
}

async function text(store: BlobTransferStore, id: string): Promise<string | null> {
  const opened = await store.open(id);
  return opened ? (await collectBlob(opened.stream)).toString("utf8") : null;
}

async function bytes(store: DurableByteStore, key: string): Promise<string | null> {
  const opened = await store.open(key);
  return opened ? (await collectBlob(opened.stream)).toString("utf8") : null;
}

for (const [label, make] of [
  ["local", () => createLocalBlobTransferStore(mkdtempSync(join(tmpdir(), "qm-transfer-")))],
  ["memory", () => createMemoryBlobTransferStore()],
  ["s3", () => createS3BlobTransferStore({ bucket: "b", prefix: "p/", _client: fakeS3().client })],
] as const) {
  test(`${label} blob transfer: another tenant cannot open or delete a blob even with its id`, async () => {
    const store = make();
    const { blobId } = await withTenant(A, () => store.put(Buffer.from("tenant a")));
    assert.equal(await withTenant(B, () => text(store, blobId)), null);
    await withTenant(B, () => store.delete(blobId));
    assert.equal(await withTenant(A, () => text(store, blobId)), "tenant a");
    await assert.rejects(() => withoutTenant(() => store.put(Buffer.from("unbound"))), /No tenant is bound/);
  });
}

test("S3 blob transfer keys carry the tenant and the sweep spans every tenant", async () => {
  const s3 = fakeS3();
  const store = createS3BlobTransferStore({ bucket: "b", prefix: "p/", _client: s3.client });
  const a = await withTenant(A, () => store.put(Buffer.from("a")));
  const b = await withTenant(B, () => store.put(Buffer.from("b")));
  assert.deepEqual([...s3.objects.keys()].sort(), [`p/transfer/${A}/${a.blobId}`, `p/transfer/${B}/${b.blobId}`]);
  assert.equal(await store.sweep(-1), 2);
});

for (const [label, make] of [
  ["local", () => createLocalDurableByteStore(mkdtempSync(join(tmpdir(), "qm-docstore-")))],
  ["memory", () => createMemoryDurableByteStore()],
  ["s3", () => createS3DurableByteStore({ bucket: "b", area: "session-shares", _client: fakeS3().client })],
] as const) {
  test(`${label} durable bytes: content-hash keys do not cross tenants`, async () => {
    const store = make();
    const put = await withTenant(A, () => store.put(Buffer.from("shared share bytes")));
    assert.equal(await withTenant(B, () => bytes(store, put.blobKey)), null);
    await withTenant(B, () => store.put(Buffer.from("shared share bytes")));
    await withTenant(B, () => store.delete(put.blobKey));
    assert.equal(await withTenant(A, () => bytes(store, put.blobKey)), "shared share bytes");
    await assert.rejects(() => withoutTenant(() => store.open(put.blobKey)), /No tenant is bound/);
  });
}

test("S3 durable bytes live under <prefix><area>/<tenant>/", async () => {
  const s3 = fakeS3();
  const store = createS3DurableByteStore({ bucket: "b", prefix: "p/", area: "docstore", _client: s3.client });
  const put = await withTenant(A, () => store.put(Buffer.alloc(0)));
  assert.deepEqual([...s3.objects.keys()], [`p/docstore/${A}/${put.blobKey}`]);
});

test("home snapshots: another tenant cannot open a snapshot for the same scope", async () => {
  const s3 = fakeS3();
  for (const store of [
    createMemorySnapshotStore(),
    createS3SnapshotStore({ bucket: "b", prefix: "modal-home", s3: s3.client }),
  ]) {
    await withTenant(A, () => store.put("personal:alice@example.com", Buffer.from("home")));
    assert.equal(await withTenant(B, () => store.open("personal:alice@example.com")), null);
    assert.ok(await withTenant(A, () => store.open("personal:alice@example.com")));
  }
  assert.deepEqual([...s3.objects.keys()], [`modal-home/${A}/personal%3Aalice%40example.com.tar`]);
});

test("provider names differ per tenant for the same scope and keep the deployment prefix", () => {
  for (const prefix of ["qm", "qm-scratch", "a-very-long-deployment-prefix-that-eats-the-budget"]) {
    const a = withTenant(A, () => sandboxScopeName(prefix, "personal:alice@example.com"));
    const b = withTenant(B, () => sandboxScopeName(prefix, "personal:alice@example.com"));
    assert.notEqual(a, b);
    for (const name of [a, b]) {
      assert.ok(name.length <= 63, name);
      assert.match(name, /^[a-z0-9-]+$/);
      assert.ok(name.startsWith(prefix.slice(0, 20)));
    }
  }
  assert.throws(() => withoutTenant(() => sandboxScopeName("qm", "x")), /No tenant is bound/);
});

test("workspace directories are tenant-scoped", async () => {
  const store = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "qm-ws-")));
  await withTenant(A, () => store.write("personal:alice@example.com", "notes.md", "a"));
  assert.equal(await withTenant(B, () => store.read("personal:alice@example.com", "notes.md")), null);
  assert.equal(await withTenant(A, () => store.read("personal:alice@example.com", "notes.md")), "a");
});

test("storage migration moves legacy objects under the only tenant and keeps existing tenant copies", async () => {
  const s3 = fakeS3();
  s3.objects.set("p/files/abc", { body: Buffer.from("file"), at: new Date(1) });
  s3.objects.set("p/files/uploads/0123", { body: Buffer.from("upload"), at: new Date(1) });
  s3.objects.set("modal-home/personal%3Aa.tar", { body: Buffer.from("old"), at: new Date(1) });
  s3.objects.set("modal-home/personal%3Ab.tar", { body: Buffer.from("legacy"), at: new Date(1) });
  s3.objects.set("deploy-data/0123/litestream/generations/x", { body: Buffer.from("wal"), at: new Date(1) });
  s3.objects.set(`modal-home/${A}/personal%3Aa.tar`, { body: Buffer.from("new"), at: new Date(2) });
  const tenants = new Set([A]);
  const docstore = { client: s3.client, bucket: "b", from: "p/files/", to: "p/docstore/", under: "files/" };
  const homes = { client: s3.client, bucket: "b", from: "modal-home/", to: "modal-home/" };
  assert.equal(await migrateObjects(docstore, tenants), 2);
  const data = { client: s3.client, bucket: "b", from: "deploy-data/", to: "deploy-data/" };
  assert.equal(await migrateObjects(homes, tenants), 2);
  assert.equal(await migrateObjects(data, tenants), 1);
  assert.deepEqual([...s3.objects.keys()].sort(), [
    `deploy-data/${A}/0123/litestream/generations/x`,
    `modal-home/${A}/personal%3Aa.tar`,
    `modal-home/${A}/personal%3Ab.tar`,
    `p/docstore/${A}/files/abc`,
    `p/docstore/${A}/files/uploads/0123`,
  ]);
  assert.equal(s3.objects.get(`modal-home/${A}/personal%3Aa.tar`)!.body.toString(), "new");
  assert.equal(await migrateObjects(homes, tenants), 0);
  assert.equal(await migrateObjects(data, tenants), 0);
});

test("storage migration refuses legacy data when the owner is ambiguous", async () => {
  const s3 = fakeS3();
  s3.objects.set("transfer/0123", { body: Buffer.from("x"), at: new Date() });
  const area = { client: s3.client, bucket: "b", from: "transfer/", to: "transfer/" };
  await assert.rejects(() => migrateObjects(area, new Set([A, B])), /predates tenant storage/);
  const root = mkdtempSync(join(tmpdir(), "qm-migrate-"));
  mkdirSync(join(root, "personal__alice"));
  await assert.rejects(() => migrateDir(root, new Set([A, B])), /predates tenant storage/);
});

test("storage migration merges legacy directories into the tenant directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "qm-migrate-"));
  mkdirSync(join(root, "files"));
  writeFileSync(join(root, "files", "abc"), "legacy");
  mkdirSync(join(root, A, "files"), { recursive: true });
  writeFileSync(join(root, A, "files", "def"), "current");
  assert.equal(await migrateDir(root, new Set([A])), 1);
  assert.equal(readFileSync(join(root, A, "files", "abc"), "utf8"), "legacy");
  assert.equal(readFileSync(join(root, A, "files", "def"), "utf8"), "current");
  assert.equal(existsSync(join(root, "files")), false);
});

test("the root scope rename moves the old org's workspace and home snapshot to the tenant's org scope", async () => {
  const s3 = fakeS3();
  const homes = { client: s3.client, bucket: "b", from: "modal-home/", to: "modal-home/" };
  s3.objects.set(`modal-home/${A}/org%3Aacme.tar`, { body: Buffer.from("home"), at: new Date(1) });
  s3.objects.set(`modal-home/${A}/personal%3Aa.tar`, { body: Buffer.from("mine"), at: new Date(1) });
  const root = mkdtempSync(join(tmpdir(), "qm-rename-"));
  mkdirSync(join(root, A, scopeStorageKey("org:acme")), { recursive: true });
  writeFileSync(join(root, A, scopeStorageKey("org:acme"), "notes.md"), "kept");
  const areas = { objects: [homes], dirs: [root] };
  assert.equal(await renameScopes(areas, A, rootScopeRenames("acme", A)), 2);
  assert.deepEqual([...s3.objects.keys()].sort(), [
    `modal-home/${A}/${encodeURIComponent(`org:${A}`)}.tar`,
    `modal-home/${A}/personal%3Aa.tar`,
  ]);
  assert.equal(readFileSync(join(root, A, scopeStorageKey(`org:${A}`), "notes.md"), "utf8"), "kept");
  assert.equal(existsSync(join(root, A, scopeStorageKey("org:acme"))), false);
  assert.equal(await renameScopes(areas, A, rootScopeRenames("acme", A)), 0);
  assert.equal(await renameScopes(areas, B, rootScopeRenames("acme", B)), 0);
});

test("deployment-wide sandbox secrets refuse to load", () => {
  assert.throws(() => validateCoreSecretEnv({ FLY_RESIDENT_ENV_GH_TOKEN: "x" }), /every tenant's computers/);
});
