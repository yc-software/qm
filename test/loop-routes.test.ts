import assert from "node:assert/strict";
import { test } from "node:test";
import { loopRoutes, type LoopServiceDeps } from "../src/api/routes/loops.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { decideShip } from "../src/loops/ship-gate.ts";
import type { LoopFireService } from "../src/loops/loop-fire.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { findRoute } from "../src/api/routes/route.ts";
import type { ApiCtx, Route } from "../src/api/routes/route.ts";
import { scopeId, type Loop, type ShipGrant } from "../src/types.ts";

function fakeRes() {
  const out = { status: 0, body: undefined as unknown };
  return {
    res: {
      writeHead(status: number) {
        out.status = status;
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

type CallOpts = { actor?: string; source?: boolean; live?: boolean; admin?: boolean; manages?: boolean };
const AGENT: CallOpts = { live: false };
const SIGNED: CallOpts = { source: true };

async function call(
  deps: LoopServiceDeps,
  method: string,
  path: string,
  body?: unknown,
  { actor = "josh", source = false, live = true, admin = true, manages = false }: CallOpts = {},
): Promise<{ status: number; body: unknown }> {
  const found = findRoute(loopRoutes as ReadonlyArray<Route<ApiCtx>>, method, path);
  assert.ok(found, `no route for ${method} ${path}`);
  const { res, out } = fakeRes();
  const url = new URL(`http://x${path}`);
  if (source) url.searchParams.set("principalId", actor);
  const ctx = {
    res,
    url,
    body,
    params: found.params,
    capability: source
      ? null
      : {
          actorId: actor,
          scopeId: scopeId("personal", actor),
          ...(live ? { liveActor: true } : {}),
          destinations: [{ key: "alerts", label: "Alerts", type: "slack", target: "C-alerts" }],
        },
    app: {
      membershipControlsScope: async () => false,
      managesScope: async () => manages,
      samePerson: async (a: string, b: string) => a === b,
    },
    deps: { loops: deps, admin: { adminStatusOf: async () => ({ isAdmin: admin }) } },
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
const HOURLY = { ...CREATE, schedule: { everyMs: 3_600_000 } };
const AUTO_PR = { shipActions: [{ action: "open_pr", gate: "auto" }] };

async function createLoop(deps: LoopServiceDeps, body: object = CREATE, opts?: CallOpts): Promise<Loop> {
  const out = await call(deps, "POST", "/v1/loops", body, opts);
  assert.equal(out.status, 200);
  return (out.body as { loop: Loop }).loop;
}

const loopOf = (out: { body: unknown }) => (out.body as { loop: Loop }).loop;

function assertHumanRequired(out: { status: number; body: unknown }) {
  assert.equal(out.status, 403);
  assert.equal((out.body as { error: string }).error, "human_required");
}

function stubFire(over: Partial<LoopFireService> = {}): LoopFireService {
  return {
    fire: async () => ({ status: "ok" as const }),
    shipOutput: async () => null,
    returnOutput: async () => null,
    sweepStale: async () => {},
    followUp: async () => null,
    itemAction: async () => ({ ok: true }),
    ...over,
  } as LoopFireService;
}

test("creating a loop with a schedule creates a bound child cron", async () => {
  const deps = services();
  const loop = await createLoop(deps, HOURLY);
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
  const calendar = await createLoop(deps, { ...CREATE, schedule: { cron: "0 * * * *", timezone: "UTC" } });
  assert.ok(calendar.cronId);
});

test("create and patch configure a validated escalation destination", async () => {
  const deps = services();
  assert.equal((await call(deps, "POST", "/v1/loops", { ...CREATE, destinationKey: "missing" })).status, 400);
  const loop = await createLoop(deps, { ...CREATE, destinationKey: "alerts" });
  assert.equal(loop.destination?.target, "C-alerts");
  const cleared = loopOf(await call(deps, "PATCH", `/v1/loops/${loop.id}`, { destinationKey: null }));
  assert.equal(cleared.destination, undefined);
  assert.equal(cleared.policyVersion, loop.policyVersion);
  assertHumanRequired(await call(deps, "PATCH", `/v1/loops/${loop.id}`, { destinationKey: "alerts" }, AGENT));
  const restored = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { destinationKey: "alerts" });
  assert.equal(loopOf(restored).destination?.target, "C-alerts");
});

test("reposting a loop with a different schedule creates the requested cron", async () => {
  const deps = services();
  const original = await createLoop(deps, HOURLY);
  const second = await call(deps, "POST", "/v1/loops", { ...CREATE, schedule: { everyMs: 7_200_000 } });
  const body = second.body as { loop: { cronId: string }; created: boolean };
  assert.equal(second.status, 200);
  assert.equal(body.created, true);
  assert.notEqual(body.loop.cronId, original.cronId);
  assert.equal((await deps.crons!.list()).length, 2);
});

test("reposting a loop with an invalid schedule leaves the existing loop intact", async () => {
  const deps = services();
  const original = await createLoop(deps, HOURLY);
  const second = await call(deps, "POST", "/v1/loops", { ...CREATE, schedule: { everyMs: -1 } });
  assert.equal(second.status, 400);
  assert.equal((await deps.store.get(original.id))?.cronId, original.cronId);
  assert.equal((await deps.crons!.list()).length, 1);
});

test("reposting an identical scheduled loop is deduplicated", async () => {
  const deps = services();
  const first = await call(deps, "POST", "/v1/loops", HOURLY);
  const second = await call(deps, "POST", "/v1/loops", HOURLY);
  assert.equal((first.body as { created: boolean }).created, true);
  assert.equal((second.body as { created: boolean }).created, false);
  assert.equal((await deps.crons!.list()).length, 1);
});

test("create validates the essentials", async () => {
  const deps = services();
  for (const body of [
    { playbook: "p", successCondition: "c" },
    { ...CREATE, shipActions: [{ action: "x", gate: "yolo" }] },
    { ...CREATE, caps: { maxItemsPerFire: -1 } },
  ])
    assert.equal((await call(deps, "POST", "/v1/loops", body)).status, 400);
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
  const { id } = await createLoop(deps, {
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
  const patched = await call(deps, "PATCH", `/v1/loops/${id}`, {
    caps: { maxItemsPerFire: 1 },
    governor: { maxReturnRate: Number.NEGATIVE_INFINITY },
  });
  assert.equal(patched.status, 400);
  assert.match((patched.body as { message: string }).message, /maxReturnRate/);
});

test("only a live human can introduce an auto ship gate", async () => {
  const deps = services();
  assertHumanRequired(await call(deps, "POST", "/v1/loops", { ...CREATE, ...AUTO_PR }, AGENT));
  assertHumanRequired(await call(deps, "POST", "/v1/loops", { ...CREATE, ...AUTO_PR }, SIGNED));
  const { id } = await createLoop(deps);
  assertHumanRequired(await call(deps, "PATCH", `/v1/loops/${id}`, AUTO_PR, AGENT));
  await call(deps, "PATCH", `/v1/loops/${id}`, AUTO_PR);
  assert.equal((await call(deps, "PATCH", `/v1/loops/${id}`, AUTO_PR, AGENT)).status, 200);
  const hold = { shipActions: [{ action: "open_pr", gate: "hold" }] };
  assert.equal((await call(deps, "PATCH", `/v1/loops/${id}`, hold, AGENT)).status, 200);
});

test("create and patch accept the stale-fire governor threshold", async () => {
  const deps = services();
  const loop = await createLoop(deps, { ...CREATE, governor: { staleFireMs: 60_000 } });
  assert.equal(loop.governor?.staleFireMs, 60_000);
  const patched = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { governor: { staleFireMs: 120_000 } });
  assert.equal(loopOf(patched).governor?.staleFireMs, 120_000);
});

test("only the owner may read, patch, or delete a personal loop", async () => {
  const deps = services();
  const { id } = await createLoop(deps);
  const mallory = { actor: "mallory" };
  assert.equal((await call(deps, "GET", `/v1/loops/${id}`)).status, 200);
  assert.equal((await call(deps, "GET", `/v1/loops/${id}`, undefined, mallory)).status, 403);
  assert.equal((await call(deps, "PATCH", `/v1/loops/${id}`, { name: "stolen" }, mallory)).status, 403);
  assert.equal((await call(deps, "DELETE", `/v1/loops/${id}`, undefined, mallory)).status, 403);
  const list = await call(deps, "GET", "/v1/loops", undefined, mallory);
  assert.deepEqual((list.body as { loops: unknown[] }).loops, []);
});

test("pausing a loop pauses its child cron; re-enabling resumes it", async () => {
  const deps = services();
  const loop = await createLoop(deps, HOURLY);
  await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "paused" });
  assert.equal((await deps.crons!.get(loop.cronId!))?.enabled, false);
  await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "enabled" });
  assert.equal((await deps.crons!.get(loop.cronId!))?.enabled, true);
});

test("only a live human can clear quarantine and the clearance is audited", async () => {
  const deps = services();
  const { id } = await createLoop(deps);
  await call(deps, "PATCH", `/v1/loops/${id}`, { state: "quarantined" }, AGENT);
  assertHumanRequired(await call(deps, "PATCH", `/v1/loops/${id}`, { state: "enabled" }, AGENT));
  assert.equal((await deps.store.get(id))?.state, "quarantined");
  const loop = loopOf(await call(deps, "PATCH", `/v1/loops/${id}`, { state: "enabled" }));
  assert.equal(loop.quarantineClearedBy, "josh");
  assert.equal(typeof loop.quarantineClearedAt, "number");

  await call(deps, "PATCH", `/v1/loops/${id}`, { state: "paused" });
  assert.equal((await call(deps, "PATCH", `/v1/loops/${id}`, { state: "enabled" }, AGENT)).status, 200);
});

test("a playbook edit through PATCH versions the playbook", async () => {
  const deps = services();
  const { id } = await createLoop(deps);
  const loop = loopOf(await call(deps, "PATCH", `/v1/loops/${id}`, { playbook: "triage harder", note: "tighten" }));
  assert.equal(loop.playbookVersion, 2);
  assert.equal(loop.playbook, "triage harder");
});

test("deleting a loop deletes its child cron and grants", async () => {
  const deps = services();
  const loop = await createLoop(deps, HOURLY);
  await call(deps, "POST", `/v1/loops/${loop.id}/grants`, { shipAction: "open_pr" });
  assert.equal((await call(deps, "DELETE", `/v1/loops/${loop.id}`)).status, 200);
  assert.equal(await deps.crons!.get(loop.cronId!), null);
  assert.equal(await deps.store.get(loop.id), null);
  assert.deepEqual(await deps.grants.byLoop(loop.id), []);
});

test("graduating a ship action refuses one the loop never declared", async () => {
  const deps = services();
  const { id } = await createLoop(deps);
  assert.equal((await call(deps, "POST", `/v1/loops/${id}/grants`, { shipAction: "send_email" })).status, 400);
  const ok = await call(deps, "POST", `/v1/loops/${id}/grants`, { shipAction: "open_pr", label: "lint" });
  assert.equal(ok.status, 200);
  const grants = await deps.grants.byLoop(id);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]?.label, "lint");
});

test("decisions and grants require verified live-human evidence", async () => {
  const deps = services();
  deps.fire = stubFire();
  const { id } = await createLoop(deps);
  const grants = `/v1/loops/${id}/grants`;
  const decide = `/v1/loops/${id}/outputs/o1/decide`;
  assertHumanRequired(await call(deps, "POST", grants, { shipAction: "open_pr" }, AGENT));
  assertHumanRequired(await call(deps, "POST", decide, { decision: "shipped" }, AGENT));
  assert.equal((await call(deps, "POST", grants, { shipAction: "open_pr" })).status, 200);
  assertHumanRequired(await call(deps, "POST", grants, { shipAction: "open_pr" }, SIGNED));
  assertHumanRequired(await call(deps, "POST", decide, { decision: "ship" }, SIGNED));
});

test("ship grants become stale after policy edits and can be revoked by a live human", async () => {
  const deps = services();
  const loop = await createLoop(deps);
  const grantFor = async () =>
    ((await call(deps, "POST", `/v1/loops/${loop.id}/grants`, { shipAction: "open_pr" })).body as { grant: ShipGrant })
      .grant;
  const grant = await grantFor();
  assert.equal(grant.policyVersion, loop.policyVersion);

  const afterShip = loopOf(
    await call(deps, "PATCH", `/v1/loops/${loop.id}`, {
      shipActions: [
        { action: "open_pr", gate: "hold" },
        { action: "send_email", gate: "hold" },
      ],
    }),
  );
  assert.equal(afterShip.policyVersion, loop.policyVersion + 1);
  const staleGrant = (await deps.grants.get(grant.id))!;
  assert.equal(decideShip(afterShip, { shipAction: "open_pr" }, [staleGrant]).outcome, "hold");
  const afterPlaybook = loopOf(await call(deps, "PATCH", `/v1/loops/${loop.id}`, { playbook: "triage safely" }));
  assert.equal(afterPlaybook.policyVersion, afterShip.policyVersion + 1);
  assert.equal(decideShip(afterPlaybook, { shipAction: "open_pr" }, [staleGrant]).outcome, "hold");

  const current = await grantFor();
  const revokePath = `/v1/loops/${loop.id}/grants/${current.id}`;
  assertHumanRequired(await call(deps, "DELETE", revokePath, undefined, SIGNED));
  assert.equal((await call(deps, "DELETE", revokePath)).status, 200);
  const revokedGrant = (await deps.grants.get(current.id))!;
  assert.equal(revokedGrant.revokedBy, "josh");
  assert.equal(decideShip(afterPlaybook, { shipAction: "open_pr" }, [revokedGrant]).outcome, "hold");

  const regranted = await grantFor();
  assert.equal(regranted.revokedAt, undefined);
  assert.equal(regranted.revocationHistory?.length, 1);
  assert.equal(decideShip(afterPlaybook, { shipAction: "open_pr" }, [regranted]).outcome, "auto");
});

test("autopilot requires a live human to enable every gate and grant", async () => {
  const deps = services();
  const loop = await createLoop(deps, {
    ...CREATE,
    shipActions: [
      { action: "open_pr", gate: "hold" },
      { action: "send_email", gate: "hold" },
    ],
  });
  const autopilot = `/v1/loops/${loop.id}/autopilot`;
  assertHumanRequired(await call(deps, "POST", autopilot, { enabled: true }, AGENT));

  const enabled = await call(deps, "POST", autopilot, { enabled: true });
  assert.equal(enabled.status, 200);
  const enabledBody = enabled.body as { loop: Loop; grants: ShipGrant[] };
  assert.ok(enabledBody.loop.shipActions.every((policy) => policy.gate === "auto"));
  assert.equal(enabledBody.loop.policyVersion, loop.policyVersion + 1);
  assert.deepEqual(enabledBody.grants.map((grant) => grant.shipAction).sort(), ["open_pr", "send_email"]);
  assert.ok(enabledBody.grants.every((grant) => grant.revokedAt === undefined));

  const repeated = (await call(deps, "POST", autopilot, { enabled: true })).body as { loop: Loop; grants: ShipGrant[] };
  assert.equal(repeated.loop.policyVersion, enabledBody.loop.policyVersion);
  assert.deepEqual(repeated.grants, enabledBody.grants);
});

test("an agent can disable autopilot and revoke every active grant", async () => {
  const deps = services();
  const loop = await createLoop(deps);
  const autopilot = `/v1/loops/${loop.id}/autopilot`;
  await call(deps, "POST", autopilot, { enabled: true });

  const disabled = await call(deps, "POST", autopilot, { enabled: false }, AGENT);
  assert.equal(disabled.status, 200);
  const body = disabled.body as { loop: Loop; grants: ShipGrant[] };
  assert.ok(body.loop.shipActions.every((policy) => policy.gate === "hold"));
  assert.ok(body.grants.every((grant) => grant.revokedBy === "josh" && grant.revokedAt !== undefined));

  const stranger = await call(deps, "POST", autopilot, { enabled: false }, { actor: "mallory", live: false });
  assert.equal(stranger.status, 403);
});

test("autopilot cannot be enabled on a quarantined loop", async () => {
  const deps = services();
  const loop = await createLoop(deps);
  await deps.store.setState(loop.id, "quarantined");
  const denied = await call(deps, "POST", `/v1/loops/${loop.id}/autopilot`, { enabled: true });
  assert.equal(denied.status, 409);
  assert.match((denied.body as { message: string }).message, /quarantined/);
});

test("deciding an output ships or returns through the fire service", async () => {
  const deps = services();
  const decisions: string[] = [];
  const output = (loopId: string, id: string, state: "shipped" | "returned") => ({
    id,
    loopId,
    itemId: "i1",
    attemptId: "a1",
    shipAction: "open_pr",
    title: "t",
    state,
    capturedBy: "agent" as const,
    createdAt: 0,
    updatedAt: 0,
  });
  deps.fire = stubFire({
    shipOutput: async (loopId, outputId, actorId) => {
      decisions.push(`ship:${outputId}:${actorId}`);
      return output(loopId, outputId, "shipped");
    },
    returnOutput: async (loopId, outputId, actorId, note) => {
      decisions.push(`return:${outputId}:${actorId}:${note}`);
      return output(loopId, outputId, "returned");
    },
  });
  const { id } = await createLoop(deps);
  const decide = `/v1/loops/${id}/outputs/o1/decide`;
  assert.equal((await call(deps, "POST", decide, { decision: "ship" })).status, 200);
  assert.equal((await call(deps, "POST", decide, { decision: "return" })).status, 400);
  assert.equal((await call(deps, "POST", decide, { decision: "return", note: "not yet" })).status, 200);
  assert.deepEqual(decisions, ["ship:o1:josh", "return:o1:josh:not yet"]);
});

test("deciding an output reports an active item decision lease", async () => {
  const deps = services();
  deps.fire = stubFire();
  const { id: loopId } = await createLoop(deps);
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
  const result = await call(deps, "POST", `/v1/loops/${loopId}/outputs/${output.id}/decide`, { decision: "ship" });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: "decision_in_progress" });
});

test("the portal's source-authed path acts as the signed principalId", async () => {
  const deps = services();
  const loop = await createLoop(deps, CREATE, SIGNED);
  assert.equal(loop.owner, "josh");
  assert.equal((await call(deps, "GET", `/v1/loops/${loop.id}`, undefined, SIGNED)).status, 200);
  const mallory = { actor: "mallory", source: true };
  assert.equal((await call(deps, "GET", `/v1/loops/${loop.id}`, undefined, mallory)).status, 403);
  const bare = await call(deps, "GET", "/v1/loops", undefined, { actor: "" });
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
  const loop = await createLoop(deps);
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
  const loop = await createLoop(deps);
  assert.equal((await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "archived" })).status, 200);
  assertHumanRequired(await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "enabled" }, AGENT));
  const revived = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "enabled" });
  assert.equal(revived.status, 200);
  assert.equal(loopOf(revived).state, "enabled");
});

async function privilegedLoop(deps: LoopServiceDeps): Promise<Loop> {
  const loop = await createLoop(deps, { ...CREATE, schedule: { everyMs: 60_000 } });
  await deps.crons!.update(loop.cronId!, { unattendedGrants: ["admin.sessions.read"] });
  return loop;
}

test("privileged loop config and manual fires use the cron live-owner-admin gate", async () => {
  const deps = services();
  const loop = await privilegedLoop(deps);
  let fires = 0;
  deps.fire = {
    fire: async () => {
      fires++;
      return { status: "ok" };
    },
  } as never;
  for (const [method, suffix, body] of [
    ["PATCH", "", { playbook: "changed instructions" }],
    ["PATCH", "", { successCondition: "changed condition" }],
    ["PATCH", "", { state: "enabled" }],
    ["POST", "/fire", {}],
    ["POST", "/autopilot", { enabled: true }],
    ["POST", "/grants", { shipAction: "open_pr" }],
    ["POST", "/outputs/output/decide", { decision: "return", note: "new instructions" }],
  ] as const) {
    const path = `/v1/loops/${loop.id}${suffix}`;
    for (const opts of [AGENT, { admin: false }, { actor: "mallory", manages: true }, SIGNED])
      assert.equal((await call(deps, method, path, body, opts)).status, 403);
  }
  assert.equal(fires, 0);
  assert.equal((await deps.store.get(loop.id))?.playbook, loop.playbook);
  const permitted = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { playbook: "owner revision" });
  assert.equal(permitted.status, 200);
  assert.deepEqual((await deps.crons!.get(loop.cronId!))?.unattendedGrants, ["admin.sessions.read"]);
  assert.equal((await call(deps, "POST", `/v1/loops/${loop.id}/fire`, {})).status, 200);
  assert.equal(fires, 1);
  await deps.crons!.update(loop.cronId!, { unattendedGrants: [] });
  const ordinary = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { playbook: "ordinary revision" }, AGENT);
  assert.equal(ordinary.status, 200);
});

test("loop mutation and manual fire reject a drifted native binding", async () => {
  const deps = services();
  const loop = await privilegedLoop(deps);
  await deps.crons!.update(loop.cronId!, { runAs: "scopeFloor" });
  assert.equal((await call(deps, "PATCH", `/v1/loops/${loop.id}`, { playbook: "revision" })).status, 409);
  assert.equal((await call(deps, "POST", `/v1/loops/${loop.id}/fire`, {})).status, 409);
  assert.equal((await deps.store.get(loop.id))?.playbook, loop.playbook);
});

test("a legacy inbox sync cron cannot be re-enabled through an autonomous Loop patch", async () => {
  const deps = services();
  const { loop } = await deps.store.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId: scopeId("personal", "josh"),
    ...CREATE,
    surface: "inbox",
    shipActions: [],
  });
  const cron = await deps.crons!.create({
    owner: loop.owner,
    createdBy: loop.owner,
    ownerScopeId: loop.ownerScopeId,
    schedule: { everyMs: 60_000 },
    action: "Inbox sync v3.",
    unattendedGrants: ["admin.sessions.read"],
  });
  await deps.store.update(loop.id, { cronId: cron.id, state: "paused" });
  await deps.crons!.setEnabled(cron.id, false);
  assert.equal((await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "enabled" }, AGENT)).status, 403);
  assert.equal((await deps.crons!.get(cron.id))?.enabled, false);
  assert.equal((await call(deps, "PATCH", `/v1/loops/${loop.id}`, { state: "enabled" })).status, 200);
  assert.equal((await deps.crons!.get(cron.id))?.enabled, true);
});

test("loop icons can be set and reset by their owner, reject invalid input and retain authorization", async () => {
  const deps = services();
  const iconLoop = { name: "Icons", playbook: "Review", successCondition: "Done", shipActions: [] };
  const loop = await createLoop(deps, { ...iconLoop, icon: "bug" });
  assert.equal(loop.icon, "bug");
  for (const icon of [
    "rocket",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    null,
  ]) {
    const result = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { icon });
    assert.equal(result.status, 200);
    assert.equal(loopOf(result).icon, icon ?? undefined);
  }
  for (const icon of ["", "<svg>", "x".repeat(49), 7, {}]) {
    assert.equal((await call(deps, "PATCH", `/v1/loops/${loop.id}`, { icon })).status, 400);
    assert.equal((await call(deps, "POST", "/v1/loops", { ...iconLoop, name: "Invalid", icon })).status, 400);
  }
  const stolen = await call(deps, "PATCH", `/v1/loops/${loop.id}`, { icon: "shield" }, { actor: "mallory" });
  assert.equal(stolen.status, 403);
});
