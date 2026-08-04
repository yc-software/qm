import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolContext } from "../src/tools/primitives.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { artifactPath, createMemoryFileArtifactStore, fileArtifactId } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { principalEntitledToScope } from "../src/resolution/context-filter.ts";
import { scopeId, type Principal, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const person = (id: string, teamIds?: string[]): Principal => ({
  id,
  type: "internal",
  ...(teamIds ? { teamIds } : {}),
});

const ws = () => createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "fshare-")));

const sameBytes = (a: Uint8Array | null | undefined, b: Uint8Array) => assert.deepEqual([...(a ?? [])], [...b]);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff]);

function memSandbox(seed: Record<string, Uint8Array> = {}): { sandbox: Sandbox; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
  const sandbox = {
    async writeFile(_h: SandboxHandle, rel: string, data: string) {
      files.set(rel, new TextEncoder().encode(data));
    },
    async readFile(_h: SandboxHandle, rel: string) {
      const b = files.get(rel);
      return b ? new TextDecoder().decode(b) : null;
    },
    async writeFileBytes(_h: SandboxHandle, rel: string, data: Uint8Array) {
      files.set(rel, data);
    },
    async readFileBytes(_h: SandboxHandle, rel: string) {
      return files.get(rel) ?? null;
    },
  } as unknown as Sandbox;
  return { sandbox, files };
}

function toolCtx(opts: {
  scope: string;
  workspace: ReturnType<typeof createLocalWorkspaceStore>;
  sandbox: Sandbox;
  acl: ReturnType<typeof createAclStore>;
  auditLog?: ReturnType<typeof createAuditLog>;
  layers?: WorkspaceLayer[];
  grantedHandles?: Awaited<ReturnType<ReturnType<typeof createAclStore>["handlesFor"]>>;
  sharedMaterializeDir?: string;
  createdBy?: string;
}) {
  return createToolContext({
    sandbox: opts.sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }) as SandboxHandle,
    layers: opts.layers ?? [{ scopeId: opts.scope, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: opts.grantedHandles ?? [],
    ...(opts.sharedMaterializeDir ? { sharedMaterializeDir: opts.sharedMaterializeDir } : {}),
    workspace: opts.workspace,
    deploy: {} as never,
    acl: opts.acl,
    ...(opts.auditLog ? { auditLog: opts.auditLog } : {}),
    createdBy: opts.createdBy ?? opts.scope.split(":")[1] ?? opts.scope,
  });
}

test("write shares an existing file to a person; the grantee reads it back byte-for-byte", async () => {
  const workspace = ws();
  const acl = createAclStore();
  const auditLog = createAuditLog();
  const owner = scopeId("personal", "U1");
  const carol = scopeId("personal", "U2");

  const r = await toolCtx({
    scope: owner,
    workspace,
    sandbox: memSandbox({ "orange.jpg": JPEG }).sandbox,
    acl,
    auditLog,
  }).write("orange.jpg", undefined, [{ scope: carol, permission: "read" }]);

  assert.deepEqual(r.shared, [{ scope: carol, permission: "read" }]);
  assert.equal((await acl.list()).length, 1);
  assert.deepEqual((await acl.list())[0], {
    ownerScopeId: owner,
    ref: "orange.jpg",
    granteeScopeId: carol,
    permission: "read",
    grantedBy: "U1",
  });
  assert.equal(
    (await auditLog.events()).some(
      (e) => e.action === "file_share" && e.resource === "orange.jpg" && e.scopeLabel === carol,
    ),
    true,
  );
  sameBytes(await workspace.readBytes(owner, "orange.jpg"), JPEG);

  const carolBox = memSandbox();
  const got = await toolCtx({
    scope: carol,
    workspace,
    sandbox: carolBox.sandbox,
    acl,
    grantedHandles: await acl.handlesFor([carol]),
  }).read("shared/orange.jpg");

  assert.match(got.content ?? "", /materialized.*shared\/orange\.jpg/);
  assert.equal(got.sourceScopeId, owner);
  sameBytes(carolBox.files.get("shared/orange.jpg"), JPEG);
});

test("a binary shared file materializes in the current turn's private directory", async () => {
  const workspace = ws();
  const acl = createAclStore();
  const owner = scopeId("personal", "U1");
  const grantee = scopeId("personal", "U2");
  await workspace.write(owner, "orange.jpg", JPEG);
  await acl.grant({
    ownerScopeId: owner,
    ref: "orange.jpg",
    granteeScopeId: grantee,
    permission: "read",
    grantedBy: "U1",
  });

  const box = memSandbox();
  const got = await toolCtx({
    scope: grantee,
    workspace,
    sandbox: box.sandbox,
    acl,
    grantedHandles: await acl.handlesFor([grantee]),
    sharedMaterializeDir: "shared/turn-1",
  }).read("shared/orange.jpg");

  assert.match(got.content ?? "", /shared\/turn-1\/orange\.jpg/);
  sameBytes(box.files.get("shared/turn-1/orange.jpg"), JPEG);
  assert.equal(box.files.has("shared/orange.jpg"), false);
});

test("the screenshot scenario: shared to the org in a DM, delivered from a channel session", async () => {
  const workspace = ws();
  const acl = createAclStore();
  const org = scopeId("org", "default-org");
  const alice = scopeId("personal", "U1");

  const dmLayers: WorkspaceLayer[] = [
    { scopeId: org, mountPath: "global", mode: "ro" },
    { scopeId: alice, mountPath: "", mode: "rw" },
  ];
  const r = await toolCtx({
    scope: alice,
    workspace,
    sandbox: memSandbox({ "orange.jpg": JPEG }).sandbox,
    acl,
    layers: dmLayers,
  }).write("orange.jpg", undefined, [{ scope: "org", permission: "read" }]);
  assert.deepEqual(r.shared, [{ scope: org, permission: "read" }], '"org" resolves to the session org scope');

  const channel = scopeId("channel", "C1");
  const handles = await acl.handlesFor([channel, org]);
  assert.equal(handles.length, 1, "the org-granted file is reachable from the channel session");

  const channelBox = memSandbox();
  const got = await toolCtx({
    scope: channel,
    workspace,
    sandbox: channelBox.sandbox,
    acl,
    grantedHandles: handles,
  }).read("shared/orange.jpg");
  sameBytes(channelBox.files.get("shared/orange.jpg"), JPEG);
  assert.equal(got.sourceScopeId, alice, "the file keeps its owner (Alice) — sharing never moves ownership");
});

test("write can save AND share in one call; a text grant returns inline content", async () => {
  const workspace = ws();
  const acl = createAclStore();
  const owner = scopeId("personal", "U1");
  const grantee = scopeId("personal", "U2");

  const r = await toolCtx({ scope: owner, workspace, sandbox: memSandbox().sandbox, acl }).write(
    "notes.md",
    "the plan",
    [{ scope: grantee, permission: "read" }],
  );
  assert.deepEqual(r.shared, [{ scope: grantee, permission: "read" }]);
  assert.equal(await workspace.read(owner, "notes.md"), "the plan", "the contents were saved durably");

  const box = memSandbox();
  const got = await toolCtx({
    scope: grantee,
    workspace,
    sandbox: box.sandbox,
    acl,
    grantedHandles: await acl.handlesFor([grantee]),
  }).read("shared/notes.md");
  assert.equal(got.content, "the plan");
  assert.equal(box.files.has("shared/notes.md"), false, "text reads stay inline — no sandbox materialization");
});

test("a person-grant resolves in a shared room of {owner, grantee} — but never leaks to an unentitled member", async () => {
  const acl = createAclStore();
  const alice = scopeId("personal", "U1");
  const carol = scopeId("personal", "U2");
  const org = scopeId("org", "default-org");
  const channel = scopeId("channel", "C1");
  await acl.grant({
    ownerScopeId: alice,
    ref: "orange.jpg",
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
  const acl = createAclStore();
  const alice = scopeId("personal", "U1");
  const org = scopeId("org", "default-org");
  const channel = scopeId("channel", "C1");
  await acl.grant({ ownerScopeId: alice, ref: "poster.png", granteeScopeId: org, permission: "read", grantedBy: "U1" });
  await acl.grant({
    ownerScopeId: alice,
    ref: "playbook.md",
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

test("write without data or share is rejected; sharing a missing file / from a read-only session errors", async () => {
  const workspace = ws();
  const acl = createAclStore();
  const owner = scopeId("personal", "U1");

  await assert.rejects(
    () => toolCtx({ scope: owner, workspace, sandbox: memSandbox().sandbox, acl }).write("x.md"),
    /needs `data`.*`share`/,
  );
  await assert.rejects(
    () =>
      toolCtx({ scope: owner, workspace, sandbox: memSandbox().sandbox, acl }).write("ghost.png", undefined, [
        { scope: owner },
      ]),
    /no such file to share: ghost\.png/,
  );
  await assert.rejects(
    () =>
      toolCtx({
        scope: owner,
        workspace,
        sandbox: memSandbox({ "x.png": JPEG }).sandbox,
        acl,
        layers: [{ scopeId: scopeId("org", "default-org"), mountPath: "global", mode: "ro" }],
      }).write("x.png", undefined, [{ scope: "org" }]),
    /writable scope/,
  );
});

test("a viewer-uploaded artifact (artifacts/<id>/<name>) is readable through its shared handle (public #94)", async () => {
  const workspace = ws();
  const acl = createAclStore();
  const owner = scopeId("personal", "U1");
  const grantee = scopeId("personal", "U2");
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const id = fileArtifactId("upload:U1:test:1:x", "in", 0);
  const path = artifactPath(id, "notes.txt");
  await files.put({
    id,
    ownerScopeId: owner,
    createdBy: "U1",
    name: "notes.txt",
    path,
    mimetype: "text/plain",
    data: Buffer.from("hello from the upload"),
    direction: "in",
    createdInScope: grantee,
  });
  await acl.grant({ ownerScopeId: owner, ref: path, granteeScopeId: grantee, permission: "read", grantedBy: "U1" });

  const handles = await acl.handlesForAudience([person("U2")], grantee, "org:o", principalEntitledToScope);
  assert.equal(handles.length, 1, "the grant materializes as a handle");

  const ctx = createToolContext({
    sandbox: memSandbox().sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }) as SandboxHandle,
    layers: [{ scopeId: grantee, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: handles,
    workspace,
    files,
    deploy: {} as never,
    acl,
    createdBy: "U2",
  });
  const got = await ctx.read(handles[0]!.handlePath);
  assert.equal(got.content, "hello from the upload");
  assert.equal(got.sourceScopeId, owner);
});

test("a workspace-backed share is never served from a stale artifact snapshot", async () => {
  const workspace = ws();
  const acl = createAclStore();
  const owner = scopeId("personal", "U1");
  const grantee = scopeId("personal", "U2");
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  // artifact snapshot holds version 1 under the real workspace path
  await files.put({
    id: fileArtifactId("share:U1:doc.txt", "out", 0),
    ownerScopeId: owner,
    createdBy: "U1",
    name: "doc.txt",
    path: "doc.txt",
    mimetype: "text/plain",
    data: Buffer.from("version 1"),
    direction: "out",
    createdInScope: owner,
  });
  // workspace holds version 2
  await workspace.write(owner, "doc.txt", "version 2");
  await acl.grant({
    ownerScopeId: owner,
    ref: "doc.txt",
    granteeScopeId: grantee,
    permission: "read",
    grantedBy: "U1",
  });
  const handles = await acl.handlesForAudience([person("U2")], grantee, "org:o", principalEntitledToScope);
  const ctx = createToolContext({
    sandbox: memSandbox().sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }) as SandboxHandle,
    layers: [{ scopeId: grantee, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: handles,
    workspace,
    files,
    deploy: {} as never,
    acl,
    createdBy: "U2",
  });
  const got = await ctx.read(handles[0]!.handlePath);
  assert.equal(got.content, "version 2", "the live workspace copy wins for workspace-namespace paths");
});
