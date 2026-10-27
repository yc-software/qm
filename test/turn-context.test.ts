import { createAclStore } from "../src/acl/acl-store.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTurnContext } from "../src/resolution/turn-context.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService } from "../src/memory/memory-service.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import type { Resolution, Session } from "../src/types.ts";
import { renderRecall } from "../src/memory/cross-scope.ts";
import { createSemanticMemoryService } from "../src/memory/semantic-recall.ts";
import { scoredMemoryIndex } from "./support/scored-memory-index.ts";

async function fixture() {
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "turn-context-")));
  const memory = createMemoryService(workspace);
  const config = createMemoryConfigStore("test", { defaultSharingPosture: "open" });
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const auditLog = createAuditLog();
  let member = true;
  const resolution = {
    layers: [
      { scopeId: "personal:alice", mode: "rw", mountPath: "" },
      { scopeId: "org:test", mode: "ro", mountPath: "global" },
    ],
    orgScopeId: "org:test",
    sharingPosture: "open",
    grantedHandles: [],
  } as unknown as Resolution;
  const acl = createAclStore(undefined, { resolveFiles: (refs) => files.resolveByIds(refs) });
  const input: Parameters<typeof resolveTurnContext>[0] = {
    actor: { id: "alice", type: "internal" },
    audience: [{ id: "alice", type: "internal" }],
    acl,
    targetScope: "personal:alice",
    origin: { kind: "human" },
    trustedLiveHuman: true,
    sessions: { listByParticipant: async () => [{ scopeId: "channel:eng", createdAt: 1 }] as Session[] },
    isCurrentSharedScopeMember: async (actor, scope) => member && actor === "alice" && scope === "channel:eng",
    config,
    resolution,
    memoryPolicy: { recall: "visible", capture: "writable" },
    useMemory: true,
    memory,
    files,
    auditLog,
  };
  await memory.capture("personal:alice", ["LOCAL_FACT"], Date.now());
  await memory.capture("channel:eng", ["SHARED_FACT", "long fact ".repeat(1500), "LAST_FACT"], Date.now());
  await files.put({
    id: "1".repeat(32),
    ownerScopeId: "channel:eng",
    createdBy: "alice",
    name: "plan.txt",
    path: "plan.txt",
    mimetype: "text/plain",
    data: Buffer.from("PLAN_CONTENT"),
    direction: "in",
  });
  return {
    input,
    acl,
    memory,
    config,
    auditLog,
    removeMember: () => {
      member = false;
    },
  };
}

test("one context recalls only its own notebook and org while reads, search, and files keep carried sources", async () => {
  const { input, auditLog, memory } = await fixture();
  await memory.capture("org:test", ["ORG_FACT"], Date.now());
  const context = await resolveTurnContext(input);
  const recalled = renderRecall(await context.recallMemory(""), new Map());
  assert.match(recalled, /### personal:alice[\s\S]*LOCAL_FACT/);
  assert.match(recalled, /### org:test[\s\S]*ORG_FACT/);
  assert.doesNotMatch(recalled, /channel:eng|SHARED_FACT|LAST_FACT/);
  assert.deepEqual([...(await context.memorySnapshot()).held.keys()], ["personal:alice", "org:test"]);
  const full = await context.readMemory("channel:eng");
  assert.match(full ?? "", /SHARED_FACT[\s\S]*LAST_FACT/);
  assert.ok(full!.length > 12000, "explicit reads still return the whole notebook");
  assert.match(
    (await context.searchMemory("SHARED_FACT", 20, "channel:eng"))!.join(),
    /^\[channel:eng\] #\d+ \(\d{4}-\d\d-\d\d\) SHARED_FACT$/,
  );
  assert.equal(await context.readMemory("personal:other"), null);
  assert.equal(await context.searchMemory("SHARED_FACT", 20, "personal:other"), null);
  assert.match(
    (await context.searchMemory("LAST_FACT"))!.join(),
    /^\[channel:eng\] #\d+ \(\d{4}-\d\d-\d\d\) LAST_FACT$/,
  );
  assert.deepEqual(context.memoryAccess?.read, ["personal:alice", "org:test", "channel:eng"]);
  assert.deepEqual(context.baseRecallScopes, ["personal:alice", "org:test"], "reusable tokens exclude carried sources");
  assert.equal(context.memoryAccess?.write, "personal:alice");
  const handle = context.listFiles().find((h) => h.ownerScopeId === "channel:eng")!;
  const result = await context.readFile(handle.handlePath);
  assert.ok(result && "bytes" in result);
  assert.equal(Buffer.from(result.bytes!).toString(), "PLAN_CONTENT");
  assert.equal(await context.readFile("shared/open-channel-other/plan.txt"), null);
  const events = await auditLog.events();
  assert.ok(events.some((e) => e.resource === "memory" && e.detail?.includes("channel:eng")));
  assert.ok(events.some((e) => e.resource === "1".repeat(32) && e.detail?.includes("channel:eng")));
});

for (const mode of [
  "isolated",
  "source-veto",
  "removed",
  "speaker-switch",
  "automation",
  "memory-off",
  "memory-writable",
  "memory-skip",
] as const) {
  test(`context ${mode} excludes source memories consistently`, async () => {
    const { input, config, removeMember } = await fixture();
    if (mode === "isolated") input.resolution.sharingPosture = "isolated";
    if (mode === "source-veto") await config.setSharingPosture("channel:eng", "isolated");
    if (mode === "removed") removeMember();
    if (mode === "speaker-switch") input.actor = { id: "bob", type: "internal" };
    if (mode === "automation") input.trustedLiveHuman = false;
    if (mode === "memory-off") input.memoryPolicy.recall = "off";
    if (mode === "memory-writable") input.memoryPolicy.recall = "writable";
    if (mode === "memory-skip") input.useMemory = false;
    const context = await resolveTurnContext(input);
    assert.doesNotMatch(renderRecall(await context.recallMemory(""), new Map()), /SHARED_FACT|LAST_FACT/);
    assert.deepEqual((await context.searchMemory("LAST_FACT")) ?? [], []);
    assert.equal(await context.readMemory("channel:eng"), null);
    assert.equal(await context.searchMemory("LAST_FACT", 20, "channel:eng"), null);
    if (!mode.startsWith("memory-")) {
      assert.deepEqual(context.listFiles(), []);
      assert.equal(await context.readFile("shared/open-channel-eng/plan.txt"), null);
    }
  });
}

test("fresh turn re-resolves membership after an earlier successful read", async () => {
  const { input, removeMember } = await fixture();
  assert.match((await (await resolveTurnContext(input)).searchMemory("LAST_FACT"))!.join(), /LAST_FACT/);
  removeMember();
  const next = await resolveTurnContext(input);
  assert.deepEqual((await next.searchMemory("LAST_FACT")) ?? [], []);
  assert.equal(await next.readMemory("channel:eng"), null);
  assert.equal(await next.readFile("shared/open-channel-eng/plan.txt"), null);
});

test("a DM with team layers and open channel sources auto-recalls only its own notebook and org", async () => {
  const { input, memory } = await fixture();
  input.resolution.layers.push({ scopeId: "team:core", mode: "ro", mountPath: "team-core" });
  input.sessions = {
    listByParticipant: async () =>
      [
        { scopeId: "channel:eng", createdAt: 1 },
        { scopeId: "group:proj", createdAt: 2 },
      ] as Session[],
  };
  input.isCurrentSharedScopeMember = async (actor, scope) =>
    actor === "alice" && (scope === "channel:eng" || scope === "group:proj");
  await memory.capture("org:test", ["ORG_FACT"], Date.now());
  await memory.capture("team:core", ["TEAM_FACT"], Date.now());
  await memory.capture("group:proj", ["GROUP_FACT"], Date.now());
  const context = await resolveTurnContext(input);
  assert.deepEqual(
    new Set(context.memoryAccess?.read),
    new Set(["personal:alice", "org:test", "team:core", "channel:eng", "group:proj"]),
  );
  const recalled = await context.recallMemory("", (await context.memorySnapshot()).loaded);
  assert.deepEqual([...new Set(recalled.map((fact) => fact.scope))].sort(), ["org:test", "personal:alice"]);
  assert.doesNotMatch(renderRecall(recalled, new Map()), /TEAM_FACT|GROUP_FACT|SHARED_FACT|LAST_FACT/);
  assert.deepEqual([...context.memoryLabels.keys()].sort(), ["org:test", "personal:alice"]);
  assert.match((await context.searchMemory("GROUP_FACT"))!.join(), /\[group:proj\] .*GROUP_FACT/);
});

test("a channel conversation auto-recalls only the channel notebook and org, not the speaker's personal notebook", async () => {
  const { input, memory } = await fixture();
  input.targetScope = "channel:eng";
  input.resolution.layers = [
    { scopeId: "org:test", mode: "ro", mountPath: "global" },
    { scopeId: "channel:eng", mode: "rw", mountPath: "" },
  ];
  await memory.capture("org:test", ["ORG_FACT"], Date.now());
  const context = await resolveTurnContext(input);
  assert.deepEqual(context.sharingSources, ["personal:alice"]);
  const recalled = renderRecall(await context.recallMemory(""), new Map());
  assert.match(recalled, /### channel:eng[\s\S]*SHARED_FACT/);
  assert.match(recalled, /### org:test[\s\S]*ORG_FACT/);
  assert.doesNotMatch(recalled, /LOCAL_FACT|personal:alice/);
  assert.ok(context.memoryAccess?.read.includes("personal:alice"));
});

test("skill discovery uses the same included scopes and audience-filtered explicit grants", async () => {
  const { input, acl, removeMember } = await fixture();
  await acl.grant(
    {
      ownerScopeId: "personal:owner",
      ref: "skill:explicit",
      granteeScopeId: "personal:alice",
      permission: "read",
      grantedBy: "owner",
    },
    "owner",
  );
  const seen: Array<{ scopes: readonly string[]; grants: unknown }> = [];
  input.skills = {
    visibleFor: async (scopes, grants) => {
      seen.push({ scopes: [...scopes], grants });
      return [];
    },
  } as Pick<NonNullable<typeof input.skills>, "visibleFor"> as NonNullable<typeof input.skills>;
  await (await resolveTurnContext(input)).listSkills();
  assert.deepEqual(seen[0], {
    scopes: ["personal:alice", "channel:eng", "org:test"],
    grants: [{ id: "explicit", ownerScopeId: "personal:owner" }],
  });
  input.audience.push({ id: "bob", type: "internal" });
  input.targetScope = "channel:other";
  removeMember();
  await (await resolveTurnContext(input)).listSkills();
  assert.deepEqual(seen[1], { scopes: ["personal:alice", "org:test"], grants: [] });
});

test("ambiguous file aliases fail closed in the shared reader", async () => {
  const { input } = await fixture();
  input.resolution.grantedHandles = [
    { handlePath: "shared/plan.txt", ownerScopeId: "personal:alice", fileId: "1".repeat(32), permission: "read" },
    { handlePath: "shared/plan.txt", ownerScopeId: "personal:alice", fileId: "2".repeat(32), permission: "read" },
  ];
  const result = await (await resolveTurnContext(input)).readFile("shared/plan.txt");
  assert.ok(result && "error" in result);
  assert.match(result.error, /ambiguous shared handle/);
});

test("skill discovery refreshes carried membership and explicit grants in the same turn", async () => {
  const { input, acl, removeMember } = await fixture();
  const seen: Array<{ scopes: readonly string[]; grants: unknown }> = [];
  input.skills = {
    visibleFor: async (scopes, grants) => {
      seen.push({ scopes: [...scopes], grants });
      return [];
    },
  } as Pick<NonNullable<typeof input.skills>, "visibleFor"> as NonNullable<typeof input.skills>;
  const context = await resolveTurnContext(input);
  assert.deepEqual((await context.listSkills()).sharingSources, ["channel:eng"]);
  await acl.grant(
    {
      ownerScopeId: "personal:owner",
      ref: "skill:new",
      granteeScopeId: "personal:alice",
      permission: "read",
      grantedBy: "owner",
    },
    "owner",
  );
  await context.listSkills();
  assert.deepEqual(seen[1]!.grants, [{ id: "new", ownerScopeId: "personal:owner" }]);
  await acl.revoke("personal:owner", "skill:new", "personal:alice", "owner");
  removeMember();
  assert.deepEqual((await context.listSkills()).sharingSources, []);
  assert.deepEqual(seen[2], { scopes: ["personal:alice", "org:test"], grants: [] });
});

test("source selection precedes name shadowing and preserves skill-level grants", async () => {
  const { input, acl } = await fixture();
  await acl.grant(
    {
      ownerScopeId: "personal:owner",
      ref: "skill:one",
      granteeScopeId: "personal:alice",
      permission: "read",
      grantedBy: "owner",
    },
    "owner",
  );
  const seen: Array<{ scopes: readonly string[]; grants: unknown }> = [];
  input.skills = {
    visibleFor: async (scopes, grants) => {
      seen.push({ scopes: [...scopes], grants });
      return [];
    },
  } as Pick<NonNullable<typeof input.skills>, "visibleFor"> as NonNullable<typeof input.skills>;
  const context = await resolveTurnContext(input);
  await context.listSkills(["org:test"]);
  assert.deepEqual(seen[0], { scopes: ["org:test"], grants: [] });
  await context.listSkills(["personal:owner"]);
  assert.deepEqual(seen[1], { scopes: [], grants: [{ id: "one", ownerScopeId: "personal:owner" }] });
  await context.listSkills(["personal:stranger"]);
  assert.deepEqual(seen[2], { scopes: [], grants: [] });
});

test("semantic recall reuses the turn's memory snapshot instead of reloading notebooks", async () => {
  const { input, memory } = await fixture();
  await memory.capture("org:test", ["ORG_FACT"], Date.now());
  const loads: string[] = [];
  const counted = {
    ...memory,
    facts: async (scope: string) => {
      loads.push(scope);
      return memory.facts!(scope);
    },
  };
  const embedder = { id: "test", embed: async (texts: string[]) => texts.map(() => [1, 0]) };
  input.memory = createSemanticMemoryService(
    counted,
    async () => embedder,
    scoredMemoryIndex(memory, (text) => (text === "LOCAL_FACT" ? 1 : 0)),
  );
  const context = await resolveTurnContext(input);
  const snapshot = await context.memorySnapshot();
  assert.deepEqual(loads.sort(), ["org:test", "personal:alice"]);
  loads.length = 0;
  const recalled = await context.recallMemory("anything", snapshot.loaded);
  assert.deepEqual(
    recalled.map((fact) => fact.text),
    ["- (" + new Date().toISOString().slice(0, 10) + ") LOCAL_FACT"],
  );
  assert.deepEqual(loads, []);
});
