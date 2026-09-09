import assert from "node:assert/strict";
import test from "node:test";
import { composeSharingPosture, parseSharingPosture, type SharingPosture } from "../src/resolution/sharing-posture.ts";
import { carriedFileHandles, MAX_OPEN_SHARED_SCOPES, sharingSourcesForTurn } from "../src/resolution/sharing-access.ts";
import { createMemoryConfigStore, type PersistedSharingPosture } from "../src/resolution/config-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId, type Principal, type Session } from "../src/types.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createIsCurrentSharedScopeMember } from "../src/resolution/scope-membership.ts";

test("sharing posture is isolated by default and isolated wins composition", () => {
  assert.equal(parseSharingPosture("open"), "open");
  assert.equal(parseSharingPosture("isolated"), "isolated");
  assert.equal(parseSharingPosture("dangerous"), null);
  const cases: Array<[SharingPosture, SharingPosture | undefined, SharingPosture]> = [
    ["isolated", undefined, "isolated"],
    ["isolated", "open", "isolated"],
    ["open", undefined, "open"],
    ["open", "open", "open"],
    ["open", "isolated", "isolated"],
  ];
  for (const [ceiling, narrower, expected] of cases) {
    assert.equal(composeSharingPosture(ceiling, narrower), expected);
  }
});

test("durable sharing policy composes organization, personal, and room vetoes and refreshes replicas", async () => {
  const sharingPostures = createMemoryMap<PersistedSharingPosture>();
  const writer = createMemoryConfigStore("acme", { sharingPostures });
  const reader = createMemoryConfigStore("acme", { sharingPostures });
  const org = scopeId("org", "acme");
  const personal = scopeId("personal", "U1");
  const room = scopeId("channel", "C1");

  assert.equal(await reader.resolveSharingPostureDurable(personal, room), "isolated");
  await writer.setSharingPosture(org, "open");
  assert.equal(await reader.resolveSharingPostureDurable(personal, room), "open");
  await writer.setSharingPosture(personal, "isolated");
  assert.equal(await reader.resolveSharingPostureDurable(personal, room), "isolated");
  await writer.setSharingPosture(personal, "open");
  await writer.setSharingPosture(room, "isolated");
  assert.equal(await reader.resolveSharingPostureDurable(personal, room), "isolated");
  await writer.setSharingPosture(room, "open");
  await writer.setSharingPosture(org, "isolated");
  assert.equal(await reader.resolveSharingPostureDurable(personal, room), "isolated");

  const restarted = createMemoryConfigStore("acme", { sharingPostures });
  await restarted.hydrate?.();
  assert.equal(await restarted.getSharingPostureOwnDurable(personal), "open");
  assert.equal(await restarted.getSharingPostureOwnDurable(room), "open");
});

test("open sources require a live internal human and bind personal carry to the authenticated actor", async () => {
  const config = createMemoryConfigStore("acme", { defaultSharingPosture: "open" });
  const sessions = { listByParticipant: async () => [] };
  const targetScope = scopeId("channel", "C1");
  const actor: Principal = { id: "U2", type: "internal" };
  const base = {
    posture: "open" as const,
    actor,
    trustedLiveHuman: true,
    targetScope,
    config,
    sessions,
    isCurrentSharedScopeMember: async () => true,
  };
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "human" } }), [scopeId("personal", "U2")]);
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "automation" } }), []);
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "ambient", live: true } }), []);
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "direct" } }), []);
  assert.deepEqual(
    await sharingSourcesForTurn({ ...base, actor: { id: "U2", type: "guest" }, origin: { kind: "human" } }),
    [],
  );
  assert.deepEqual(
    await sharingSourcesForTurn({ ...base, isCurrentSharedScopeMember: async () => false, origin: { kind: "human" } }),
    [],
  );
  assert.deepEqual(await sharingSourcesForTurn({ ...base, trustedLiveHuman: false, origin: { kind: "human" } }), []);
});

test("current membership resolves directory identity aliases and fails closed when none match", async () => {
  const member = createIsCurrentSharedScopeMember({
    identity: { classify: () => ({ type: "internal" }) },
    directory: {
      get: async (principalId) =>
        principalId === "u1@example.com" ? { principalId: "u1@example.com", slackId: "U1" } : null,
      channelMember: async (_channelId, principalId) => principalId === "U1",
      groupMember: async () => false,
    },
  });
  assert.equal(await member("u1@example.com", scopeId("channel", "C1")), true);
  assert.equal(await member("unknown@example.com", scopeId("channel", "C1")), false);
  assert.equal(await member("u1@example.com", scopeId("personal", "u1@example.com")), false);
});

test("DM carry is recent, bounded, non-transitive, source-vetoed, and revoked by current membership", async () => {
  const config = createMemoryConfigStore("acme", { defaultSharingPosture: "open" });
  const actor: Principal = { id: "U1", type: "internal" };
  const personal = scopeId("personal", actor.id);
  const sessions: Session[] = Array.from({ length: 30 }, (_, index) => ({
    id: `s${index}`,
    type: "channel" as const,
    scopeId: scopeId("channel", `C${index}`),
    threadRef: `C${index}:t`,
    createdAt: index,
    lastActivityAt: index,
  }));
  sessions.push({
    id: "personal",
    type: "dm",
    scopeId: personal,
    threadRef: "dm:U1:t",
    createdAt: 100,
    lastActivityAt: 100,
  });
  const removed = scopeId("channel", "C29");
  const vetoed = scopeId("channel", "C28");
  await config.setSharingPosture(vetoed, "isolated");
  const sources = await sharingSourcesForTurn({
    posture: "open",
    actor,
    origin: { kind: "human" },
    trustedLiveHuman: true,
    targetScope: personal,
    config,
    sessions: { listByParticipant: async () => sessions },
    isCurrentSharedScopeMember: async (_actorId, source) => source !== removed,
  });
  assert.equal(sources.length, MAX_OPEN_SHARED_SCOPES);
  assert.equal(sources.includes(removed), false);
  assert.equal(sources.includes(vetoed), false);
  assert.equal(sources.includes(personal), false);
  assert.deepEqual(sources.slice(0, 2), [scopeId("channel", "C27"), scopeId("channel", "C26")]);
});

test("carried file handles expose only selected source scopes read-only without mounting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "sharing-handles-"));
  const workspace = createLocalWorkspaceStore(root);
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const personal = scopeId("personal", "U1");
  const teammate = scopeId("personal", "U2");
  await workspace.write(personal, "notes/private.txt", "mine");
  await workspace.write(teammate, "teammate-secret.txt", "theirs");
  await files.put({
    id: "1".repeat(32),
    ownerScopeId: personal,
    createdBy: "U1",
    name: "artifact.txt",
    path: `artifacts/${"1".repeat(32)}/artifact.txt`,
    mimetype: "text/plain",
    data: Buffer.from("artifact"),
    direction: "in",
  });
  const handles = await carriedFileHandles([personal], workspace, files);
  assert.deepEqual(
    handles.map((handle) => [handle.ownerScopeId, handle.ownerPath, handle.permission]),
    [
      [personal, "notes/private.txt", "read"],
      [personal, `artifacts/${"1".repeat(32)}/artifact.txt`, "read"],
    ],
  );
  assert.equal(
    handles.some((handle) => handle.ownerScopeId === teammate),
    false,
  );
  const secondArtifactId = "2".repeat(32);
  await files.put({
    id: secondArtifactId,
    ownerScopeId: personal,
    createdBy: "U1",
    name: "second-artifact.txt",
    path: `artifacts/${secondArtifactId}/second-artifact.txt`,
    mimetype: "text/plain",
    data: Buffer.from("second artifact"),
    direction: "in",
  });
  const pagedHandles = await carriedFileHandles([personal], workspace, {
    listOwnedByScopes: (scopes, opts) => files.listOwnedByScopes(scopes, { ...opts, limit: 1 }),
  });
  assert.equal(
    pagedHandles.some((handle) => handle.ownerPath === `artifacts/${secondArtifactId}/second-artifact.txt`),
    true,
  );
});

test("Open examines a bounded candidate window even when every membership is revoked", async () => {
  const config = createMemoryConfigStore("acme", { defaultSharingPosture: "open" });
  let checks = 0;
  let requestedLimit = 0;
  const candidates = Array.from({ length: 1000 }, (_, i) => ({
    id: String(i),
    type: "channel" as const,
    scopeId: scopeId("channel", `C${i}`),
    createdAt: i,
    threadRef: `C${i}:t`,
  }));
  const sources = await sharingSourcesForTurn({
    posture: "open",
    actor: { id: "U1", type: "internal" },
    origin: { kind: "human" },
    trustedLiveHuman: true,
    targetScope: scopeId("personal", "U1"),
    config,
    sessions: {
      listByParticipant: async (_id, opts) => {
        requestedLimit = opts?.limit ?? 0;
        return candidates;
      },
    },
    isCurrentSharedScopeMember: async () => {
      checks++;
      return false;
    },
  });
  assert.deepEqual(sources, []);
  assert.equal(requestedLimit, 100);
  assert.equal(checks, 100);
});

test("Open file enumeration is globally capped and excludes the memory notebook", async () => {
  const root = await mkdtemp(join(tmpdir(), "sharing-cap-"));
  const workspace = createLocalWorkspaceStore(root);
  const personal = scopeId("personal", "U1");
  await workspace.write(personal, "memory/MEMORY.md", "PRIVATE_NOTE");
  for (let i = 0; i < 210; i++) await workspace.write(personal, `file-${i}.txt`, "file");
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const handles = await carriedFileHandles([personal], workspace, files);
  assert.ok(handles.length <= 200);
  assert.equal(
    handles.some((handle) => handle.ownerPath === "memory/MEMORY.md"),
    false,
  );
  assert.ok((await workspace.list(personal, { limit: 3 })).length <= 3);
});

test("Open excludes memory notebook aliases with Windows separators", async () => {
  const personal = scopeId("personal", "U1");
  const root = await mkdtemp(join(tmpdir(), "sharing-memory-alias-"));
  const workspace = createLocalWorkspaceStore(root);
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  await workspace.write(personal, "memory/MEMORY.md", "PRIVATE");
  const handles = await carriedFileHandles(
    [personal],
    {
      scopeDir: workspace.scopeDir,
      list: async () => [join(workspace.scopeDir(personal), "memory\\MEMORY.md")],
    },
    files,
  );
  assert.deepEqual(handles, []);
});
