import "../support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../support/build-app.ts";
import { createControlService } from "../../src/api/control-service.ts";
import { createToolContext, type ToolContextDeps } from "../../src/tools/tool-context.ts";
import { CONTROL_UNAVAILABLE } from "../../src/tools/primitives.ts";
import { scopeId, type WorkspaceLayer } from "../../src/types.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../../src/auth/capability-token.ts";
import type { ToolLedger } from "../../src/runs/tool-ledger.ts";
import type { Sandbox, SandboxHandle } from "../../src/sandbox/sandbox.ts";
import { testConfig } from "../support/test-config.ts";
import { createAgentTools } from "../../src/harness/agent-tools.ts";
import { createTurnToolState } from "../../src/harness/turn-tool-state.ts";
import { createSurfaceToolDeps, type SurfaceToolsContext } from "../../src/core/orchestrator/surface-tools.ts";
import { createPostgresChannelPolicyStore } from "../../src/surface-cache/channel-policy-store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const SECRET = "control-tool-ctx";
const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };

function memoryLedger() {
  const store = new Map<string, string>();
  const ledger: ToolLedger = {
    async begin(runId, attempt, callIndex) {
      const key = `${runId}:${attempt}:${callIndex}`;
      return store.has(key) ? { cached: true, output: store.get(key)! } : { cached: false };
    },
    async record(runId, attempt, callIndex, output) {
      store.set(`${runId}:${attempt}:${callIndex}`, output);
    },
  };
  return { ledger };
}

function build() {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  const control = createControlService(built.app, built.scheduler);
  return { built, control };
}

const claims = (actorId: string): CapabilityClaims => ({
  actorId,
  scopeId: scopeId("personal", actorId),
  destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", actorId) },
  destinations: [
    { key: "k-dm", type: "slack", target: "D1", audienceScopeId: scopeId("personal", actorId), label: "this DM" },
  ],
  defaultDestinationKey: "k-dm",
  exp: Date.now() + CAPABILITY_TTL_MS,
});

function ctxFor(extra: Partial<ToolContextDeps>) {
  const scope = scopeId("personal", "U1");
  const layers: WorkspaceLayer[] = [{ scopeId: scope, mountPath: "", mode: "rw" }];
  return createToolContext({
    sandbox: {} as unknown as Sandbox,
    provision: async () => handle,
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    ...extra,
  });
}

test("createToolContext.cronCreate creates a real cron through the shared service", async () => {
  const { built, control } = build();
  const ctx = ctxFor({ control, controlClaims: claims("U1") });
  const r = await ctx.cronCreate({ title: "digest", schedule: { everyMs: 3_600_000 }, action: "check gmail" });
  assert.ok(r.ok, JSON.stringify(r));
  const stored = await built.app.getCron(r.cron.id);
  assert.ok(stored);
  assert.equal(stored.owner, "U1");
  assert.equal(stored.title, "digest");
});

test("the cron tool lets a live org-admin owner attach unattended admin-read grants and shows them back", async () => {
  const { built } = build();
  const control = createControlService(built.app, built.scheduler, built.admin);
  const ctx = ctxFor({ control, controlClaims: { ...claims("admin-alice"), liveActor: true } });
  const cron = createAgentTools(createTurnToolState({ current: ctx }), { controlTools: true }).find(
    (t) => t.name === "cron",
  )!;
  const run = async (params: Record<string, unknown>) =>
    (
      (await cron.execute("call", params as never, undefined, undefined, {} as never)) as {
        content: Array<{ text: string }>;
      }
    ).content[0]!.text;

  const created = await run({
    action: "create",
    title: "Spend review",
    schedule: { everyMs: 3_600_000 },
    task: "review spend",
    unattendedGrants: ["admin.spend.read", "admin.crons.read"],
  });
  const id = /Created cron (\S+)/.exec(created)?.[1];
  assert.ok(id, created);
  assert.deepEqual((await built.app.getCron(id))?.unattendedGrants, ["admin.spend.read", "admin.crons.read"]);
  assert.match(await run({ action: "get", id }), /unattended grants: admin\.spend\.read, admin\.crons\.read/);

  await run({ action: "patch", id, unattendedGrants: ["admin.spend.read"] });
  assert.deepEqual((await built.app.getCron(id))?.unattendedGrants, ["admin.spend.read"]);

  const nonAdmin = createAgentTools(
    createTurnToolState({ current: ctxFor({ control, controlClaims: { ...claims("U1"), liveActor: true } }) }),
    { controlTools: true },
  ).find((t) => t.name === "cron")!;
  const refused = (
    (await nonAdmin.execute(
      "call",
      {
        action: "create",
        schedule: { everyMs: 3_600_000 },
        task: "review spend",
        unattendedGrants: ["admin.spend.read"],
      } as never,
      undefined,
      undefined,
      {} as never,
    )) as { content: Array<{ text: string }> }
  ).content[0]!.text;
  assert.match(refused, /\[error\].*current org admin/);
});

test("webhook registration through the tool requires a live person and leaves refused calls without effects", async () => {
  const { built, control } = build();
  const request = { action: "handle the event", verification: { scheme: "hmac-sha256" as const, secret: "secret" } };
  const auditBefore = await built.auditLog.events();
  for (const scope of ["personal:U1", "channel:C1"] as const) {
    for (const extra of [
      {},
      { liveActor: false, liveAuthor: false },
      { triggered: true },
      { triggered: true, liveActor: true },
      { triggered: true, liveAuthor: true },
    ]) {
      const ctx = ctxFor({ control, controlClaims: { ...claims("U1"), scopeId: scope, ...extra } });
      const result = await ctx.webhookCreate(request);
      assert.equal(result.ok, false, JSON.stringify({ scope, extra }));
      assert.equal(result.ok ? undefined : result.code, "forbidden");
      assert.deepEqual(await built.app.listWebhooks(), []);
      assert.deepEqual(await built.auditLog.events(), auditBefore);
    }
  }
  for (const extra of [{ liveActor: true }, { liveAuthor: true }]) {
    const ctx = ctxFor({ control, controlClaims: { ...claims("U1"), ...extra } });
    const result = await ctx.webhookCreate(request);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.webhook.owner, "U1");
    assert.equal(result.secret, "secret");
  }
  const [webhook] = await built.app.listWebhooks();
  await built.app.setWebhookEnabled(webhook!.id, false);
  const disabled = await built.app.listWebhooks();
  const auditAfter = await built.auditLog.events();
  const ctx = ctxFor({ control, controlClaims: { ...claims("U1"), triggered: true } });
  const result = await ctx.webhookCreate(request);
  assert.equal(result.ok ? undefined : result.code, "forbidden");
  assert.deepEqual(await built.app.listWebhooks(), disabled);
  assert.deepEqual(await built.auditLog.events(), auditAfter);
});

test("ledger replay: a cron create is CACHED — a crash-replay does NOT create a second cron", async () => {
  const { built, control } = build();
  const { ledger } = memoryLedger();
  const run = "run-cron";

  const first = await ctxFor({ control, controlClaims: claims("U1"), ledger, runId: run }).cronCreate({
    title: "once",
    schedule: { everyMs: 3_600_000 },
    action: "x",
  });
  assert.ok(first.ok);

  const replay = await ctxFor({ control, controlClaims: claims("U1"), ledger, runId: run }).cronCreate({
    title: "once",
    schedule: { everyMs: 3_600_000 },
    action: "x",
  });
  assert.ok(replay.ok);
  assert.deepEqual(replay, first, "replay returns the prior result, not a fresh create");

  const all = await built.app.listCrons();
  assert.equal(all.length, 1, "exactly ONE cron exists despite the replay (no duplicate)");
});

test("ledger replay: a FAILED create is not cached, so a retry can succeed", async () => {
  const { built, control } = build();
  const { ledger } = memoryLedger();
  const run = "run-fail";

  const bad = await ctxFor({ control, controlClaims: claims("U1"), ledger, runId: run }).cronCreate({
    schedule: { everyMs: 3_600_000 },
    text: "x",
    inbox: true,
  });
  assert.equal(bad.ok, false);

  const good = await ctxFor({ control, controlClaims: claims("U1"), ledger, runId: run }).cronCreate({
    schedule: { everyMs: 3_600_000 },
    action: "x",
  });
  assert.ok(good.ok, JSON.stringify(good));
  assert.equal((await built.app.listCrons()).length, 1);
});

test("ledger replay: an instructions write is CACHED — a crash-replay does NOT bump the version again", async () => {
  const { built, control } = build();
  const { ledger } = memoryLedger();
  const run = "run-instructions";

  const first = await ctxFor({ control, controlClaims: claims("U1"), ledger, runId: run }).instructionsWrite("First.");
  assert.ok("ok" in first && first.ok);
  const versionAfterFirst = built.app.getInstructions(scopeId("personal", "U1")).instructionsVersion;

  const replay = await ctxFor({ control, controlClaims: claims("U1"), ledger, runId: run }).instructionsWrite("First.");
  assert.deepEqual(replay, first, "replay returns the cached write result");
  assert.equal(
    built.app.getInstructions(scopeId("personal", "U1")).instructionsVersion,
    versionAfterFirst,
    "the version did NOT bump a second time",
  );
});

test("createToolContext.instructionsWrite then instructionsRead reflect the new instructions", async () => {
  const { control } = build();
  const ctx = ctxFor({ control, controlClaims: claims("U1") });
  const w = await ctx.instructionsWrite("Be brief.");
  assert.ok("ok" in w && w.ok);
  const r = ctx.instructionsRead();
  assert.ok(!("code" in r) || r.code !== "control_unavailable");
  assert.equal((r as { instructions: string | null }).instructions, "Be brief.");
});

test("concurrent instructions edits reject a stale replacement without losing the winner", async () => {
  const { control } = build();
  const ctx = ctxFor({ control, controlClaims: claims("U1") });
  await ctx.instructionsWrite("First rule. Second rule.");
  const entries: string[] = [];
  const tool = createAgentTools(
    createTurnToolState({
      current: ctx,
      scopeLabel: scopeId("personal", "U1"),
      emit: (entry) => {
        entries.push(entry.kind);
      },
    }),
    { controlTools: true },
  ).find((t) => t.name === "instructions")!;
  const edit = (old: string, next: string) =>
    tool
      .execute(old, { action: "edit", old, new: next }, undefined, undefined, {} as never)
      .then((result) => JSON.stringify(result));
  const results = await Promise.all([edit("First rule.", "First updated."), edit("Second rule.", "Second updated.")]);
  assert.equal(results.filter((result) => !result.includes("[error]")).length, 1);
  assert.equal(entries.filter((kind) => kind === "ToolResult").length, 2);
  assert.match(
    results.find((result) => result.includes("[error]"))!,
    /changed/,
  );
  const current = control.readInstructions(claims("U1")).instructions!;
  assert.ok(current === "First updated. Second rule." || current === "First rule. Second updated.");
  const retry = current.includes("First updated.")
    ? await edit("Second rule.", "Second updated.")
    : await edit("First rule.", "First updated.");
  assert.doesNotMatch(retry, /\[error\]/);
  assert.equal(control.readInstructions(claims("U1")).instructions, "First updated. Second updated.");
});

test("channel settings through the instructions tool initialize missing policies and keep omitted state", async () => {
  const channelPolicy = createPostgresChannelPolicyStore(testDatabaseUrl());
  const surface = createSurfaceToolDeps({
    deps: { outbound: {}, channelPolicy, auditLog: { record() {} } },
    input: { surfaceTools: true },
    actor: { id: "U1" },
    conversation: { kind: "channel", channelRef: "C1" },
    session: { id: "S1" },
    scopeId: "channel:C1",
    defaultDestination: {},
  } as unknown as SurfaceToolsContext)!;
  const ctx = ctxFor({ surface });
  const tool = createAgentTools(createTurnToolState({ current: ctx }), { controlTools: true }).find(
    (t) => t.name === "instructions",
  )!;
  const replace = (params: Record<string, unknown>) =>
    tool.execute("settings", { action: "replace", ...params }, undefined, undefined, {} as never);
  await replace({ ambientEnabled: true });
  assert.equal((await channelPolicy.get("C1"))!.ambientEnabled, true);
  await replace({ bots: { news: { mode: "ignore" } } });
  const stored = (await channelPolicy.get("C1"))!;
  assert.equal(stored.ambientEnabled, true, "an omitted ambientEnabled is kept");
  assert.deepEqual(stored.bots, { news: { mode: "ignore" } });
  await replace({ ambientEnabled: null });
  assert.equal((await channelPolicy.get("C1"))!.ambientEnabled, undefined);
  assert.deepEqual((await channelPolicy.get("C1"))!.bots, { news: { mode: "ignore" } });
});

test("without control/controlClaims wired, every control method returns CONTROL_UNAVAILABLE", async () => {
  const ctx = ctxFor({});
  assert.deepEqual(await ctx.cronCreate({ schedule: { everyMs: 1000 }, action: "x" }), CONTROL_UNAVAILABLE);
  assert.deepEqual(await ctx.cronList(), CONTROL_UNAVAILABLE);
  assert.deepEqual(await ctx.cronRuns("cron-1"), CONTROL_UNAVAILABLE);
  assert.deepEqual(await ctx.webhookList(), CONTROL_UNAVAILABLE);
  assert.deepEqual(ctx.instructionsRead(), CONTROL_UNAVAILABLE);
});
