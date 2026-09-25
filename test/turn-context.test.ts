import { createAclStore } from "../src/acl/acl-store.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTurnContext } from "../src/resolution/turn-context.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createMemoryService, type MemoryService } from "../src/memory/memory-service.ts";
import { createRoutedMemoryService } from "../src/memory/provider-router.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import type { Resolution, Session } from "../src/types.ts";

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
  const acl = createAclStore();
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
    workspace,
    memory,
    files,
    auditLog,
  };
  await memory.replace("personal:alice", "# Memory\n\n- LOCAL_FACT");
  await memory.replace("channel:eng", `# Memory\n\n- SHARED_FACT\n- ${"long fact ".repeat(1500)}\n- LAST_FACT`);
  await workspace.write("channel:eng", "plan.txt", "PLAN_CONTENT");
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

test("one context loads full source-labelled notebooks and shares authority with search and files", async () => {
  const { input, auditLog } = await fixture();
  const context = await resolveTurnContext(input);
  const recalled = await context.recall();
  assert.match(recalled, /### personal:alice[\s\S]*LOCAL_FACT/);
  assert.match(recalled, /### channel:eng[\s\S]*LAST_FACT/);
  assert.ok(!recalled.includes("SHARED_FACT"), "per-scope recall keeps the bounded tail, not the full notebook");
  assert.deepEqual(await context.searchMemory("LAST_FACT"), ["[channel:eng] LAST_FACT"]);
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
  assert.ok(events.some((e) => e.resource === "plan.txt" && e.detail?.includes("channel:eng")));
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
    assert.doesNotMatch(await context.recall(), /SHARED_FACT|LAST_FACT/);
    assert.deepEqual((await context.searchMemory("LAST_FACT")) ?? [], []);
    if (!mode.startsWith("memory-")) {
      assert.deepEqual(context.listFiles(), []);
      assert.equal(await context.readFile("shared/open-channel-eng/plan.txt"), null);
    }
  });
}

test("fresh turn re-resolves membership after an earlier successful read", async () => {
  const { input, removeMember } = await fixture();
  assert.match(await (await resolveTurnContext(input)).recall(), /LAST_FACT/);
  removeMember();
  const next = await resolveTurnContext(input);
  assert.doesNotMatch(await next.recall(), /LAST_FACT/);
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
    { handlePath: "shared/plan.txt", ownerScopeId: "personal:alice", ownerPath: "one.txt", permission: "read" },
    { handlePath: "shared/plan.txt", ownerScopeId: "personal:alice", ownerPath: "two.txt", permission: "read" },
  ];
  const result = await (await resolveTurnContext(input)).readFile("shared/plan.txt");
  assert.ok(result && "error" in result);
  assert.match(result.error, /ambiguous shared handle/);
});

test("turn recall consults routed external memory providers with the turn context", async () => {
  const calls: string[] = [];
  const external: MemoryService = {
    async recall(scope, context) {
      calls.push(
        `external:${scope}:${context?.query ?? ""}:${context?.actorId ?? ""}:${context?.conversationScopeId ?? ""}`,
      );
      return "- EXTERNAL_FACT";
    },
    async capture() {
      return 0;
    },
    async query() {
      return [];
    },
    async read() {
      return "";
    },
    async replace() {},
  };
  const { input, memory } = await fixture();
  const routed = createRoutedMemoryService({
    providers: { notebook: memory, external },
    routes: [
      { provider: "notebook", scopes: ["personal", "channel", "group", "org"] },
      { provider: "external", scopes: ["personal", "channel", "group", "org"], manage: false },
    ],
  });
  const context = await resolveTurnContext({ ...input, memory: routed, recallQuery: "what is the plan" });
  const recalled = await context.recall();
  assert.ok(
    calls.includes("external:personal:alice:what is the plan:alice:personal:alice"),
    `external provider was not consulted with the turn context, got: ${calls.join(" | ")}`,
  );
  assert.match(recalled, /EXTERNAL_FACT/);
});
