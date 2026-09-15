import assert from "node:assert/strict";
import { test } from "node:test";
import { loopRoutes, type LoopServiceDeps } from "../src/api/routes/loops.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { decideShip } from "../src/loops/ship-gate.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { findRoute } from "../src/api/routes/route.ts";
import type { ApiCtx, Route } from "../src/api/routes/route.ts";
import { scopeId, type Loop, type LoopOutput, type ScopeId, type ShipGrant } from "../src/types.ts";
import { orgId } from "../src/config.ts";
import { createAdminService, type AdminGrant, type AdminService } from "../src/admin/admin-service.ts";
import { createAdminGrantStore, createMemoryAdminGrantPersistence } from "../src/admin/admin-grant-store.ts";
import { ensureFactoryLoop } from "../src/loops/factory/factory-loop.ts";
import { createCanManageScope } from "../src/resolution/scope-membership.ts";

function fakeRes() {
  const out = { status: 0, body: undefined as unknown, writes: 0 };
  return {
    res: {
      writeHead(status: number) {
        out.status = status;
        out.writes += 1;
        return this;
      },
      end(data?: string) {
        out.body = data ? JSON.parse(data) : undefined;
      },
    } as unknown as ApiCtx["res"],
    out,
  };
}

function services(): LoopServiceDeps {
  return {
    store: createLoopStore(),
    items: createLoopItemLedger(),
    outputs: createLoopOutputStore(),
    grants: createShipGrantStore(),
    crons: createCronStore(),
    config: createMemoryConfigStore("org"),
  };
}

interface CallOptions {
  actor?: string;
  mode?: "capability" | "source";
  liveActor?: boolean;
  scope?: ScopeId;
  deps?: Record<string, unknown>;
  app?: Record<string, unknown>;
}

async function call(
  deps: LoopServiceDeps,
  method: string,
  path: string,
  body?: unknown,
  opts: CallOptions = {},
): Promise<{ status: number; body: unknown; writes: number }> {
  const { actor = "josh", mode = "capability", liveActor = true } = opts;
  const found = findRoute(loopRoutes as ReadonlyArray<Route<ApiCtx>>, method, path);
  assert.ok(found, `no route for ${method} ${path}`);
  const { res, out } = fakeRes();
  const url = new URL(`http://x${path}`);
  if (mode === "source") url.searchParams.set("principalId", actor);
  const ctx = {
    res,
    url,
    body,
    params: found.params,
    capability:
      mode === "capability"
        ? {
            actorId: actor,
            scopeId: opts.scope ?? scopeId("personal", actor),
            ...(liveActor ? { liveActor: true } : {}),
            destinations: [{ key: "alerts", label: "Alerts", type: "slack", target: "C-alerts" }],
          }
        : null,
    app: {
      membershipControlsScope: async () => false,
      managesScope: async () => false,
      samePerson: async (a: string, b: string) => a === b,
      ...opts.app,
    },
    deps: { loops: deps, ...opts.deps },
  } as unknown as ApiCtx;
  await found.route.handle(ctx);
  return out;
}

const CREATE = {
  name: "Sentry triage",
  playbook: "triage the issues",
  successCondition: "a fix PR is linked",
  shipActions: [{ action: "open_pr", gate: "hold" }],
};

test("creating a loop with a schedule creates a bound child cron", async () => {
  const deps = services();
  const out = await call(deps, "POST", "/v1/loops", { ...CREATE, schedule: { everyMs: 3_600_000 } });
  assert.equal(out.status, 200);
  const loop = (out.body as { loop: { id: string; cronId?: string; owner: string } }).loop;
  assert.equal(loop.owner, "josh");
  assert.ok(loop.cronId);
  const cron = await deps.crons!.get(loop.cronId!);
  assert.equal(cron?.loopId, loop.id);
  assert.equal(cron?.title, "Loop: Sentry triage");
});

test("create parses and validates schedules before storing the loop", async () => {
  const deps = services();
  const tooFast = await call(deps, "POST", "/v1/loops", { ...CREATE, schedule: { everyMs: 1 } });
  assert.equal(tooFast.status, 400);
  assert.match((tooFast.body as { message: string }).message, /schedule\.everyMs/);
  const nonObject = await call(deps, "POST", "/v1/loops", { ...CREATE, schedule: "hourly" });
  assert.equal(nonObject.status, 400);
  assert.match((nonObject.body as { message: string }).message, /schedule/);
  const calendar = await call(deps, "POST", "/v1/loops", {
    ...CREATE,
    schedule: { cron: "0 * * * *", timezone: "UTC" },
  });
  assert.equal(calendar.status, 200);
  assert.ok((calendar.body as { loop: { cronId?: string } }).loop.cronId);
});

test("create and patch configure a validated escalation destination", async () => {
  const deps = services();
  const invalid = await call(deps, "POST", "/v1/loops", { ...CREATE, destinationKey: "missing" });
  assert.equal(invalid.status, 400);
  const created = await call(deps, "POST", "/v1/loops", { ...CREATE, destinationKey: "alerts" });
  assert.equal(created.status, 200);
  const loop = (created.body as { loop: Loop }).loop;
  assert.equal(loop.destination?.target, "C-alerts");
  const cleared = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { destinationKey: null });
  assert.equal((cleared.body as { loop: Loop }).loop.destination, undefined);
  assert.equal((cleared.body as { loop: Loop }).loop.policyVersion, loop.policyVersion);
  const denied = await call(
    deps,
    "PATCH",
    `/v1/loops/${loop.id}`,
    { destinationKey: "alerts" },
    { actor: "josh", mode: "capability", liveActor: false },
  );
  assert.equal(denied.status, 403);
  assert.equal((denied.body as { error: string }).error, "human_required");
  const restored = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { destinationKey: "alerts" });
  assert.equal((restored.body as { loop: Loop }).loop.destination?.target, "C-alerts");
});

test("reposting a loop with a different schedule creates the requested cron", async () => {
  const deps = services();
  const first = await call(deps, "POST", "/v1/loops", { ...CREATE, schedule: { everyMs: 3_600_000 } });
  const original = (first.body as { loop: { id: string; cronId: string } }).loop;
  const second = await call(deps, "POST", "/v1/loops", { ...CREATE, schedule: { everyMs: 7_200_000 } });
  const body = second.body as { loop: { cronId: string }; created: boolean };
  assert.equal(second.status, 200);
  assert.equal(body.created, true);
  assert.notEqual(body.loop.cronId, original.cronId);
  assert.equal((await deps.crons!.list()).length, 2);
});

test("reposting a loop with an invalid schedule leaves the existing loop intact", async () => {
  const deps = services();
  const first = await call(deps, "POST", "/v1/loops", { ...CREATE, schedule: { everyMs: 3_600_000 } });
  const original = (first.body as { loop: { id: string; cronId: string } }).loop;
  const second = await call(deps, "POST", "/v1/loops", { ...CREATE, schedule: { everyMs: -1 } });
  assert.equal(second.status, 400);
  assert.equal((await deps.store.get(original.id))?.cronId, original.cronId);
  assert.equal((await deps.crons!.list()).length, 1);
});

test("reposting an identical scheduled loop is deduplicated", async () => {
  const deps = services();
  const body = { ...CREATE, schedule: { everyMs: 3_600_000 } };
  const first = await call(deps, "POST", "/v1/loops", body);
  const second = await call(deps, "POST", "/v1/loops", body);
  assert.equal((first.body as { created: boolean }).created, true);
  assert.equal((second.body as { created: boolean }).created, false);
  assert.equal((await deps.crons!.list()).length, 1);
});

test("create validates the essentials", async () => {
  const deps = services();
  assert.equal((await call(deps, "POST", "/v1/loops", { playbook: "p", successCondition: "c" })).status, 400);
  assert.equal(
    (await call(deps, "POST", "/v1/loops", { ...CREATE, shipActions: [{ action: "x", gate: "yolo" }] })).status,
    400,
  );
  assert.equal((await call(deps, "POST", "/v1/loops", { ...CREATE, caps: { maxItemsPerFire: -1 } })).status, 400);
});

test("create and patch reject invalid operational numbers and accept their boundaries", async () => {
  const invalid = [
    ["caps", "maxItemsPerFire", 1.5],
    ["caps", "maxOpenOutputs", 0],
    ["caps", "maxItemAttempts", Number.POSITIVE_INFINITY],
    ["governor", "maxConsecutiveFailedFires", 0],
    ["governor", "returnRateMinDecisions", 1.5],
    ["governor", "maxQueueDepth", Number.NaN],
    ["governor", "maxQueueAgeMs", 0],
    ["governor", "staleFireMs", 1.5],
    ["governor", "maxReturnRate", 1.01],
    ["governor", "maxReturnRate", 0],
  ] as const;
  for (const [section, field, value] of invalid) {
    const deps = services();
    const result = await call(deps, "POST", "/v1/loops", { ...CREATE, [section]: { [field]: value } });
    assert.equal(result.status, 400, `${section}.${field} accepted ${value}`);
    assert.match((result.body as { message: string }).message, new RegExp(field));
  }

  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", {
    ...CREATE,
    caps: { maxItemsPerFire: 1, maxOpenOutputs: 1, maxItemAttempts: 1 },
    governor: {
      maxConsecutiveFailedFires: 1,
      returnRateMinDecisions: 1,
      maxQueueDepth: 1,
      maxQueueAgeMs: 1,
      staleFireMs: 1,
      maxReturnRate: 1,
    },
  });
  assert.equal(created.status, 200);
  const id = (created.body as { loop: { id: string } }).loop.id;
  const patched = await call(deps, "PATCH", `/v1/loops/${id}`, {
    caps: { maxItemsPerFire: 1 },
    governor: { maxReturnRate: Number.NEGATIVE_INFINITY },
  });
  assert.equal(patched.status, 400);
  assert.match((patched.body as { message: string }).message, /maxReturnRate/);
});

test("only a live human can introduce an auto ship gate", async () => {
  const deps = services();
  const deniedCreate = await call(
    deps,
    "POST",
    "/v1/loops",
    { ...CREATE, shipActions: [{ action: "open_pr", gate: "auto" }] },
    { actor: "josh", mode: "capability", liveActor: false },
  );
  assert.equal(deniedCreate.status, 403);
  assert.equal((deniedCreate.body as { error: string }).error, "human_required");
  const signedCreate = await call(
    deps,
    "POST",
    "/v1/loops",
    { ...CREATE, shipActions: [{ action: "open_pr", gate: "auto" }] },
    { actor: "josh", mode: "source" },
  );
  assert.equal(signedCreate.status, 403);
  assert.equal((signedCreate.body as { error: string }).error, "human_required");

  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const id = (created.body as { loop: { id: string } }).loop.id;
  const deniedPatch = await call(
    deps,
    "PATCH",
    `/v1/loops/${id}`,
    { shipActions: [{ action: "open_pr", gate: "auto" }] },
    { actor: "josh", mode: "capability", liveActor: false },
  );
  assert.equal(deniedPatch.status, 403);
  assert.equal((deniedPatch.body as { error: string }).error, "human_required");

  await call(deps, "PATCH", `/v1/loops/${id}`, { shipActions: [{ action: "open_pr", gate: "auto" }] });
  assert.equal(
    (
      await call(
        deps,
        "PATCH",
        `/v1/loops/${id}`,
        { shipActions: [{ action: "open_pr", gate: "auto" }] },
        { actor: "josh", mode: "capability", liveActor: false },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        deps,
        "PATCH",
        `/v1/loops/${id}`,
        { shipActions: [{ action: "open_pr", gate: "hold" }] },
        { actor: "josh", mode: "capability", liveActor: false },
      )
    ).status,
    200,
  );
});

test("create and patch accept the stale-fire governor threshold", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", { ...CREATE, governor: { staleFireMs: 60_000 } });
  assert.equal(created.status, 200);
  const loop = (created.body as { loop: { id: string; governor: { staleFireMs: number } } }).loop;
  assert.equal(loop.governor.staleFireMs, 60_000);
  const patched = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { governor: { staleFireMs: 120_000 } });
  assert.equal((patched.body as { loop: { governor: { staleFireMs: number } } }).loop.governor.staleFireMs, 120_000);
});

test("only the owner may read, patch, or delete a personal loop", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const id = (created.body as { loop: { id: string } }).loop.id;
  assert.equal((await call(deps, "GET", `/v1/loops/${id}`)).status, 200);
  assert.equal((await call(deps, "GET", `/v1/loops/${id}`, undefined, { actor: "mallory" })).status, 403);
  assert.equal((await call(deps, "PATCH", `/v1/loops/${id}`, { name: "stolen" }, { actor: "mallory" })).status, 403);
  assert.equal((await call(deps, "DELETE", `/v1/loops/${id}`, undefined, { actor: "mallory" })).status, 403);
  const list = await call(deps, "GET", "/v1/loops", undefined, { actor: "mallory" });
  assert.deepEqual((list.body as { loops: unknown[] }).loops, []);
});

test("pausing a loop pauses its child cron; re-enabling resumes it", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", { ...CREATE, schedule: { everyMs: 3_600_000 } });
  const loop = (created.body as { loop: { id: string; cronId: string } }).loop;
  await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "paused" });
  assert.equal((await deps.crons!.get(loop.cronId))?.enabled, false);
  await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "enabled" });
  assert.equal((await deps.crons!.get(loop.cronId))?.enabled, true);
});

test("only a live human can clear quarantine and the clearance is audited", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const id = (created.body as { loop: Loop }).loop.id;
  await call(
    deps,
    "PATCH",
    `/v1/loops/${id}`,
    { state: "quarantined" },
    { actor: "josh", mode: "capability", liveActor: false },
  );
  const denied = await call(
    deps,
    "PATCH",
    `/v1/loops/${id}`,
    { state: "enabled" },
    { actor: "josh", mode: "capability", liveActor: false },
  );
  assert.equal(denied.status, 403);
  assert.equal((denied.body as { error: string }).error, "human_required");
  assert.equal((await deps.store.get(id))?.state, "quarantined");
  const cleared = await call(deps, "PATCH", `/v1/loops/${id}`, { state: "enabled" });
  const loop = (cleared.body as { loop: Loop }).loop;
  assert.equal(loop.quarantineClearedBy, "josh");
  assert.equal(typeof loop.quarantineClearedAt, "number");

  await call(deps, "PATCH", `/v1/loops/${id}`, { state: "paused" });
  const agentEnabled = await call(
    deps,
    "PATCH",
    `/v1/loops/${id}`,
    { state: "enabled" },
    { actor: "josh", mode: "capability", liveActor: false },
  );
  assert.equal(agentEnabled.status, 200);
});

test("a playbook edit through PATCH versions the playbook", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const id = (created.body as { loop: { id: string } }).loop.id;
  const patched = await call(deps, "PATCH", `/v1/loops/${id}`, { playbook: "triage harder", note: "tighten" });
  const loop = (patched.body as { loop: { playbookVersion: number; playbook: string } }).loop;
  assert.equal(loop.playbookVersion, 2);
  assert.equal(loop.playbook, "triage harder");
});

test("deleting a loop deletes its child cron and grants", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", { ...CREATE, schedule: { everyMs: 3_600_000 } });
  const loop = (created.body as { loop: { id: string; cronId: string } }).loop;
  await call(deps, "POST", `/v1/loops/${loop.id}/grants`, { shipAction: "open_pr" });
  assert.equal((await call(deps, "DELETE", `/v1/loops/${loop.id}`)).status, 200);
  assert.equal(await deps.crons!.get(loop.cronId), null);
  assert.equal(await deps.store.get(loop.id), null);
  assert.deepEqual(await deps.grants.byLoop(loop.id), []);
});

test("graduating a ship action refuses one the loop never declared", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const id = (created.body as { loop: { id: string } }).loop.id;
  assert.equal((await call(deps, "POST", `/v1/loops/${id}/grants`, { shipAction: "send_email" })).status, 400);
  const ok = await call(deps, "POST", `/v1/loops/${id}/grants`, { shipAction: "open_pr", label: "lint" });
  assert.equal(ok.status, 200);
  const grants = await deps.grants.byLoop(id);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.label, "lint");
});

test("decisions and grants require verified live-human evidence", async () => {
  const deps = services();
  deps.fire = {
    fire: async () => ({ status: "ok" as const }),
    shipOutput: async () => null,
    returnOutput: async () => null,
    sweepStale: async () => {},
    followUp: async () => null,
    itemAction: async () => ({ ok: true }),
  };
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const id = (created.body as { loop: { id: string } }).loop.id;
  const grant = await call(
    deps,
    "POST",
    `/v1/loops/${id}/grants`,
    { shipAction: "open_pr" },
    { actor: "josh", mode: "capability", liveActor: false },
  );
  const decide = await call(
    deps,
    "POST",
    `/v1/loops/${id}/outputs/o1/decide`,
    { decision: "shipped" },
    { actor: "josh", mode: "capability", liveActor: false },
  );
  assert.equal(grant.status, 403);
  assert.equal((grant.body as { error: string }).error, "human_required");
  assert.equal(decide.status, 403);
  assert.equal((decide.body as { error: string }).error, "human_required");
  assert.equal((await call(deps, "POST", `/v1/loops/${id}/grants`, { shipAction: "open_pr" })).status, 200);
  const signedGrant = await call(
    deps,
    "POST",
    `/v1/loops/${id}/grants`,
    { shipAction: "open_pr" },
    { actor: "josh", mode: "source" },
  );
  assert.equal(signedGrant.status, 403);
  assert.equal((signedGrant.body as { error: string }).error, "human_required");
  const signedDecision = await call(
    deps,
    "POST",
    `/v1/loops/${id}/outputs/o1/decide`,
    { decision: "ship" },
    { actor: "josh", mode: "source" },
  );
  assert.equal(signedDecision.status, 403);
  assert.equal((signedDecision.body as { error: string }).error, "human_required");
});

test("ship grants become stale after policy edits and can be revoked by a live human", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const loop = (created.body as { loop: { id: string; policyVersion: number } }).loop;
  const granted = await call(deps, "POST", `/v1/loops/${loop.id}/grants`, { shipAction: "open_pr" });
  const grant = (granted.body as { grant: { id: string; policyVersion: number } }).grant;
  assert.equal(grant.policyVersion, loop.policyVersion);

  const shipPatched = await call(deps, "PATCH", `/v1/loops/${loop.id}`, {
    shipActions: [
      { action: "open_pr", gate: "hold" },
      { action: "send_email", gate: "hold" },
    ],
  });
  const afterShip = (shipPatched.body as { loop: Loop }).loop;
  assert.equal(afterShip.policyVersion, loop.policyVersion + 1);
  const staleGrant = (await deps.grants.get(grant.id))!;
  assert.equal(decideShip(afterShip, { shipAction: "open_pr" }, [staleGrant]).outcome, "hold");
  const playbookPatched = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { playbook: "triage safely" });
  const afterPlaybook = (playbookPatched.body as { loop: Loop }).loop;
  assert.equal(afterPlaybook.policyVersion, afterShip.policyVersion + 1);
  assert.equal(decideShip(afterPlaybook, { shipAction: "open_pr" }, [staleGrant]).outcome, "hold");

  const currentGrant = (await call(deps, "POST", `/v1/loops/${loop.id}/grants`, { shipAction: "open_pr" })).body as {
    grant: ShipGrant;
  };

  const denied = await call(deps, "DELETE", `/v1/loops/${loop.id}/grants/${currentGrant.grant.id}`, undefined, {
    actor: "josh",
    mode: "source",
  });
  assert.equal(denied.status, 403);
  assert.equal((denied.body as { error: string }).error, "human_required");
  const revoked = await call(deps, "DELETE", `/v1/loops/${loop.id}/grants/${currentGrant.grant.id}`);
  assert.equal(revoked.status, 200);
  const revokedGrant = (await deps.grants.get(currentGrant.grant.id))!;
  assert.equal(revokedGrant.revokedBy, "josh");
  assert.equal(decideShip(afterPlaybook, { shipAction: "open_pr" }, [revokedGrant]).outcome, "hold");

  const regranted = (await call(deps, "POST", `/v1/loops/${loop.id}/grants`, { shipAction: "open_pr" })).body as {
    grant: ShipGrant;
  };
  assert.equal(regranted.grant.revokedAt, undefined);
  assert.equal(regranted.grant.revocationHistory?.length, 1);
  assert.equal(decideShip(afterPlaybook, { shipAction: "open_pr" }, [regranted.grant]).outcome, "auto");
});

test("autopilot requires a live human to enable every gate and grant", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", {
    ...CREATE,
    shipActions: [
      { action: "open_pr", gate: "hold" },
      { action: "send_email", gate: "hold" },
    ],
  });
  const loop = (created.body as { loop: Loop }).loop;
  const denied = await call(
    deps,
    "POST",
    `/v1/loops/${loop.id}/autopilot`,
    { enabled: true },
    { actor: "josh", mode: "capability", liveActor: false },
  );
  assert.equal(denied.status, 403);
  assert.equal((denied.body as { error: string }).error, "human_required");

  const enabled = await call(deps, "POST", `/v1/loops/${loop.id}/autopilot`, { enabled: true });
  assert.equal(enabled.status, 200);
  const enabledBody = enabled.body as { loop: Loop; grants: ShipGrant[] };
  assert.ok(enabledBody.loop.shipActions.every((policy) => policy.gate === "auto"));
  assert.equal(enabledBody.loop.policyVersion, loop.policyVersion + 1);
  assert.deepEqual(enabledBody.grants.map((grant) => grant.shipAction).sort(), ["open_pr", "send_email"]);
  assert.ok(enabledBody.grants.every((grant) => grant.revokedAt === undefined));

  const enabledAgain = await call(deps, "POST", `/v1/loops/${loop.id}/autopilot`, { enabled: true });
  const repeated = enabledAgain.body as { loop: Loop; grants: ShipGrant[] };
  assert.equal(repeated.loop.policyVersion, enabledBody.loop.policyVersion);
  assert.deepEqual(repeated.grants, enabledBody.grants);
});

test("an agent can disable autopilot and revoke every active grant", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const loop = (created.body as { loop: Loop }).loop;
  await call(deps, "POST", `/v1/loops/${loop.id}/autopilot`, { enabled: true });

  const disabled = await call(
    deps,
    "POST",
    `/v1/loops/${loop.id}/autopilot`,
    { enabled: false },
    { actor: "josh", mode: "capability", liveActor: false },
  );
  assert.equal(disabled.status, 200);
  const body = disabled.body as { loop: Loop; grants: ShipGrant[] };
  assert.ok(body.loop.shipActions.every((policy) => policy.gate === "hold"));
  assert.ok(body.grants.every((grant) => grant.revokedBy === "josh" && grant.revokedAt !== undefined));

  const stranger = await call(
    deps,
    "POST",
    `/v1/loops/${loop.id}/autopilot`,
    { enabled: false },
    { actor: "mallory", mode: "capability", liveActor: false },
  );
  assert.equal(stranger.status, 403);
});

test("autopilot cannot be enabled on a quarantined loop", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const loop = (created.body as { loop: Loop }).loop;
  await deps.store.setState(loop.id, "quarantined");
  const denied = await call(deps, "POST", `/v1/loops/${loop.id}/autopilot`, { enabled: true });
  assert.equal(denied.status, 409);
  assert.match((denied.body as { message: string }).message, /quarantined/);
});

test("deciding an output ships or returns through the fire service", async () => {
  const deps = services();
  const decisions: string[] = [];
  deps.fire = {
    fire: async () => ({ status: "ok" as const }),
    shipOutput: async (loopId, outputId, actorId) => {
      decisions.push(`ship:${outputId}:${actorId}`);
      return {
        id: outputId,
        loopId,
        itemId: "i1",
        attemptId: "a1",
        shipAction: "open_pr",
        title: "t",
        state: "shipped",
        capturedBy: "agent",
        createdAt: 0,
        updatedAt: 0,
      };
    },
    returnOutput: async (loopId, outputId, actorId, note) => {
      decisions.push(`return:${outputId}:${actorId}:${note}`);
      return {
        id: outputId,
        loopId,
        itemId: "i1",
        attemptId: "a1",
        shipAction: "open_pr",
        title: "t",
        state: "returned",
        capturedBy: "agent",
        createdAt: 0,
        updatedAt: 0,
      };
    },
    sweepStale: async () => {},
    followUp: async () => null,
    itemAction: async () => ({ ok: true }),
  };
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const id = (created.body as { loop: { id: string } }).loop.id;
  assert.equal((await call(deps, "POST", `/v1/loops/${id}/outputs/o1/decide`, { decision: "ship" })).status, 200);
  assert.equal((await call(deps, "POST", `/v1/loops/${id}/outputs/o1/decide`, { decision: "return" })).status, 400);
  assert.equal(
    (await call(deps, "POST", `/v1/loops/${id}/outputs/o1/decide`, { decision: "return", note: "not yet" })).status,
    200,
  );
  assert.deepEqual(decisions, ["ship:o1:josh", "return:o1:josh:not yet"]);
});

test("a failing ship or return reports the cause instead of a bare server error", async () => {
  const deps = services();
  deps.fire = {
    fire: async () => ({ status: "ok" as const }),
    shipOutput: async () => {
      throw new Error("forge_undraft_failed: 403");
    },
    returnOutput: async () => {
      throw new Error("linear_state_missing: Auto-Triage");
    },
    sweepStale: async () => {},
    followUp: async () => null,
    itemAction: async () => ({ ok: true }),
  };
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const id = (created.body as { loop: { id: string } }).loop.id;
  const shipFailed = await call(deps, "POST", `/v1/loops/${id}/outputs/o1/decide`, { decision: "ship" });
  assert.equal(shipFailed.status, 502);
  assert.deepEqual(shipFailed.body, { error: "ship_failed", message: "forge_undraft_failed: 403" });
  const returnFailed = await call(deps, "POST", `/v1/loops/${id}/outputs/o1/decide`, {
    decision: "return",
    note: "not yet",
  });
  assert.equal(returnFailed.status, 502);
  assert.deepEqual(returnFailed.body, { error: "return_failed", message: "linear_state_missing: Auto-Triage" });
});

test("deciding an output reports an active item decision lease", async () => {
  const deps = services();
  deps.fire = {
    fire: async () => ({ status: "ok" as const }),
    shipOutput: async () => null,
    returnOutput: async () => null,
    sweepStale: async () => {},
    followUp: async () => null,
    itemAction: async () => ({ ok: true }),
  };
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const loopId = (created.body as { loop: { id: string } }).loop.id;
  const { item } = await deps.items.enqueue({ loopId, sourceKey: "leased" });
  const output = await deps.outputs.capture({
    loopId,
    itemId: item.id,
    attemptId: "a1",
    shipAction: "open_pr",
    title: "leased",
    capturedBy: "ledger",
  });
  assert.ok(await deps.items.acquireDecision(item.id));
  const result = await call(deps, "POST", `/v1/loops/${loopId}/outputs/${output.id}/decide`, {
    decision: "ship",
  });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: "decision_in_progress" });
});

test("the portal's source-authed path acts as the signed principalId", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", CREATE, { actor: "josh", mode: "source" });
  assert.equal(created.status, 200);
  const id = (created.body as { loop: { id: string; owner: string } }).loop.id;
  assert.equal((created.body as { loop: { owner: string } }).loop.owner, "josh");
  assert.equal((await call(deps, "GET", `/v1/loops/${id}`, undefined, { actor: "josh", mode: "source" })).status, 200);
  assert.equal(
    (await call(deps, "GET", `/v1/loops/${id}`, undefined, { actor: "mallory", mode: "source" })).status,
    403,
  );
  const bare = await call(deps, "GET", "/v1/loops", undefined, { actor: "", mode: "capability" });
  assert.ok(bare.status === 200 || bare.status === 403);
});

test("a source call without a principal is refused", async () => {
  const deps = services();
  const found = findRoute(loopRoutes as ReadonlyArray<Route<ApiCtx>>, "GET", "/v1/loops");
  const { res, out } = fakeRes();
  await found!.route.handle({
    res,
    url: new URL("http://x/v1/loops"),
    body: undefined,
    params: {},
    capability: null,
    app: {},
    deps: { loops: deps },
  } as unknown as ApiCtx);
  assert.equal(out.status, 403);
});

test("a grant failure while enabling autopilot leaves every gate holding", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const loop = (created.body as { loop: Loop }).loop;
  const broken: LoopServiceDeps = {
    ...deps,
    grants: {
      ...deps.grants,
      put: async () => {
        throw new Error("grant store down");
      },
    },
  };
  const out = await call(broken, "POST", `/v1/loops/${loop.id}/autopilot`, { enabled: true });
  assert.equal(out.status, 403);
  assert.equal((out.body as { error: string }).error, "grant_refused");
  const after = await deps.store.get(loop.id);
  assert.ok(after, "loop survives the failed enable");
  assert.ok(
    after.shipActions.every((policy) => policy.gate === "hold"),
    "gates stay held when granting fails",
  );
  assert.equal(after.policyVersion, loop.policyVersion);
  assert.equal(decideShip(after, { shipAction: "open_pr" }, await deps.grants.byLoop(loop.id)).outcome, "hold");
});

test("only a live human can re-enable an archived loop", async () => {
  const deps = services();
  const created = await call(deps, "POST", "/v1/loops", CREATE);
  const loop = (created.body as { loop: Loop }).loop;
  const archived = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "archived" });
  assert.equal(archived.status, 200);
  const denied = await call(
    deps,
    "PATCH",
    `/v1/loops/${loop.id}`,
    { state: "enabled" },
    { actor: "josh", mode: "capability", liveActor: false },
  );
  assert.equal(denied.status, 403);
  assert.equal((denied.body as { error: string }).error, "human_required");
  const revived = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "enabled" });
  assert.equal(revived.status, 200);
  assert.equal((revived.body as { loop: Loop }).loop.state, "enabled");
});

const ORG_SCOPE = scopeId("org", orgId());

const FORBIDDEN = { error: "forbidden", message: "you may not administer this loop" };

function identityStub(deactivated: readonly string[] = []) {
  return {
    refresh: async () => {},
    classify: (id: string) => ({ id, type: deactivated.includes(id) ? "guest" : "internal" }),
  };
}

function adminServiceWith(grants: AdminGrant[]): AdminService {
  return createAdminService(createAdminGrantStore(createMemoryAdminGrantPersistence(), { seed: grants }));
}

const orgGrant = (principalId: string, scope: ScopeId = ORG_SCOPE): AdminGrant => ({
  principalId,
  scopeId: scope,
  role: "org_admin",
});

function factoryLoop(deps: LoopServiceDeps): Promise<Loop> {
  return ensureFactoryLoop(deps.store, { owner: "admin-alice", orgScopeId: ORG_SCOPE });
}

function fireStub(shipped: string[]): LoopServiceDeps["fire"] {
  const output = (loopId: string, id: string, state: LoopOutput["state"]): LoopOutput => ({
    id,
    loopId,
    itemId: "i1",
    attemptId: "a1",
    shipAction: "open_pr",
    title: "t",
    state,
    capturedBy: "agent",
    createdAt: 0,
    updatedAt: 0,
  });
  return {
    fire: async () => ({ status: "ok" as const }),
    shipOutput: async (loopId, outputId, actorId) => {
      shipped.push(`${outputId}:${actorId}`);
      return output(loopId, outputId, "shipped");
    },
    returnOutput: async (loopId, outputId) => output(loopId, outputId, "returned"),
    sweepStale: async () => {},
    followUp: async () => null,
    itemAction: async () => ({ ok: true }),
  };
}

test("a second org admin reads and lists the org-scoped factory loop", async () => {
  const deps = services();
  const loop = await factoryLoop(deps);
  const admin = { admin: createAdminService(), identity: identityStub() };

  const relayed = await call(deps, "GET", `/v1/loops/${loop.id}`, undefined, {
    actor: "admin-bob",
    mode: "source",
    deps: admin,
  });
  assert.equal(relayed.status, 200);
  const read = relayed.body as { loop: Loop; items: unknown[]; outputs: unknown[]; grants: unknown[]; vitals: unknown };
  assert.equal(read.loop.owner, "admin-alice");
  assert.deepEqual([read.items, read.outputs, read.grants], [[], [], []]);
  assert.ok(read.vitals);

  const relayedList = await call(deps, "GET", "/v1/loops", undefined, {
    actor: "admin-bob",
    mode: "source",
    deps: admin,
  });
  assert.deepEqual(
    (relayedList.body as { loops: Loop[] }).loops.map((l) => l.id),
    [loop.id],
  );

  const live = await call(deps, "GET", `/v1/loops/${loop.id}`, undefined, { actor: "admin-bob", deps: admin });
  assert.equal(live.status, 200);
  const liveList = await call(deps, "GET", "/v1/loops", undefined, { actor: "admin-bob", deps: admin });
  assert.deepEqual(
    (liveList.body as { loops: Loop[] }).loops.map((l) => l.id),
    [loop.id],
  );

  const denied = await call(deps, "GET", `/v1/loops/${loop.id}`, undefined, {
    actor: "carol",
    mode: "source",
    deps: admin,
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.writes, 1);
  assert.deepEqual(denied.body, FORBIDDEN);
});

test("a second org admin drives every org loop mutation as themselves", async () => {
  const deps = services();
  const shipped: string[] = [];
  deps.fire = fireStub(shipped);
  const loop = await factoryLoop(deps);
  const admin = { admin: createAdminService(), identity: identityStub() };
  const bob = { actor: "admin-bob", deps: admin };
  const relay = { actor: "admin-bob", mode: "source" as const, deps: admin };

  await deps.store.setState(loop.id, "quarantined");
  const autopilotQuarantined = await call(deps, "POST", `/v1/loops/${loop.id}/autopilot`, { enabled: true }, bob);
  assert.equal(autopilotQuarantined.status, 409);
  const relayedClear = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "enabled" }, relay);
  assert.equal(relayedClear.status, 403);
  assert.equal((relayedClear.body as { error: string }).error, "human_required");
  const cleared = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "enabled" }, bob);
  assert.equal(cleared.status, 200);
  const clearedLoop = (cleared.body as { loop: Loop }).loop;
  assert.equal(clearedLoop.quarantineClearedBy, "admin-bob");
  assert.equal(typeof clearedLoop.quarantineClearedAt, "number");

  assert.equal((await call(deps, "POST", `/v1/loops/${loop.id}/fire`, undefined, bob)).status, 200);
  assert.equal((await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "paused" }, bob)).status, 200);
  const edited = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { playbook: "work the queue" }, bob);
  assert.equal(edited.status, 200);
  const history = (edited.body as { loop: Loop }).loop.playbookHistory;
  assert.equal(history[history.length - 1]?.by, "admin-bob");

  const shipDecision = await call(deps, "POST", `/v1/loops/${loop.id}/outputs/o1/decide`, { decision: "ship" }, bob);
  assert.equal(shipDecision.status, 200);
  assert.deepEqual(shipped, ["o1:admin-bob"]);
  const noteless = await call(deps, "POST", `/v1/loops/${loop.id}/outputs/o1/decide`, { decision: "return" }, bob);
  assert.equal(noteless.status, 400);
  assert.equal((noteless.body as { error: string }).error, "bad_request");

  const granted = await call(deps, "POST", `/v1/loops/${loop.id}/grants`, { shipAction: "open_pr" }, bob);
  assert.equal(granted.status, 200);
  const grant = (granted.body as { grant: ShipGrant }).grant;
  assert.equal(grant.actorId, "admin-bob");
  const undeclared = await call(deps, "POST", `/v1/loops/${loop.id}/grants`, { shipAction: "deploy" }, bob);
  assert.equal(undeclared.status, 400);
  assert.equal((undeclared.body as { error: string }).error, "bad_request");

  assert.equal((await call(deps, "POST", `/v1/loops/${loop.id}/autopilot`, { enabled: true }, bob)).status, 200);
  const off = await call(deps, "POST", `/v1/loops/${loop.id}/autopilot`, { enabled: false }, bob);
  assert.equal(off.status, 200);
  const offBody = off.body as { loop: Loop; grants: ShipGrant[] };
  assert.ok(offBody.loop.shipActions.every((policy) => policy.gate === "hold"));
  assert.ok(offBody.grants.every((g) => g.revokedBy === "admin-bob" && g.revokedAt !== undefined));

  const regranted = await call(deps, "POST", `/v1/loops/${loop.id}/grants`, { shipAction: "open_pr" }, bob);
  const liveGrant = (regranted.body as { grant: ShipGrant }).grant;
  const revoked = await call(deps, "DELETE", `/v1/loops/${loop.id}/grants/${liveGrant.id}`, undefined, bob);
  assert.equal(revoked.status, 200);
  assert.equal((revoked.body as { grant: ShipGrant }).grant.revokedBy, "admin-bob");

  for (const [path, body] of [
    [`/v1/loops/${loop.id}/outputs/o1/decide`, { decision: "ship" }],
    [`/v1/loops/${loop.id}/grants`, { shipAction: "open_pr" }],
    [`/v1/loops/${loop.id}/autopilot`, { enabled: true }],
  ] as const) {
    const refused = await call(deps, "POST", path, body, relay);
    assert.equal(refused.status, 403);
    assert.equal((refused.body as { error: string }).error, "human_required");
  }

  const still = await deps.store.get(loop.id);
  assert.equal(still?.owner, "admin-alice");
  assert.equal(still?.runAs, undefined);
  assert.equal((await call(deps, "DELETE", `/v1/loops/${loop.id}`, undefined, bob)).status, 200);
  assert.equal(await deps.store.get(loop.id), null);
});

test("a non-admin member and a deactivated admin may not administer the org loop", async () => {
  const deps = services();
  deps.fire = fireStub([]);
  const loop = await factoryLoop(deps);
  const admin = {
    admin: adminServiceWith([orgGrant("admin-bob"), orgGrant("admin-dave"), orgGrant("admin-erin", "org:other-org")]),
    identity: identityStub(["admin-dave"]),
  };
  const routes = [
    ["GET", `/v1/loops/${loop.id}`, undefined],
    ["PATCH", `/v1/loops/${loop.id}`, { name: "stolen" }],
    ["POST", `/v1/loops/${loop.id}/fire`, undefined],
    ["POST", `/v1/loops/${loop.id}/outputs/o1/decide`, { decision: "ship" }],
    ["POST", `/v1/loops/${loop.id}/grants`, { shipAction: "open_pr" }],
    ["POST", `/v1/loops/${loop.id}/autopilot`, { enabled: true }],
    ["DELETE", `/v1/loops/${loop.id}`, undefined],
  ] as const;
  for (const actor of ["carol", "admin-dave", "admin-erin"]) {
    for (const [method, path, body] of routes) {
      const out = await call(deps, method, path, body, { actor, deps: admin });
      assert.deepEqual(out.body, FORBIDDEN, `${actor} ${method} ${path}`);
      assert.equal(out.status, 403);
    }
    const listed = await call(deps, "GET", "/v1/loops", undefined, { actor, deps: admin });
    assert.deepEqual(listed.body, { loops: [] });
  }
  assert.equal(
    (await call(deps, "GET", `/v1/loops/${loop.id}`, undefined, { actor: "admin-bob", deps: admin })).status,
    200,
  );

  const unwired = await call(deps, "GET", `/v1/loops/${loop.id}`, undefined, { actor: "admin-bob" });
  assert.equal(unwired.status, 403);
  assert.deepEqual(unwired.body, FORBIDDEN);
  assert.deepEqual((await call(deps, "GET", "/v1/loops", undefined, { actor: "admin-bob" })).body, { loops: [] });
});

test("org admin authority does not widen personal, group or channel loops", async () => {
  const deps = services();
  const orgLoop = await factoryLoop(deps);
  const { loop: personal } = await deps.store.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId: scopeId("personal", "josh"),
    name: "Josh triage",
    playbook: "p",
    successCondition: "c",
  });
  const { loop: group } = await deps.store.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId: "group:g1",
    name: "Group triage",
    playbook: "p",
    successCondition: "c",
  });
  const { loop: channel } = await deps.store.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId: "channel:c1",
    name: "Channel triage",
    playbook: "p",
    successCondition: "c",
    runAs: "scopeShared",
  });
  const admin = { admin: createAdminService(), identity: identityStub() };

  const strangerLoop = await call(deps, "GET", `/v1/loops/${personal.id}`, undefined, {
    actor: "admin-bob",
    deps: admin,
  });
  assert.equal(strangerLoop.status, 403);
  const bobList = await call(deps, "GET", "/v1/loops", undefined, { actor: "admin-bob", deps: admin });
  assert.deepEqual(
    (bobList.body as { loops: Loop[] }).loops.map((l) => l.id),
    [orgLoop.id],
  );
  assert.equal((await call(deps, "GET", `/v1/loops/${personal.id}`, undefined, { actor: "josh" })).status, 200);

  const groupApp = {
    membershipControlsScope: async (scope: ScopeId) => scope === "group:g1",
    managesScope: async (_actor: string, scope: ScopeId) => scope === "group:g1",
  };
  const viaMembership = await call(deps, "GET", `/v1/loops/${group.id}`, undefined, {
    actor: "carol",
    app: groupApp,
    deps: admin,
  });
  assert.equal(viaMembership.status, 200);
  const viaScopeShared = await call(deps, "GET", `/v1/loops/${channel.id}`, undefined, {
    actor: "carol",
    scope: "channel:c1",
    deps: admin,
  });
  assert.equal(viaScopeShared.status, 200);
  assert.equal(await createCanManageScope({})("admin-bob", ORG_SCOPE), false);

  const bobOnly = { admin: adminServiceWith([orgGrant("admin-bob")]), identity: identityStub() };
  const owner = await call(deps, "GET", `/v1/loops/${orgLoop.id}`, undefined, { actor: "admin-alice", deps: bobOnly });
  assert.equal(owner.status, 200);
  const ownerList = await call(deps, "GET", "/v1/loops", undefined, { actor: "admin-alice", deps: bobOnly });
  assert.ok((ownerList.body as { loops: Loop[] }).loops.some((l) => l.id === orgLoop.id));
});
