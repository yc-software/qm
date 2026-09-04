import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTrigger, type TriggerDeps } from "../src/triggers/run-trigger.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId, type Destination, type TurnRequest, type TurnResult } from "../src/types.ts";

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
    idempotency: createIdempotencyStore(createMemoryMap()),
    identity: createIdentityService(),
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
    assert.deepEqual(req?.triggerDestination, toChannel, "the post tool aims at the arming thread");
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
  it("threads grants for owner mode but omits them for scopeFloor and scopeShared", async () => {
    const requests: TurnRequest[] = [];
    const d = deps(async (request) => {
      requests.push(request);
      return { status: "ok" };
    });
    const base = {
      owner: "U1",
      ownerScopeId: scopeId("personal", "U1"),
      input: "scan",
      surface: "cron",
      unattendedGrants: ["admin.sessions.read"],
    };
    await runTrigger(d, { ...base, fireKey: "cron:owner" });
    await runTrigger(d, {
      ...base,
      fireKey: "cron:floor",
      runAs: "scopeFloor",
      members: [{ id: "U1", type: "internal" }],
    });
    await runTrigger(d, {
      ...base,
      fireKey: "cron:shared",
      runAs: "scopeShared",
      members: [{ id: "U1", type: "internal" }],
    });
    assert.deepEqual(requests[0]?.unattendedGrants, ["admin.sessions.read"]);
    assert.equal(requests[1]?.unattendedGrants, undefined);
    assert.equal(requests[2]?.unattendedGrants, undefined);
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
