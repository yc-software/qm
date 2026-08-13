import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isVisible, type VisibilityDirectory } from "../src/directory/visibility.ts";
import { runTrigger, type TriggerDeps } from "../src/triggers/run-trigger.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId, type Destination, type TurnRequest, type TurnResult } from "../src/types.ts";

function dir(): VisibilityDirectory & {
  get(id: string): Promise<{ displayName: string } | null>;
  channelPrivacy(channelId: string): Promise<boolean | undefined>;
} {
  const channels = [
    { channelId: "C-eng", name: "eng" },
    { channelId: "C-secret", name: "secret", isPrivate: true },
  ];
  const privateMembers: Record<string, Set<string>> = { "C-secret": new Set(["U-carol"]) };
  const groupMembers: Record<string, Set<string>> = { "G-jrs": new Set(["U-carol"]) };
  return {
    async channelMember(channelId, principalId) {
      return privateMembers[channelId]?.has(principalId) ?? false;
    },
    async groupMember(groupId, principalId) {
      return groupMembers[groupId]?.has(principalId) ?? false;
    },
    async listChannelsFor(principalId) {
      return channels.filter((c) => !c.isPrivate || (privateMembers[c.channelId]?.has(principalId) ?? false));
    },
    async get() {
      return { displayName: "Carol" };
    },
    async channelPrivacy(channelId: string) {
      return channels.find((c) => c.channelId === channelId)
        ? channels.find((c) => c.channelId === channelId)!.isPrivate === true
        : undefined;
    },
  };
}

describe("isVisible: the shared action gate", () => {
  it("dm: visible only to the owner", async () => {
    const d = dir();
    assert.equal(await isVisible(d, "U-carol", { kind: "dm", ownerId: "U-carol" }), true);
    assert.equal(await isVisible(d, "U-alice", { kind: "dm", ownerId: "U-carol" }), false);
  });

  it("group: member yes, non-member no", async () => {
    const d = dir();
    assert.equal(await isVisible(d, "U-carol", { kind: "group", groupId: "G-jrs" }), true);
    assert.equal(await isVisible(d, "U-alice", { kind: "group", groupId: "G-jrs" }), false);
    assert.equal(await isVisible(d, "U-carol", { kind: "group", groupId: "G-unknown" }), false);
  });

  it("channel, privacy known: public always visible, private only to members", async () => {
    const d = dir();
    assert.equal(await isVisible(d, "U-anyone", { kind: "channel", channelId: "C-eng", isPrivate: false }), true);
    assert.equal(await isVisible(d, "U-carol", { kind: "channel", channelId: "C-secret", isPrivate: true }), true);
    assert.equal(await isVisible(d, "U-alice", { kind: "channel", channelId: "C-secret", isPrivate: true }), false);
  });

  it("channel, privacy unknown: resolved via listChannelsFor (fail-closed on unknown)", async () => {
    const d = dir();
    assert.equal(await isVisible(d, "U-carol", { kind: "channel", channelId: "C-eng" }), true, "public, bot in it");
    assert.equal(await isVisible(d, "U-carol", { kind: "channel", channelId: "C-secret" }), true, "private member");
    assert.equal(
      await isVisible(d, "U-alice", { kind: "channel", channelId: "C-secret" }),
      false,
      "private non-member",
    );
    assert.equal(await isVisible(d, "U-carol", { kind: "channel", channelId: "C-nope" }), false, "unknown channel");
  });

  it("channel, privacy unknown but no listChannelsFor: fails closed", async () => {
    const d = dir();
    const noList: VisibilityDirectory = { channelMember: d.channelMember, groupMember: d.groupMember };
    assert.equal(await isVisible(noList, "U-carol", { kind: "channel", channelId: "C-eng" }), false);
  });
});

function triggerDeps(run: (req: TurnRequest) => Promise<TurnResult>): TriggerDeps {
  return {
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(createMemoryMap()),
    identity: createIdentityService(),
    run,
    directory: dir(),
  };
}

describe("runTrigger: fire-time visibility gate", () => {
  it("delivers when the owner can still see the channel", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "standup" }));
    const destination: Destination = { type: "slack", target: "C-eng", audienceScopeId: scopeId("channel", "C-eng") };
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("channel", "C-eng"),
      input: "post",
      fireKey: "f1",
      surface: "cron",
      destination,
    });
    assert.equal(out.authzFailed, false);
    assert.equal((await deps.deliveries.pending("slack")).length, 1);
  });

  it("skips delivery (without disabling) when the owner can no longer see the private channel", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "leaked digest" }));
    const destination: Destination = {
      type: "slack",
      target: "C-secret",
      audienceScopeId: scopeId("channel", "C-secret"),
    };
    const out = await runTrigger(deps, {
      owner: "U-alice",
      ownerScopeId: scopeId("personal", "U-alice"),
      input: "post",
      fireKey: "f2",
      surface: "cron",
      destination,
    });
    assert.equal(out.authzFailed, false, "not disabled — staleness must not kill a cron");
    assert.equal((await deps.deliveries.pending("slack")).length, 0, "no post to a channel the owner can't see");
    assert.match(out.note ?? "", /no longer visible/);
    assert.equal(out.status, "refused", "a withheld delivery is not recorded as a success");
  });

  it("skips the run entirely (§10 leg a) when the actor lost the HOME scope — the exfil shape", async () => {
    let ranTurn = false;
    const deps = triggerDeps(async () => {
      ranTurn = true;
      return { status: "ok", reply: "leaked digest" };
    });
    const destination: Destination = { type: "slack", target: "C-eng", audienceScopeId: scopeId("channel", "C-eng") };
    const out = await runTrigger(deps, {
      owner: "U-alice",
      ownerScopeId: scopeId("channel", "C-secret"),
      input: "digest #secret",
      fireKey: "f6",
      surface: "cron",
      destination,
    });
    assert.equal(ranTurn, false, "the turn never runs");
    assert.equal(
      out.ran,
      true,
      "the fire is consumed and RECORDED (a cron logs it; nothing spins or conflates with dedupe)",
    );
    assert.equal(out.authzFailed, false, "skip-not-disable");
    assert.equal((await deps.deliveries.pending("slack")).length, 0);
    assert.match(out.note ?? "", /no longer a member/);
  });

  it("fails closed when the directory has never seen the home channel", async () => {
    let ranTurn = false;
    const deps = triggerDeps(async () => {
      ranTurn = true;
      return { status: "ok", reply: "digest" };
    });
    const destination: Destination = {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U-alice",
    };
    const out = await runTrigger(deps, {
      owner: "U-alice",
      ownerScopeId: scopeId("channel", "C-unpushed"),
      input: "digest",
      fireKey: "f7",
      surface: "cron",
      destination,
    });
    assert.equal(ranTurn, false);
    assert.equal(out.ran, true);
    assert.equal((await deps.deliveries.pending("principal")).length, 0);
  });

  it("skips a verbatim relay into a now-invisible group DM", async () => {
    const deps = triggerDeps(async () => {
      throw new Error("a relay must not re-run a turn");
    });
    const destination: Destination = { type: "group", target: "G-jrs", audienceScopeId: scopeId("group", "G-jrs") };
    const out = await runTrigger(deps, {
      owner: "U-alice",
      ownerScopeId: scopeId("personal", "U-alice"),
      input: "",
      message: "secret",
      fireKey: "f3",
      surface: "cron",
      destination,
    });
    assert.equal((await deps.deliveries.pending("group")).length, 0);
    assert.match(out.note ?? "", /no longer visible/);
  });

  it("a thread-targeted channel destination (id:threadTs) still resolves visibility on the channel", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "into the thread" }));
    const destination: Destination = {
      type: "slack",
      target: "C-eng:1782340476.772799",
      audienceScopeId: scopeId("channel", "C-eng"),
    };
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("channel", "C-eng"),
      input: "post",
      fireKey: "f5",
      surface: "cron",
      destination,
    });
    assert.equal(
      (await deps.deliveries.pending("slack")).length,
      1,
      "thread suffix must be stripped before the membership lookup",
    );
    assert.equal(out.note, undefined);
  });

  it("a DM-created cron ('this conversation' in the owner's own DM) delivers — an im channel is not a directory channel", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "morning digest" }));
    const destination: Destination = {
      type: "slack",
      target: "D-carol",
      audienceScopeId: scopeId("personal", "U-carol"),
    };
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("personal", "U-carol"),
      input: "digest",
      fireKey: "f6",
      surface: "cron",
      destination,
    });
    assert.equal(out.note, undefined, "an im target must not be treated as an unknown directory channel");
    assert.equal((await deps.deliveries.pending("slack")).length, 1, "the owner's own DM is always visible to them");
  });

  it("a personal-audience slack destination fails closed for anyone but the scope owner", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "not yours" }));
    const destination: Destination = {
      type: "slack",
      target: "D-carol",
      audienceScopeId: scopeId("personal", "U-carol"),
    };
    const out = await runTrigger(deps, {
      owner: "U-alice",
      ownerScopeId: scopeId("personal", "U-alice"),
      input: "digest",
      fireKey: "f7",
      surface: "cron",
      destination,
    });
    assert.equal((await deps.deliveries.pending("slack")).length, 0);
    assert.match(out.note ?? "", /no longer visible/);
  });

  it("a teammate-DM (principal) destination is never gated by channel visibility", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "fyi" }));
    const destination: Destination = {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U-alice",
    };
    const out = await runTrigger(deps, {
      owner: "U-alice",
      ownerScopeId: scopeId("personal", "U-alice"),
      input: "ping",
      fireKey: "f4",
      surface: "cron",
      destination,
    });
    assert.equal(out.authzFailed, false);
    assert.equal((await deps.deliveries.pending("principal")).length, 1);
  });
});
