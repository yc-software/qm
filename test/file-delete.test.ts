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
import { scopeId, type ScopeId } from "../src/types.ts";
import { orgId } from "../src/config.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x7f]);
const channel = scopeId("channel", "C1");
const publicChannel = scopeId("channel", "C2");
const org = scopeId("org", orgId());

interface AuditRecord {
  principalId: string;
  action: string;
  resource: string;
  scopeLabel?: string;
}

function makeApp(
  files: FileArtifactStore,
  acl: ReturnType<typeof createAclStore>,
  extra: {
    audit?: AuditRecord[];
    channelPrivacy?: (channelId: string) => Promise<boolean | undefined>;
    channels?: Array<{ channelId: string; name: string; isPrivate: boolean }>;
    sessionScopes?: ScopeId[];
  } = {},
) {
  const identity = {
    classify: (id: string) => ({ id, type: "internal" }),
    isInternal: (p: { type: string }) => p.type === "internal",
  };
  const directory = {
    listChannelsFor: async (principalId: string) =>
      principalId === "U1" || principalId === "U2"
        ? (extra.channels ?? [{ channelId: "C1", name: "eng", isPrivate: true }])
        : [],
    channelMember: async (channelId: string, principalId: string) =>
      channelId === "C1" && (principalId === "U1" || principalId === "U2"),
    ...(extra.channelPrivacy ? { channelPrivacy: extra.channelPrivacy } : {}),
  };
  const auditLog = { record: (r: AuditRecord) => void extra.audit?.push(r) };
  return createApp({
    acl,
    files,
    identity,
    directory,
    sessions: { listByParticipant: async () => (extra.sessionScopes ?? []).map((scope) => ({ scopeId: scope })) },
    auditLog,
    crons: { list: async () => [] },
    webhooks: { list: async () => [] },
    skills: { list: async () => [] },
    deploy: { listDeployments: async () => [] },
  } as unknown as AppDeps);
}

function seed(files: FileArtifactStore, id: string, owner: string, ownerScopeId = scopeId("personal", owner)) {
  return files.put({
    id,
    ownerScopeId,
    createdBy: owner,
    name: `${id}.png`,
    path: `artifacts/${id}/${id}.png`,
    mimetype: "image/png",
    data: PNG,
    direction: "out",
  });
}

test("the owner deletes their file: it disappears from every listing, stops opening, and is audited once", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const audit: AuditRecord[] = [];
  const app = makeApp(files, createAclStore(), { audit });
  const id = fileArtifactId("own", "out", 0);
  await seed(files, id, "U1");

  assert.equal(await app.deleteFileForViewer(id, "U1"), "deleted");

  const page = await app.listFilesForViewer("U1");
  assert.deepEqual([...page.owned, ...page.shared], []);
  assert.equal(await app.openFileForViewer(id, "U1"), null);
  const deletes = audit.filter((r) => r.action === "file.delete");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0]!.principalId, "U1");
  assert.equal(deletes[0]!.resource, `artifacts/${id}/${id}.png`);
  assert.equal(deletes[0]!.scopeLabel, scopeId("personal", "U1"));
});

test("a read grant does not authorize a delete", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const acl = createAclStore();
  const app = makeApp(files, acl);
  const id = fileArtifactId("shared", "out", 0);
  const { artifact } = await seed(files, id, "U1");
  await acl.grant({
    ownerScopeId: artifact.ownerScopeId,
    ref: artifact.path,
    granteeScopeId: scopeId("personal", "U2"),
    permission: "read",
    grantedBy: "U1",
  });

  const shareeView = await app.listFilesForViewer("U2");
  assert.equal(shareeView.shared.length, 1);
  assert.equal(shareeView.shared[0]!.deletable, false, "a read grantee gets no Delete button");
  assert.equal(await app.deleteFileForViewer(id, "U2"), "forbidden");

  assert.equal((await app.listFilesForViewer("U1")).owned.length, 1, "the owner's file survives");
  assert.ok(await app.openFileForViewer(id, "U1"));
});

test("an org-scope artifact lands in every member's owned[] but is neither deletable nor deleted", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const app = makeApp(files, createAclStore());
  const id = fileArtifactId("orgwide", "out", 0);
  await seed(files, id, "operator", org);

  const page = await app.listFilesForViewer("U1");
  assert.deepEqual(
    page.owned.map((f) => f.id),
    [id],
    "the org scope is in every internal viewer's resource scopes",
  );
  assert.equal(page.owned[0]!.deletable, false);
  assert.equal(await app.deleteFileForViewer(id, "U1"), "forbidden");
  assert.ok(await files.get(id), "a refused delete leaves the row alone");
});

test("deleting is idempotent: an unknown id and a second delete both answer not_found without throwing", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const app = makeApp(files, createAclStore());
  const id = fileArtifactId("twice", "out", 0);
  await seed(files, id, "U1");

  assert.equal(await app.deleteFileForViewer("no-such-file", "U1"), "not_found");
  assert.equal(await app.deleteFileForViewer(id, "U1"), "deleted");
  assert.equal(await app.deleteFileForViewer(id, "U1"), "not_found");
});

test("deleting one of two identical-byte artifacts leaves the other readable", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const app = makeApp(files, createAclStore());
  const mine = fileArtifactId("copy-mine", "out", 0);
  const theirs = fileArtifactId("copy-theirs", "out", 0);
  await seed(files, mine, "U1");
  await seed(files, theirs, "U2");
  assert.equal((await files.get(mine))!.blobKey, (await files.get(theirs))!.blobKey, "identical bytes share a key");

  assert.equal(await app.deleteFileForViewer(mine, "U1"), "deleted");

  const survivor = await app.openFileForViewer(theirs, "U2");
  assert.ok(survivor);
  const read: Buffer[] = [];
  for await (const c of survivor!.stream) read.push(c as Buffer);
  assert.deepEqual(
    Buffer.concat(read),
    PNG,
    "erasing shared bytes would break every artifact with the same digest",
  );
});

test("deletable is computed once per (ownerScopeId, authorship) pair, not once per row", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  let privacyChecks = 0;
  const app = makeApp(files, createAclStore(), {
    channelPrivacy: async () => {
      privacyChecks++;
      return true;
    },
  });
  for (let n = 0; n < 8; n++) {
    const id = fileArtifactId("channel-row", "out", n);
    await files.put({
      id,
      ownerScopeId: channel,
      createdBy: "U1",
      name: `row-${n}.txt`,
      path: `artifacts/${id}/row-${n}.txt`,
      mimetype: "text/plain",
      data: Buffer.from(`row ${n}`),
      direction: "out",
    });
  }

  const page = await app.listFilesForViewer("U1");
  assert.equal(page.owned.length, 8);
  assert.ok(
    page.owned.every((f) => f.deletable === true),
    "a private-channel member manages that channel's artifact home",
  );
  assert.equal(privacyChecks, 1, "eight rows sharing one home cost one authorization check");
});

test("in a public channel only the author's own rows are deletable", async () => {
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const app = makeApp(files, createAclStore(), {
    channels: [{ channelId: "C2", name: "general", isPrivate: false }],
    sessionScopes: [publicChannel],
    channelPrivacy: async () => false,
  });
  const authors = ["U1", "U2", "U3", "U4"];
  for (const [n, author] of authors.entries()) {
    const id = fileArtifactId("public-row", "out", n);
    await files.put({
      id,
      ownerScopeId: publicChannel,
      createdBy: author,
      name: `${author}.txt`,
      path: `artifacts/${id}/${author}.txt`,
      mimetype: "text/plain",
      data: Buffer.from(`row ${n}`),
      direction: "out",
    });
  }

  const page = await app.listFilesForViewer("U1");
  assert.deepEqual(
    Object.fromEntries(page.owned.map((f) => [f.name, f.deletable])),
    { "U1.txt": true, "U2.txt": false, "U3.txt": false, "U4.txt": false },
    "a public channel lets authors remove their own uploads and nobody else's",
  );
  assert.equal(await app.deleteFileForViewer(fileArtifactId("public-row", "out", 1), "U1"), "forbidden");
});

test("an unopenable row the viewer manages is still deletable", async () => {
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
  const deleted: string[] = [];
  const files = {
    get: async () => row,
    open: async () => null,
    listDocuments: async () => ({ files: [row] }),
    delete: async (target: string) => void deleted.push(target),
  } as unknown as FileArtifactStore;
  const app = makeApp(files, createAclStore());

  const page = await app.listFilesForViewer("U1");
  assert.equal(page.owned[0]!.openable, false);
  assert.equal(page.owned[0]!.deletable, true, "bytes you cannot read are still a row you can remove");
  assert.equal(await app.deleteFileForViewer(id, "U1"), "deleted");
  assert.deepEqual(deleted, [id]);
});
