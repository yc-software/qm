import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTrigger, type TriggerDeps } from "../src/triggers/run-trigger.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createCurrentScopeMembers } from "../src/resolution/scope-membership.ts";
import { scopeId, type ScopeId, type TurnRequest, type TurnResult } from "../src/types.ts";

const OWNER = "pat@example.com";
const CHAN = "C0PRIVATE";
const SCOPE = scopeId("channel", CHAN);

function unknownChannelDirectory() {
  return {
    channelMember: async (_c: string, _pid: string) => false,
    groupMember: async (_g: string, _pid: string) => false,
    listChannelsFor: async (): Promise<{ channelId: string; name: string }[]> => [],
    channelPrivacy: async (): Promise<boolean | undefined> => undefined,
    list: async () => [{ principalId: OWNER, displayName: "Pete" }],
    get: async () => null,
  };
}

function deps(
  dir: ReturnType<typeof unknownChannelDirectory>,
  opts: { sessions?: TriggerDeps["sessions"]; onRun?: () => void } = {},
): TriggerDeps {
  const run = async (_r: TurnRequest): Promise<TurnResult> => {
    opts.onRun?.();
    return { status: "ok", reply: "posted" };
  };
  return {
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(createMemoryMap()),
    identity: createIdentityService(),
    run,
    directory: dir,
    currentScopeMembers: createCurrentScopeMembers({ directory: dir }),
    ...(opts.sessions ? { sessions: opts.sessions } : {}),
  };
}

function spec(key: string) {
  return {
    owner: OWNER,
    ownerScopeId: SCOPE,
    input: "check apps",
    fireKey: `cron:home:${key}`,
    surface: "cron",
    destination: { type: "slack" as const, target: CHAN, audienceScopeId: SCOPE },
  };
}

describe("runTrigger home-scope gate when the directory snapshot dropped the channel", () => {
  it("falls back to session participation and runs", async () => {
    let ranTurn = false;
    const sessions = {
      listByParticipant: async (pid: string): Promise<readonly { scopeId: ScopeId }[]> =>
        pid === OWNER ? [{ scopeId: SCOPE }] : [],
    };
    const d = deps(unknownChannelDirectory(), { sessions, onRun: () => (ranTurn = true) });
    const out = await runTrigger(d, spec("participant"));
    assert.equal(ranTurn, true, "a session participant in the home scope keeps running through a roster sync gap");
    assert.equal(out.status, "ok");
    assert.equal(out.note, undefined);
  });

  it("skips with a note naming the snapshot gap, not lost membership, when there is no session either", async () => {
    let ranTurn = false;
    const sessions = { listByParticipant: async (): Promise<readonly { scopeId: ScopeId }[]> => [] };
    const d = deps(unknownChannelDirectory(), { sessions, onRun: () => (ranTurn = true) });
    const out = await runTrigger(d, spec("stranger"));
    assert.equal(ranTurn, false);
    assert.equal(out.authzFailed, false, "skip-not-disable survives");
    assert.match(out.note ?? "", /missing from the directory snapshot/);
    assert.doesNotMatch(out.note ?? "", /no longer a member/);
  });

  it("skips the same way when no session store is wired", async () => {
    let ranTurn = false;
    const d = deps(unknownChannelDirectory(), { onRun: () => (ranTurn = true) });
    const out = await runTrigger(d, spec("no-sessions"));
    assert.equal(ranTurn, false);
    assert.match(out.note ?? "", /missing from the directory snapshot/);
  });

  it("a directory that affirmatively knows the private channel and excludes the actor still skips as lost membership", async () => {
    const dir = {
      ...unknownChannelDirectory(),
      listChannelsFor: async () => [{ channelId: CHAN, name: "private" }],
      channelPrivacy: async (): Promise<boolean | undefined> => true,
    };
    let ranTurn = false;
    const sessions = {
      listByParticipant: async (): Promise<readonly { scopeId: ScopeId }[]> => [{ scopeId: SCOPE }],
    };
    const d = deps(dir, { sessions, onRun: () => (ranTurn = true) });
    const out = await runTrigger(d, spec("kicked"));
    assert.equal(ranTurn, false, "an affirmative roster still wins over session history");
    assert.match(out.note ?? "", /no longer a member/);
  });
});

const GROUP = "G0MPIM";
const GSCOPE = scopeId("group", GROUP);

function groupSpec(key: string) {
  return {
    owner: OWNER,
    ownerScopeId: GSCOPE,
    input: "check apps",
    fireKey: `cron:ghome:${key}`,
    surface: "cron",
    destination: { type: "slack" as const, target: GROUP, audienceScopeId: GSCOPE },
  };
}

describe("runTrigger home-scope gate for group homes", () => {
  it("a group missing from the snapshot falls back to session participation and runs", async () => {
    let ranTurn = false;
    const dir = unknownChannelDirectory();
    const sessions = {
      listByParticipant: async (pid: string): Promise<readonly { scopeId: ScopeId }[]> =>
        pid === OWNER ? [{ scopeId: GSCOPE }] : [],
    };
    const d = deps(dir, { sessions, onRun: () => (ranTurn = true) });
    const out = await runTrigger(d, groupSpec("gap"));
    assert.equal(ranTurn, true);
    assert.equal(out.note, undefined);
  });

  it("a group the snapshot affirmatively knows, excluding the actor, skips as lost membership despite session history", async () => {
    let ranTurn = false;
    const dir = {
      ...unknownChannelDirectory(),
      groupMember: async (_g: string, pid: string) => pid === "kim@example.com",
      list: async () => [
        { principalId: OWNER, displayName: "Pete" },
        { principalId: "kim@example.com", displayName: "Kim" },
      ],
    };
    const sessions = {
      listByParticipant: async (): Promise<readonly { scopeId: ScopeId }[]> => [{ scopeId: GSCOPE }],
    };
    const d = deps(dir, { sessions, onRun: () => (ranTurn = true) });
    const out = await runTrigger(d, groupSpec("kicked"));
    assert.equal(ranTurn, false, "an affirmative group roster wins over session history");
    assert.match(out.note ?? "", /no longer a member/);
  });

  it("without currentScopeMembers wired, an affirmative tri-state non-membership wins over session history", async () => {
    let ranTurn = false;
    const dir = {
      ...unknownChannelDirectory(),
      groupMembership: async (): Promise<boolean | undefined> => false,
    };
    const sessions = {
      listByParticipant: async (): Promise<readonly { scopeId: ScopeId }[]> => [{ scopeId: GSCOPE }],
    };
    const d: TriggerDeps = {
      deliveries: createDeliveryStore(),
      idempotency: createIdempotencyStore(createMemoryMap()),
      identity: createIdentityService(),
      run: async () => {
        ranTurn = true;
        return { status: "ok", reply: "posted" };
      },
      directory: dir,
      sessions,
    };
    const out = await runTrigger(d, groupSpec("tri-state"));
    assert.equal(ranTurn, false);
    assert.match(out.note ?? "", /no longer a member/);
  });
});
