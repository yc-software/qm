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

test("one context recalls capped, source-labelled memory and shares authority with reads, search, and files", async () => {
  const { input, auditLog } = await fixture();
  const context = await resolveTurnContext(input);
  const recalled = renderRecall(await context.recallMemory(""), new Map());
  assert.match(recalled, /### personal:alice[\s\S]*LOCAL_FACT/);
  assert.match(recalled, /### channel:eng[\s\S]*LAST_FACT/);
  assert.ok(recalled.length <= 6000 && !recalled.includes("long fact"), "prompt memory stays capped");
  assert.equal((await context.memorySnapshot()).held.get("channel:eng")!.size, 3);
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
  assert.match(renderRecall(await (await resolveTurnContext(input)).recallMemory(""), new Map()), /LAST_FACT/);
  removeMember();
  const next = await resolveTurnContext(input);
  assert.doesNotMatch(renderRecall(await next.recallMemory(""), new Map()), /LAST_FACT/);
  assert.equal(await next.readMemory("channel:eng"), null);
  assert.equal(await next.readFile("shared/open-channel-eng/plan.txt"), null);
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
