import { readContextFile } from "../src/resolution/context-files.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { composeSharingPosture, parseSharingPosture, type SharingPosture } from "../src/resolution/sharing-posture.ts";
import {
  carriedFileHandles,
  isOpenScopeMember,
  MAX_OPEN_SHARED_SCOPES,
  sharingSourcesForTurn,
} from "../src/resolution/sharing-access.ts";
import { type PersistedSharingPosture } from "../src/resolution/config-store.ts";
import { scopeId, type Principal, type Session } from "../src/types.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createIsCurrentSharedScopeMember } from "../src/resolution/scope-membership.ts";
import { createPostgresFileArtifactStore } from "../src/files/postgres-file-artifact-store.ts";
import { testConfigStore, testDatabaseUrl, testMap } from "./support/test-database.ts";

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
  const sharingPostures = testMap<PersistedSharingPosture>();
  const writer = testConfigStore("acme", { sharingPostures });
  const reader = testConfigStore("acme", { sharingPostures });
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

  const restarted = testConfigStore("acme", { sharingPostures });
  await restarted.hydrate?.();
  assert.equal(await restarted.getSharingPostureOwnDurable(personal), "open");
  assert.equal(await restarted.getSharingPostureOwnDurable(room), "open");
});

test("Open membership re-checks durable organization, person, room, and membership restrictions", async () => {
  const store = testMap<PersistedSharingPosture>();
  const writer = testConfigStore("acme", { sharingPostures: store });
  const reader = testConfigStore("acme", { sharingPostures: store });
  const org = scopeId("org", "acme");
  const personal = scopeId("personal", "U1");
  const room = scopeId("channel", "C1");
  let member = true;
  const input = {
    actorId: "U1",
    scope: room,
    config: reader,
    isCurrentSharedScopeMember: async () => member,
  };
  assert.equal(await isOpenScopeMember(input), false);
  await writer.setSharingPosture(org, "open");
  assert.equal(await isOpenScopeMember(input), true);
  for (const scope of [personal, room, org]) {
    await writer.setSharingPosture(scope, "isolated");
    assert.equal(await isOpenScopeMember(input), false);
    await writer.setSharingPosture(scope, "open");
    assert.equal(await isOpenScopeMember(input), true);
  }
  member = false;
  assert.equal(await isOpenScopeMember(input), false);
  member = true;
  assert.equal(await isOpenScopeMember({ ...input, scope: personal }), false);
});

test("open sources accept live human-authored ambient turns and bind carry to the authenticated actor", async () => {
  const config = testConfigStore("acme", { defaultSharingPosture: "open" });
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
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "ambient", live: true } }), [
    scopeId("personal", "U2"),
  ]);
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "ambient" } }), []);
  assert.deepEqual(await sharingSourcesForTurn({ ...base, origin: { kind: "ambient", live: false } }), []);
  assert.deepEqual(
    await sharingSourcesForTurn({ ...base, trustedLiveHuman: false, origin: { kind: "ambient", live: true } }),
    [],
  );
  assert.deepEqual(
    await sharingSourcesForTurn({
      ...base,
      isCurrentSharedScopeMember: async () => false,
      origin: { kind: "ambient", live: true },
    }),
    [],
  );
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
  const config = testConfigStore("acme", { defaultSharingPosture: "open" });
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
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const personal = scopeId("personal", "U1");
  const teammate = scopeId("personal", "U2");
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
  await files.put({
    id: "3".repeat(32),
    ownerScopeId: teammate,
    createdBy: "U2",
    name: "secret.txt",
    path: "secret.txt",
    mimetype: "text/plain",
    data: Buffer.from("theirs"),
    direction: "in",
  });
  const handles = await carriedFileHandles([personal], files);
  assert.deepEqual(
    handles.map((handle) => [handle.ownerScopeId, handle.fileId, handle.permission]),
    [[personal, "1".repeat(32), "read"]],
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
    name: "artifact.txt",
    path: `artifacts/${secondArtifactId}/artifact.txt`,
    mimetype: "text/plain",
    data: Buffer.from("second artifact"),
    direction: "in",
  });
  const handlesAgain = await carriedFileHandles([personal], files);
  assert.equal(new Set(handlesAgain.map((handle) => handle.handlePath)).size, 2);
  for (const handle of handlesAgain) {
    const read = await readContextFile(handle.handlePath, handlesAgain, files);
    assert.ok(read && "bytes" in read);
    assert.equal(read.bytes?.toString(), handle.fileId === secondArtifactId ? "second artifact" : "artifact");
  }
  assert.equal(
    handlesAgain.some((handle) => handle.fileId === secondArtifactId),
    true,
  );
});

test("Open examines a bounded candidate window even when every membership is revoked", async () => {
  const config = testConfigStore("acme", { defaultSharingPosture: "open" });
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

test("Open file enumeration is globally capped across selected scopes", async () => {
  const files = createPostgresFileArtifactStore(testDatabaseUrl(), createMemoryDurableByteStore());
  const scopes = [scopeId("personal", "U1"), scopeId("channel", "C1")];
  for (let i = 0; i < 210; i++) {
    await files.put({
      id: i.toString(16).padStart(32, "0"),
      ownerScopeId: scopes[i % 2]!,
      createdBy: "U1",
      name: `file-${i}.txt`,
      path: `file-${i}.txt`,
      mimetype: "text/plain",
      data: Buffer.from("file"),
      direction: "in",
    });
  }
  const handles = await carriedFileHandles(scopes, files);
  assert.equal(handles.length, 200);
  assert.equal(new Set(handles.map((handle) => handle.ownerScopeId)).size, 2);
});
