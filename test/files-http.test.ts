import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, type AppDeps } from "../src/api/app.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import {
  createMemoryFileArtifactStore,
  fileArtifactId,
  type FileArtifactStore,
} from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { scopeId } from "../src/types.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";

const ORG = "default-org";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);
const channel = scopeId("channel", "C1");

function makeApp(files: FileArtifactStore, acl: ReturnType<typeof createAclStore>) {
  return createApp({ acl, files, identity: createIdentityService() } as unknown as AppDeps);
}

function makeUploadApp(files: FileArtifactStore, acl: ReturnType<typeof createAclStore>) {
  const identity = {
    classify: (id: string) => ({ id, type: "internal" }),
    isInternal: (p: { type: string }) => p.type === "internal",
  };
  const directory = {
    listChannelsFor: async (principalId: string) =>
      principalId === "U1" || principalId === "U2" ? [{ channelId: "C1", name: "eng", isPrivate: true }] : [],
    channelMember: async (channelId: string, principalId: string) =>
      channelId === "C1" && (principalId === "U1" || principalId === "U2"),
  };
  const sessions = { listByParticipant: async (_p: string) => [] };
  const auditLog = { record: () => undefined };
  const crons = { list: async () => [] };
  const webhooks = { list: async () => [] };
  const skills = { list: async () => [] };
  const deploy = { listDeployments: async () => [] };
  return createApp({
    acl,
    files,
    identity,
    directory,
    sessions,
    auditLog,
    crons,
    webhooks,
    skills,
    deploy,
  } as unknown as AppDeps);
}

async function* chunks(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

test("owner sees their own file in owned[] and can open its bytes", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const app = makeApp(files, createAclStore());
  const id = fileArtifactId("run-1", "out", 0);
  await files.put({
    id,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    name: "flag.png",
    path: `artifacts/${id}/flag.png`,
    mimetype: "image/png",
    data: PNG,
    direction: "out",
  });

  const page = await app.listFilesForViewer("U1");
  assert.equal(page.owned.length, 1);
  assert.equal(page.owned[0]!.name, "flag.png");
  assert.equal(page.owned[0]!.openable, true);
  assert.equal(page.shared.length, 0);

  const opened = await app.openFileForViewer(id, "U1");
  assert.ok(opened);
  assert.deepEqual(await drain(opened!.stream), PNG);
});

test("a grantee sees a shared file in shared[] and can open it; the owner doesn't double-list it", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  const app = makeApp(files, acl);
  const owner = scopeId("personal", "U1");
  const id = fileArtifactId("share", "out", 0);
  await files.put({
    id,
    ownerScopeId: owner,
    createdBy: "U1",
    name: "redline.md",
    path: "redline.md",
    mimetype: "text/markdown",
    data: Buffer.from("v1"),
    direction: "out",
  });
  await acl.grant({
    ownerScopeId: owner,
    ref: "redline.md",
    granteeScopeId: scopeId("personal", "U2"),
    permission: "read",
    grantedBy: "U1",
  });

  const u2 = await app.listFilesForViewer("U2");
  assert.equal(u2.owned.length, 0, "U2 doesn't own it");
  assert.equal(u2.shared.length, 1, "U2 sees it as shared");
  assert.equal(u2.shared[0]!.id, id);
  assert.equal(u2.shared[0]!.ownerScopeId, owner, "shared rows retain their provenance for an accurate UI label");

  const opened = await app.openFileForViewer(id, "U2");
  assert.ok(opened, "the grant authorizes the bytes");
  assert.deepEqual(await drain(opened!.stream), Buffer.from("v1"));
});

test("a stranger sees nothing and cannot open the file (404 = null)", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const app = makeApp(files, createAclStore());
  const id = fileArtifactId("run-1", "out", 0);
  await files.put({
    id,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    name: "secret.png",
    path: "secret.png",
    mimetype: "image/png",
    data: PNG,
    direction: "out",
  });

  const page = await app.listFilesForViewer("U3");
  assert.equal(page.owned.length, 0);
  assert.equal(page.shared.length, 0);
  assert.equal(await app.openFileForViewer(id, "U3"), null, "not-authorized is indistinguishable from not-found");
});

test("an org grant surfaces the file to any org member", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  const app = makeApp(files, acl);
  const owner = scopeId("personal", "U1");
  const id = fileArtifactId("orgshare", "out", 0);
  await files.put({
    id,
    ownerScopeId: owner,
    createdBy: "U1",
    name: "poster.png",
    path: "poster.png",
    mimetype: "image/png",
    data: PNG,
    direction: "out",
  });
  await acl.grant({
    ownerScopeId: owner,
    ref: "poster.png",
    granteeScopeId: scopeId("org", ORG),
    permission: "read",
    grantedBy: "U1",
  });

  const page = await app.listFilesForViewer("U9");
  assert.equal(page.shared.length, 1, "any org member sees an org-granted file");
  assert.ok(await app.openFileForViewer(id, "U9"));
});

test("openFileForViewer returns null when the bytes are gone (a backfilled history row)", async () => {
  const owner = scopeId("personal", "U1");
  const id = "backfill-1";
  const row = {
    id,
    ownerScopeId: owner,
    createdBy: "U1",
    name: "old.png",
    path: "old.png",
    mimetype: "image/png",
    sizeBytes: 10,
    blobKey: null,
    sha256: null,
    direction: "out" as const,
    source: "backfill" as const,
    createdAt: 1,
    updatedAt: 1,
    enabled: true,
  };
  const files = {
    get: async () => row,
    open: async () => null,
  } as unknown as FileArtifactStore;
  const app = makeApp(files, createAclStore());

  assert.equal(await app.openFileForViewer(id, "U1"), null, "owner is authorized but the bytes are unavailable → 404");
});

test("uploadFileForViewer stores a personal inbound file", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const app = makeUploadApp(files, createAclStore());

  const file = await app.uploadFileForViewer("U1", {
    name: "../notes.txt",
    mimetype: "text/plain",
    data: chunks(Buffer.from("hello")),
  });
  assert.ok(file);
  assert.equal(file!.name, "notes.txt");
  assert.equal(file!.direction, "in");
  assert.equal(file!.createdInScope, scopeId("personal", "U1"));

  const page = await app.listFilesForViewer("U1");
  assert.deepEqual(
    page.owned.map((f) => f.id),
    [file!.id],
  );
  assert.deepEqual(await drain((await app.openFileForViewer(file!.id, "U1"))!.stream), Buffer.from("hello"));
});

test("uploadFileForViewer to a shared context is visible to another context member", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  const app = makeUploadApp(files, acl);

  const file = await app.uploadFileForViewer("U1", {
    scopeId: channel,
    name: "brief.pdf",
    mimetype: "application/pdf",
    data: chunks(PNG),
  });
  assert.ok(file);
  assert.equal(file!.createdInScope, channel);
  const grants = await acl.grantsFor(scopeId("personal", "U1"), `artifacts/${file!.id}/brief.pdf`);
  assert.equal(
    grants.some((g) => g.granteeScopeId === channel),
    true,
  );

  const context = await app.listScopeResources("U2", channel);
  assert.deepEqual(
    context?.files.map((f) => f.name),
    ["brief.pdf"],
  );
  assert.deepEqual(await drain((await app.openFileForViewer(file!.id, "U2"))!.stream), PNG);
});

test("scoped file listing pages within the requested context", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const app = makeUploadApp(files, createAclStore());
  await app.uploadFileForViewer("U1", {
    name: "personal.txt",
    mimetype: "text/plain",
    data: chunks(Buffer.from("personal")),
  });
  const shared = await app.uploadFileForViewer("U1", {
    scopeId: channel,
    name: "channel.txt",
    mimetype: "text/plain",
    data: chunks(Buffer.from("channel")),
  });

  const page = await app.listFilesForViewer("U1", { limit: 1 }, channel);
  assert.deepEqual(
    page.owned.map((file) => file.id),
    [shared!.id],
  );
  assert.equal(page.nextCursor, undefined, "unrelated files do not create a misleading next page");
});
