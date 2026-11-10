import type { TurnOrigin } from "../src/types.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTrigger, type TriggerDeps } from "../src/triggers/run-trigger.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId, type Destination, type TurnRequest, type TurnResult } from "../src/types.ts";
import { testMap } from "./support/test-database.ts";

const automationOrigin = (request?: { origin?: TurnOrigin }) =>
  request?.origin?.kind === "automation" ? request.origin : undefined;

const toChannel: Destination = { type: "slack", target: "C1:169.7", audienceScopeId: scopeId("channel", "C1") };

function directory(member: boolean) {
  return {
    channelMember: async () => member,
    groupMember: async () => member,
    listChannelsFor: async () =>
      member
        ? [
            { channelId: "C1", name: "c1" },
            { channelId: "C-private", name: "private" },
          ]
        : [],
    channelPrivacy: async (id: string) => {
      if (id === "C-private") return true;
      return id === "C1" ? false : undefined;
    },
    get: async () => null,
  };
}

function deps(run: (req: TurnRequest) => Promise<TurnResult>, dir?: ReturnType<typeof directory>): TriggerDeps {
  return {
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(testMap()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    run,
    ...(dir ? { directory: dir } : {}),
  };
}

describe("runTrigger: a monitor fire runs first-class live and delivers its own reply", () => {
  it("passes surfaceTools + addressed + the arming destination, and does NOT enqueue the reply", async () => {
    let req: TurnRequest | undefined;
    const d = deps(async (r) => {
      req = r;
      return { status: "ok", reply: "build passed" };
    });
    const out = await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("channel", "C1"),
      input: "report back",
      fireKey: "monitor:m1:exit",
      surface: "monitor",
      threadRef: "C1:169.7",
      destination: toChannel,
    });
    assert.equal(out.ran, true);
    assert.equal(req?.surfaceTools, true, "a monitor fire wires the surface tools");
    assert.equal(req?.addressed, true, "and is addressed so it must reply-or-decline (shed fallback delivers)");
    assert.deepEqual(automationOrigin(req)?.destination, toChannel, "the post tool aims at the arming thread");
    assert.equal(req?.idempotencyKey, "monitor:m1:exit");
    assert.equal((await d.deliveries.pending("slack")).length, 0);
  });

  it("a monitor whose destination is no longer visible stays off the live path: no surface tools, a note, no enqueue", async () => {
    let req: TurnRequest | undefined;
    const d = deps(async (r) => {
      req = r;
      return { status: "ok", reply: "build passed" };
    }, directory(false));
    const out = await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      input: "report back",
      fireKey: "monitor:m2:exit",
      surface: "monitor",
      threadRef: "C1:169.7",
      destination: toChannel,
    });
    assert.equal(req?.surfaceTools, undefined, "a non-visible destination does not get the surface tools");
    assert.match(out.note ?? "", /no longer visible/);
    assert.equal((await d.deliveries.pending("slack")).length, 0, "and nothing is delivered");
  });

  it("§10 leg (a) at fire time: an actor who can no longer READ the trigger's home scope skips the run entirely", async () => {
    let ranTurn = false;
    const d = deps(async () => {
      ranTurn = true;
      return { status: "ok", reply: "should never compose" };
    }, directory(false));
    const out = await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("channel", "C-private"),
      input: "digest the channel",
      fireKey: "cron:c9:1",
      surface: "cron",
      destination: toChannel,
    });
    assert.equal(ranTurn, false, "the turn must not run — it would mount a scope the actor lost");
    assert.equal(out.ran, true, "the fire is consumed and recorded, not mistaken for a dedupe hit");
    assert.equal(out.authzFailed, false, "skip-not-disable: a stale directory must not kill the trigger");
    assert.match(out.note ?? "", /no longer a member/);
    assert.equal((await d.deliveries.pending("slack")).length, 0);
  });

  it("§10 leg (a): a member in good standing runs as before (group home scope)", async () => {
    let ranTurn = false;
    const d = deps(async () => {
      ranTurn = true;
      return { status: "ok", reply: "digest" };
    }, directory(true));
    const out = await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("group", "G1"),
      input: "digest",
      fireKey: "cron:c10:1",
      surface: "cron",
      destination: toChannel,
    });
    assert.equal(ranTurn, true);
    assert.equal(out.ran, true);
    assert.equal((await d.deliveries.pending("slack")).length, 1, "output delivered");
  });

  it("a group-DM home destination (slack-typed, group audience scope) is gated by the GROUPS tables, not the channel tables", async () => {
    const mpimOnly = {
      channelMember: async () => false,
      groupMember: async (id: string, who: string) => id === "C-mpim" && who === "U1",
      listChannelsFor: async () => [],
      channelPrivacy: async () => undefined,
      get: async () => null,
    };
    let req: TurnRequest | undefined;
    const d = deps(
      async (r) => {
        req = r;
        return { status: "ok", reply: "delivered" };
      },
      mpimOnly as unknown as ReturnType<typeof directory>,
    );
    const out = await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      input: "remind us here",
      fireKey: "monitor:m-mpim:exit",
      surface: "monitor",
      threadRef: "C-mpim:169.7",
      destination: { type: "slack", target: "C-mpim:169.7", audienceScopeId: scopeId("group", "C-mpim") },
    });
    assert.equal(out.ran, true);
    assert.equal(req?.surfaceTools, true, "the fire goes live and can deliver into the group DM");
    assert.doesNotMatch(out.note ?? "", /no longer visible/);
  });

  it("a group-DM destination whose owner LEFT the mpim still fails closed", async () => {
    const noOne = {
      channelMember: async () => false,
      groupMember: async () => false,
      listChannelsFor: async () => [],
      channelPrivacy: async () => undefined,
      get: async () => null,
    };
    let req: TurnRequest | undefined;
    const d = deps(
      async (r) => {
        req = r;
        return { status: "ok", reply: "should be held" };
      },
      noOne as unknown as ReturnType<typeof directory>,
    );
    const out = await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      input: "remind us here",
      fireKey: "monitor:m-mpim2:exit",
      surface: "monitor",
      threadRef: "C-mpim:169.7",
      destination: { type: "slack", target: "C-mpim:169.7", audienceScopeId: scopeId("group", "C-mpim") },
    });
    assert.equal(req?.surfaceTools, undefined, "a lost group membership does not go live");
    assert.match(out.note ?? "", /no longer visible/);
    assert.equal((await d.deliveries.pending("slack")).length, 0);
  });

  it("a bare monitor (no destination) runs but neither goes live nor enqueues", async () => {
    let req: TurnRequest | undefined;
    const d = deps(async (r) => {
      req = r;
      return { status: "ok", reply: "noise" };
    });
    const out = await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      input: "watch",
      fireKey: "monitor:m3:exit",
      surface: "monitor",
      threadRef: "t3",
    });
    assert.equal(out.ran, true);
    assert.equal(req?.surfaceTools, undefined);
    assert.equal((await d.deliveries.pending("slack")).length, 0);
  });
});

describe("runTrigger: an autonomous cron does NOT go live (it may be conditionally silent by design)", () => {
  it("only a caller that declares an owner fire produces one", async () => {
    const requests: TurnRequest[] = [];
    const d = deps(async (request) => {
      requests.push(request);
      return { status: "ok" };
    });
    const base = { owner: "U1", ownerScopeId: scopeId("personal", "U1"), input: "scan", surface: "cron" };
    await runTrigger(d, { ...base, fireKey: "cron:unmarked" });
    await runTrigger(d, { ...base, ownerFire: true, fireKey: "cron:marked" });
    assert.deepEqual(
      requests.map((r) => r.origin?.kind === "automation" && r.origin.ownerFire === true),
      [false, true],
    );
  });

  it("a failed fire's error notice carries friendly copy while the fire history keeps the raw reason", async () => {
    const d = deps(async () => ({ status: "failed", reason: "TypeError: fetch failed at sandbox.ts:42" }));
    const out = await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("channel", "C1"),
      input: "report back",
      fireKey: "monitor:m9:exit",
      surface: "monitor",
      threadRef: "C1:169.7",
      destination: toChannel,
      errorNotice: (s) => `⚠️ could not run: ${s}`,
    });
    assert.equal(out.note, "failed: TypeError: fetch failed at sandbox.ts:42", "the operator record keeps the detail");
    const pending = await d.deliveries.pending("slack");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.text, "⚠️ could not run: something went wrong on my end");
  });

  it("a destination-bearing cron keeps the compose-then-enqueue path: no surface tools, one delivery", async () => {
    let req: TurnRequest | undefined;
    const d = deps(async (r) => {
      req = r;
      return { status: "ok", reply: "your digest" };
    });
    await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("channel", "C1"),
      input: "compose the digest",
      fireKey: "cron:c1:t1",
      surface: "cron",
      threadRef: "cron:c1:t1",
      destination: { type: "slack", target: "C1", audienceScopeId: scopeId("channel", "C1") },
    });
    assert.equal(req?.surfaceTools, undefined, "a cron never gets addressed/shed semantics — it may stay silent");
    assert.equal((await d.deliveries.pending("slack")).length, 1, "core delivers the cron reply via the enqueue path");
  });
});

it("leaves a bound scheduled run's outcome to its own run delivery and keeps the failure note", async () => {
  const results: TurnResult[] = [
    {
      status: "pending_approval",
      pendingApprovals: [{ requestId: "approve", command: "send", reason: "approval required" }],
    },
    { status: "ok", reply: "Update" },
    { status: "failed", reason: "boom" },
  ];
  for (const result of results) {
    const d = deps(async (request) => {
      assert.equal(request.deliveryTarget, "web:U1:bound");
      return { ...result, runId: "scheduled-run" };
    });
    const outcome = await runTrigger(d, {
      owner: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      input: "scheduled task",
      fireKey: "cron:1:fire:1",
      surface: "cron",
      destination: {
        type: "webhook",
        target: "web:U1:bound",
        webhook: { binding: "binding", url: "https://receiver.example/qm" },
      },
      errorNotice: () => "failed",
    });
    assert.deepEqual(await d.deliveries.pending("webhook"), []);
    if (result.status === "failed") assert.match(outcome.note ?? "", /boom/);
  }
});

it("keeps shadow webhook results out of terminal-run recovery", async () => {
  let request: TurnRequest | undefined;
  const d = deps(async (submitted) => {
    request = submitted;
    return { status: "ok", reply: "Update", runId: "scheduled-run" };
  });
  await runTrigger(d, {
    owner: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    input: "scheduled task",
    fireKey: "cron:shadow",
    surface: "cron",
    shadow: true,
    destination: {
      type: "webhook",
      target: "web:U1:bound",
      webhook: { binding: "binding", url: "https://receiver.example/qm" },
    },
  });
  assert.ok(request);
  assert.equal(request.deliveryTarget, undefined);
  assert.deepEqual(await d.deliveries.pending("webhook"), []);
  assert.equal((await d.deliveries.listShadow()).length, 1);
});

describe("runTrigger: a turn abandoned while still queued leaves the fire retryable", () => {
  it("sends the error notice and throws without spending the fire key", async () => {
    const d = deps(async () => ({ status: "queued", sessionId: "s1", runId: "r1" }));
    await assert.rejects(
      runTrigger(d, {
        owner: "U1",
        ownerScopeId: scopeId("channel", "C1"),
        input: "report back",
        fireKey: "cron:c7:2000",
        surface: "cron",
        threadRef: "cron:c7:2000",
        destination: toChannel,
        errorNotice: (s: string) => `⚠️ could not run: ${s}`,
      }),
      /still waiting to finish when this process shut down/,
    );
    assert.equal(await d.idempotency.committed("cron:c7:2000"), false);
    const pending = await d.deliveries.pending("slack");
    assert.equal(pending.length, 1);
    assert.match(pending[0]!.text, /^⚠️ could not run:/);
  });

  it("a trigger that re-drives its unspent fire throws without a notice", async () => {
    const d = deps(async () => ({ status: "queued", sessionId: "s1", runId: "r1" }));
    await assert.rejects(
      runTrigger(d, {
        owner: "U1",
        ownerScopeId: scopeId("channel", "C1"),
        input: "report back",
        fireKey: "cron:c8:manual:1",
        surface: "cron",
        threadRef: "cron:c8:manual:1",
        destination: toChannel,
        redrivesHandOff: true,
        errorNotice: (s: string) => `⚠️ could not run: ${s}`,
      }),
      /still waiting to finish when this process shut down/,
    );
    assert.equal(await d.idempotency.committed("cron:c8:manual:1"), false);
    assert.deepEqual(await d.deliveries.pending("slack"), []);
  });
});
