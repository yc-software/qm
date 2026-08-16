import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { createControlService } from "../src/api/control-service.ts";
import { createToolContext, type ToolContextDeps, CONTROL_UNAVAILABLE } from "../src/tools/primitives.ts";
import { scopeId, type WorkspaceLayer } from "../src/types.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import type { ToolLedger } from "../src/runs/tool-ledger.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { testConfig } from "./support/test-config.ts";

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
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "control-tool-ctx-")), signingSecret: SECRET }),
  );
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
    action: "x",
    destinationKey: "nope",
  });
  assert.equal(bad.ok, false);

  const good = await ctxFor({ control, controlClaims: claims("U1"), ledger, runId: run }).cronCreate({
    schedule: { everyMs: 3_600_000 },
    action: "x",
  });
  assert.ok(good.ok, JSON.stringify(good));
  assert.equal((await built.app.listCrons()).length, 1);
});

test("ledger replay: a soul write is CACHED — a crash-replay does NOT bump the version again", async () => {
  const { built, control } = build();
  const { ledger } = memoryLedger();
  const run = "run-soul";

  const first = await ctxFor({ control, controlClaims: claims("U1"), ledger, runId: run }).soulWrite("First.");
  assert.ok("ok" in first && first.ok);
  const versionAfterFirst = built.app.getSoul(scopeId("personal", "U1")).soulVersion;

  const replay = await ctxFor({ control, controlClaims: claims("U1"), ledger, runId: run }).soulWrite("First.");
  assert.deepEqual(replay, first, "replay returns the cached write result");
  assert.equal(
    built.app.getSoul(scopeId("personal", "U1")).soulVersion,
    versionAfterFirst,
    "the version did NOT bump a second time",
  );
});

test("createToolContext.soulWrite then soulRead reflect the new SOUL", async () => {
  const { control } = build();
  const ctx = ctxFor({ control, controlClaims: claims("U1") });
  const w = await ctx.soulWrite("Be brief.");
  assert.ok("ok" in w && w.ok);
  const r = ctx.soulRead();
  assert.ok(!("code" in r) || r.code !== "control_unavailable");
  assert.equal((r as { soul: string | null }).soul, "Be brief.");
});

test("without control/controlClaims wired, every control method returns CONTROL_UNAVAILABLE", async () => {
  const ctx = ctxFor({});
  assert.deepEqual(await ctx.cronCreate({ schedule: { everyMs: 1000 }, action: "x" }), CONTROL_UNAVAILABLE);
  assert.deepEqual(await ctx.cronList(), CONTROL_UNAVAILABLE);
  assert.deepEqual(await ctx.cronRuns("cron-1"), CONTROL_UNAVAILABLE);
  assert.deepEqual(await ctx.webhookList(), CONTROL_UNAVAILABLE);
  assert.deepEqual(ctx.soulRead(), CONTROL_UNAVAILABLE);
});
