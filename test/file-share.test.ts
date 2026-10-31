import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carriedFileHandles } from "../src/resolution/sharing-access.ts";
import { createToolContext } from "../src/tools/primitives.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { fileArtifactId, type FileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { principalEntitledToScope } from "../src/resolution/context-filter.ts";
import { scopeId, type Principal } from "../src/types.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { createAttachStaging } from "../src/core/orchestrator/attach-tool.ts";
import { createMemoryBlobTransferStore, collectBlob } from "../src/persistence/blob-transfer.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";

const person = (id: string, teamIds?: string[]): Principal => ({
  id,
  type: "internal",
  ...(teamIds ? { teamIds } : {}),
});
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff]);
const owner = scopeId("personal", "U1");
const grantee = scopeId("personal", "U2");

function fixture() {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  return {
    files,
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl()), {
      resolveFiles: (refs) => files.resolveByIds(refs),
    }),
  };
}

async function put(files: FileArtifactStore, ownerScopeId: string, name: string, data: Uint8Array) {
  const id = fileArtifactId(`${ownerScopeId}:${name}`, "in", 0);
  return (
    await files.put({
      id,
      ownerScopeId,
      createdBy: "U1",
      name,
      path: name,
      mimetype: name.endsWith(".jpg") ? "image/jpeg" : "text/plain",
      data,
      direction: "in",
    })
  ).artifact;
}

for (const carried of [false, true]) {
  test(`${carried ? "carried" : "explicitly shared"} Files records read inline or return a sendable binary ID without a computer`, async () => {
    const { files, acl } = fixture();
    const image = await put(files, owner, "orange.jpg", JPEG);
    const text = await put(files, owner, "notes.txt", Buffer.from("the plan"));
    for (const file of [image, text])
      await acl.grant({
        ownerScopeId: owner,
        ref: file.id,
        granteeScopeId: grantee,
        permission: "read",
        grantedBy: "U1",
      });
    const handles = carried ? await carriedFileHandles([owner], files) : await acl.handlesFor([grantee]);
    const noComputer = async (): Promise<never> => {
      throw new Error("must not provision a computer");
    };
    const ctx = createToolContext({
      sandbox: {} as Sandbox,
      provision: noComputer,
      layers: [{ scopeId: grantee, mountPath: "", mode: "rw" }],
      commandPolicy: () => ({}) as never,
      authorizeCommand: () => false,
      grantedHandles: handles,
      workspace: createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "fshare-"))),
      files,
      deploy: {} as never,
      acl,
      createdBy: "U2",
    });
    const textHandle = handles.find((handle) => handle.fileId === text.id)!;
    assert.deepEqual(await ctx.read(textHandle.handlePath), {
      content: "the plan",
      sourceScopeId: owner,
      shared: true,
    });
    const imageHandle = handles.find((handle) => handle.fileId === image.id)!;
    assert.deepEqual(await ctx.read(imageHandle.handlePath), {
      content: `[binary file orange.jpg, Files ID ${image.id}; send it by ID]`,
      sourceScopeId: owner,
      shared: true,
    });
    const transfer = createMemoryBlobTransferStore();
    const staging = createAttachStaging({
      sandbox: {} as Sandbox,
      provision: noComputer,
      blobTransfer: transfer,
      fileRegistration: { store: files, ownerScopeId: grantee, createdBy: "U2", seed: "send" },
      openStored: async (id) => {
        if (!handles.some((handle) => handle.fileId === id)) return null;
        const file = await files.get(id);
        const opened = await files.open(id);
        return file && opened ? { ...opened, name: file.name, mimetype: file.mimetype } : null;
      },
    });
    assert.equal((await staging.attach([{ file_id: image.id }])).ok, true);
    const sent = await transfer.open(staging.staged()[0]!.blobId);
    assert.deepEqual(await collectBlob(sent!.stream), Buffer.from(JPEG));
  });
}

test("workspace paths cannot be granted even when a Files record has that path", async () => {
  const { files, acl } = fixture();
  const file = await put(files, owner, "notes.txt", Buffer.from("the plan"));
  await assert.rejects(
    acl.grant({ ownerScopeId: owner, ref: file.path, granteeScopeId: grantee, permission: "read", grantedBy: "U1" }),
    /Files record ID/,
  );
  assert.deepEqual(await acl.list(), []);
  await acl.grant({ ownerScopeId: owner, ref: file.id, granteeScopeId: grantee, permission: "read", grantedBy: "U1" });
  assert.deepEqual(await acl.handlesFor([grantee]), [
    { handlePath: "shared/notes.txt", ownerScopeId: owner, fileId: file.id, permission: "read" },
  ]);
});

test("a person-grant resolves in a shared room of {owner, grantee} — but never leaks to an unentitled member", async () => {
  const { files, acl } = fixture();
  const alice = scopeId("personal", "U1");
  const carol = scopeId("personal", "U2");
  const org = scopeId("org", "default-org");
  const channel = scopeId("channel", "C1");
  const image = await put(files, alice, "orange.jpg", JPEG);
  await acl.grant({
    ownerScopeId: alice,
    ref: image.id,
    granteeScopeId: carol,
    permission: "read",
    grantedBy: "U1",
  });

  const inRoom = await acl.handlesForAudience([person("U1"), person("U2")], channel, org, principalEntitledToScope);
  assert.deepEqual(
    inRoom.map((h) => h.handlePath),
    ["shared/orange.jpg"],
  );
  assert.equal(inRoom[0]!.ownerScopeId, alice);

  const withAlicePresent = await acl.handlesForAudience(
    [person("U1"), person("U2"), person("U3")],
    channel,
    org,
    principalEntitledToScope,
  );
  assert.deepEqual(withAlicePresent, []);

  assert.equal((await acl.handlesForAudience([person("U2")], carol, org, principalEntitledToScope)).length, 1);
  assert.equal((await acl.handlesForAudience([person("U1")], alice, org, principalEntitledToScope)).length, 0);
});

test("an org grant surfaces for the whole audience; a team grant only when every member is in the team", async () => {
  const { files, acl } = fixture();
  const alice = scopeId("personal", "U1");
  const org = scopeId("org", "default-org");
  const channel = scopeId("channel", "C1");
  const poster = await put(files, alice, "poster.png", JPEG);
  const playbook = await put(files, alice, "playbook.md", Buffer.from("plan"));
  await acl.grant({ ownerScopeId: alice, ref: poster.id, granteeScopeId: org, permission: "read", grantedBy: "U1" });
  await acl.grant({
    ownerScopeId: alice,
    ref: playbook.id,
    granteeScopeId: scopeId("team", "T1"),
    permission: "read",
    grantedBy: "U1",
  });

  const mixed = await acl.handlesForAudience(
    [person("U1", ["T1"]), person("U2")],
    channel,
    org,
    principalEntitledToScope,
  );
  assert.deepEqual(mixed.map((h) => h.handlePath).sort(), ["shared/poster.png"]);

  const allInTeam = await acl.handlesForAudience(
    [person("U1", ["T1"]), person("U2", ["T1"])],
    channel,
    org,
    principalEntitledToScope,
  );
  assert.deepEqual(allInTeam.map((h) => h.handlePath).sort(), ["shared/playbook.md", "shared/poster.png"]);
});
