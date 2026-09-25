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

test("project files collapse across contributors and turns before paging owned and shared documents", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  const app = makeUploadApp(files, acl);
  const ledger: string[] = [];
  for (const [turn, author, documents] of [
    [1, "U1", [1, 2]],
    [2, "U2", [1, 2, 3, 4]],
    [3, "U2", [1, 2, 3, 4]],
  ] as const) {
    for (const document of documents) {
      const id = fileArtifactId(`turn-${turn}`, "out", document);
      const ownerScopeId = scopeId("personal", author);
      const path = `artifacts/${id}/document-${document}.txt`;
      await files.put({
        id,
        ownerScopeId,
        createdBy: author,
        path,
        name: `document-${document}.txt`,
        mimetype: "text/plain",
        data: Buffer.from(`document ${document}`),
        direction: "out",
        createdInScope: channel,
        createdAt: turn * 100,
      });
      await acl.grant({ ownerScopeId, ref: path, granteeScopeId: channel, permission: "read", grantedBy: author });
      ledger.push(id);
    }
  }
  for (const viewer of ["U1", "U2"]) {
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await app.listFilesForViewer(viewer, { limit: 2, ...(cursor ? { cursor } : {}) }, channel);
      assert.ok(page.owned.length + page.shared.length <= 2, "the page limit applies to the combined document list");
      pages.push(page);
      cursor = page.nextCursor;
      assert.ok(pages.length <= 2, "four documents require only two pages");
    } while (cursor);
    const owned = pages.flatMap((p) => p.owned);
    const all = pages.flatMap((p) => [...p.owned, ...p.shared]);
    assert.equal(all.length, 4);
    assert.equal(new Set(all.map((f) => f.name)).size, 4);
    assert.equal(owned.length, viewer === "U1" ? 2 : 4, "owned copies remain owned in the grouped listing");
    for (const file of all) assert.ok(await app.openFileForViewer(file.id, viewer));
  }
  for (const id of ledger) assert.ok(await files.get(id), "deduplication does not delete the artifact ledger");
  const stranger = await app.listFilesForViewer("U3", undefined, channel);
  assert.deepEqual([...stranger.owned, ...stranger.shared], []);
});

for (const authors of [["U1"], ["U2"], ["U1", "U2"]]) {
  test("scope resources drain file pages for " + authors.join(" and "), async () => {
    const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
    const acl = createAclStore();
    const app = makeUploadApp(files, acl);
    for (let n = 0; n < 55; n++) {
      for (const [index, author] of authors.entries()) {
        const ownerScopeId = scopeId("personal", author);
        const id = fileArtifactId("many-" + author, "out", n);
        const path = "artifacts/" + id + "/file.txt";
        await files.put({
          id,
          path,
          ownerScopeId,
          createdBy: author,
          name: "file.txt",
          mimetype: "text/plain",
          data: Buffer.from(author + ":" + n),
          direction: "out",
          createdInScope: channel,
          createdAt: n * 2 + index,
        });
        await acl.grant({ ownerScopeId, ref: path, granteeScopeId: channel, permission: "read", grantedBy: author });
      }
    }
    const resources = await app.listScopeResources("U1", channel);
    assert.equal(resources?.files.length, 55 * authors.length);
    assert.equal(new Set(resources?.files.map((file) => file.id)).size, 55 * authors.length);
    for (const author of authors)
      assert.equal(resources?.files.filter((file) => file.ownerScopeId === scopeId("personal", author)).length, 55);
  });
}
