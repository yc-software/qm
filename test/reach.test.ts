import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveReachTarget,
  attributeRelay,
  reachEnqueue,
  withReact,
  withDelete,
  withEdit,
  type ReachDirectory,
} from "../src/reach/reach.ts";
import { runTrigger, type TriggerDeps } from "../src/triggers/run-trigger.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId, type Destination, type Principal, type TurnRequest, type TurnResult } from "../src/types.ts";

function fakeDirectory(): ReachDirectory & {
  get(id: string): Promise<{ displayName: string } | null>;
  listChannelsFor(principalId: string): Promise<{ channelId: string; name: string; isPrivate?: boolean }[]>;
  channelPrivacy(channelId: string): Promise<boolean | undefined>;
} {
  const members = [
    { principalId: "U-bob", displayName: "Bob", type: "internal" as const },
    { principalId: "U-alice", displayName: "Alice", type: "internal" as const },
    { principalId: "U-carol", displayName: "Carol", type: "internal" as const },
    { principalId: "U-sam1", displayName: "Sam Lee", type: "internal" as const },
    { principalId: "U-sam2", displayName: "Sam Park", type: "internal" as const },
  ];
  const channels = [
    { channelId: "C-eng", name: "eng" },
    { channelId: "C-secret", name: "secret", isPrivate: true },
  ];
  const privateMembers: Record<string, Set<string>> = { "C-secret": new Set(["U-carol"]) };
  const groupMembers: Record<string, Set<string>> = { "G-jrs": new Set(["U-carol", "U-alice", "U-sam1"]) };
  const setKey = (ids: Iterable<string>) => [...new Set([...ids].filter(Boolean))].sort().join(",");
  const norm = (s: string) => s.trim().toLowerCase().replace(/^[@#]/, "");
  return {
    async resolveRecipient(query) {
      const q = norm(query);
      const byId = members.find((m) => m.principalId.toLowerCase() === q);
      if (byId) return { kind: "one", member: byId };
      const hits = members.filter((m) => norm(m.displayName).startsWith(q));
      if (hits.length === 0) return { kind: "none" };
      if (hits.length === 1) return { kind: "one", member: hits[0]! };
      return { kind: "ambiguous", candidates: hits };
    },
    async resolveChannel(query) {
      const q = norm(query);
      const hits = channels.filter((c) => norm(c.name) === q);
      if (hits.length === 0) return { kind: "none" };
      if (hits.length === 1) return { kind: "one", channel: hits[0]! };
      return { kind: "ambiguous", candidates: hits };
    },
    async channelMember(channelId, principalId) {
      return privateMembers[channelId]?.has(principalId) ?? false;
    },
    async channelPrivacy(channelId) {
      return channels.find((c) => c.channelId === channelId)?.isPrivate ?? false;
    },
    async resolveGroup(participants) {
      const key = setKey(participants);
      if (!key) return { kind: "none" };
      const hit = Object.entries(groupMembers).find(([, set]) => setKey(set) === key);
      return hit ? { kind: "one", groupId: hit[0] } : { kind: "none" };
    },
    async groupMember(groupId, principalId) {
      return groupMembers[groupId]?.has(principalId) ?? false;
    },
    async listChannelsFor(principalId) {
      return channels.filter((c) => !c.isPrivate || (privateMembers[c.channelId]?.has(principalId) ?? false));
    },
    async get(id) {
      const m = members.find((x) => x.principalId === id);
      return m ? { displayName: m.displayName } : null;
    },
    async directoryMember(id) {
      const m = members.find((x) => x.principalId === id);
      return m ? { type: m.type } : null;
    },
  };
}

describe("Reach: resolveReachTarget (addressing + reachability gate)", () => {
  const dir = fakeDirectory();

  it("DMs any internal teammate (no membership gate — a human could DM anyone)", async () => {
    const r = await resolveReachTarget(dir, { recipient: "Alice" }, "U-carol");
    assert.equal(r.ok, true);
    assert.equal((r as any).destination.type, "principal");
    assert.equal((r as any).destination.target, "U-alice");
    assert.equal((r as any).destination.onBehalfOf, "U-carol");
    assert.equal((r as any).destination.audienceScopeId, "personal:U-alice");
    assert.equal((r as any).recipient.displayName, "Alice");
  });

  it("404 not-found, 409 ambiguous", async () => {
    const miss = await resolveReachTarget(dir, { recipient: "Nobody" }, "U-carol");
    assert.equal(miss.ok, false);
    assert.equal((miss as any).status, 404);
    const amb = await resolveReachTarget(dir, { recipient: "Sam" }, "U-carol");
    assert.equal((amb as any).status, 409);
    assert.equal((amb as any).candidates.length, 2);
  });

  it("public channel: any internal member may post; private channel: only a member (403 otherwise)", async () => {
    const pub = await resolveReachTarget(dir, { channel: "eng" }, "U-alice");
    assert.equal(pub.ok, true);
    assert.equal((pub as any).destination.type, "slack");
    assert.equal((pub as any).destination.target, "C-eng");

    const okPriv = await resolveReachTarget(dir, { channel: "secret" }, "U-carol");
    assert.equal(okPriv.ok, true);
    const noPriv = await resolveReachTarget(dir, { channel: "secret" }, "U-alice");
    assert.equal(noPriv.ok, false);
    assert.equal((noPriv as any).status, 403);
  });

  it("denial is legible: a known non-member → not_a_member; an actor not in the directory → identity_unverified", async () => {
    const notMember = await resolveReachTarget(dir, { channel: "secret" }, "U-alice");
    assert.equal((notMember as any).error, "not_a_member");

    const unverified = await resolveReachTarget(dir, { channel: "secret" }, "U-ghost");
    assert.equal(unverified.ok, false);
    assert.equal((unverified as any).status, 403);
    assert.equal((unverified as any).error, "identity_unverified");
    assert.match((unverified as any).message, /link|linked|sign|connect/i);
  });

  it("group DM: resolved by the participant SET (sender folded in); member-only (parity)", async () => {
    const ok = await resolveReachTarget(dir, { participants: ["U-alice", "U-sam1"] }, "U-carol");
    assert.equal(ok.ok, true);
    assert.equal((ok as any).destination.type, "group");
    assert.equal((ok as any).destination.target, "G-jrs");
    assert.equal((ok as any).destination.audienceScopeId, "group:G-jrs");
    assert.equal((ok as any).group.groupId, "G-jrs");

    const same = await resolveReachTarget(
      dir,
      { participants: ["U-sam1", "U-carol", "U-alice", "U-carol"] },
      "U-carol",
    );
    assert.equal((same as any).destination?.target, "G-jrs");

    const miss = await resolveReachTarget(dir, { participants: ["U-alice", "U-sam2"] }, "U-carol");
    assert.equal((miss as any).status, 404);
    assert.equal((miss as any).error, "group_not_found");

    const nonMember = await resolveReachTarget(dir, { participants: ["U-carol", "U-alice"] }, "U-sam2");
    assert.equal((nonMember as any).status, 404);
  });

  it("400 when more than one / no target is named", async () => {
    const both = await resolveReachTarget(dir, { recipient: "Alice", channel: "eng" }, "U-carol");
    assert.equal((both as any).status, 400);
    const withGroup = await resolveReachTarget(dir, { channel: "eng", participants: ["U-alice"] }, "U-carol");
    assert.equal((withGroup as any).status, 400);
    const neither = await resolveReachTarget(dir, {}, "U-carol");
    assert.equal((neither as any).status, 400);
    const emptyGroup = await resolveReachTarget(dir, { participants: [] }, "U-carol");
    assert.equal((emptyGroup as any).status, 400);
    assert.equal((emptyGroup as any).error, "bad_request");
  });
});

describe("Reach: person-keyed parity (delivery never re-derives it from scope labels)", () => {
  it("a run composed in one room delivers verbatim into ANOTHER room its authority may post to (forwarding, §10)", async () => {
    const deliveries = createDeliveryStore();
    const toOtherChannel: Destination = {
      type: "slack",
      target: "C-win",
      audienceScopeId: scopeId("channel", "C-win"),
    };
    const d = await reachEnqueue({
      deliveries,
      destination: toOtherChannel,
      text: "Cross-room update",
      idempotencyKey: "kx1",
    });
    assert.equal(d.text, "Cross-room update");
  });
});

describe("Reach: verbatim relay attribution", () => {
  it("prefixes a third-party relay with the sender's name; passes through when no name", () => {
    assert.equal(attributeRelay("ship it", "Carol"), "Carol asked me to pass on:\nship it");
    assert.equal(attributeRelay("ship it", undefined), "ship it");
  });

  it("reachEnqueue attributes a third-party DM but not a self-reminder or a channel post", async () => {
    const deliveries = createDeliveryStore();
    const toAlice: Destination = {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U-carol",
    };
    const toSelf: Destination = {
      type: "principal",
      target: "U-carol",
      audienceScopeId: scopeId("personal", "U-carol"),
      onBehalfOf: "U-carol",
    };
    const toChannel: Destination = { type: "slack", target: "C-eng", audienceScopeId: scopeId("channel", "C-eng") };
    const d1 = await reachEnqueue({
      deliveries,
      destination: toAlice,
      text: "ping",
      idempotencyKey: "k1",
      attributeAs: "Carol",
    });
    const d2 = await reachEnqueue({
      deliveries,
      destination: toSelf,
      text: "remember milk",
      idempotencyKey: "k2",
      attributeAs: "Carol",
    });
    const d3 = await reachEnqueue({
      deliveries,
      destination: toChannel,
      text: "heads up team",
      idempotencyKey: "k4",
      attributeAs: "Carol",
    });
    assert.equal(d1.text, "Carol asked me to pass on:\nping");
    assert.equal(d2.text, "remember milk");
    assert.equal(d3.text, "heads up team");
  });

  it("reachEnqueue carries attachments onto the SAME delivery (text + files, one placement)", async () => {
    const deliveries = createDeliveryStore();
    const toChannelThread: Destination = {
      type: "slack",
      target: "C-eng:1783.1",
      audienceScopeId: scopeId("channel", "C-eng"),
    };
    const files = [{ name: "cover.png", mimetype: "image/png", sizeBytes: 7, blobId: "blob-1" }];
    const d = await reachEnqueue({
      deliveries,
      destination: toChannelThread,
      text: "Cover for that post",
      attachments: files,
      idempotencyKey: "kf1",
    });
    assert.equal(d.text, "Cover for that post");
    assert.equal(d.destination.target, "C-eng:1783.1", "delivered to the threaded placement the post chose");
    assert.equal(d.attachments?.length, 1, "the attachment is on the post delivery");
    assert.equal(d.attachments?.[0]?.name, "cover.png");
  });

  it("composed task output (no attributeAs) is never prefixed", async () => {
    const deliveries = createDeliveryStore();
    const toAlice: Destination = {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U-carol",
    };
    const d = await reachEnqueue({
      deliveries,
      destination: toAlice,
      text: "Here is the channel summary…",
      idempotencyKey: "k3",
    });
    assert.equal(d.text, "Here is the channel summary…");
  });

  it("a reaction enqueues an empty-text delivery carrying the react, bypassing attribution", async () => {
    const deliveries = createDeliveryStore();
    const reactDest = withReact(
      { type: "slack", target: "C-eng", audienceScopeId: scopeId("channel", "C-eng") },
      { messageTs: "1782340476.7", emoji: "white_check_mark" },
    );
    const d = await reachEnqueue({
      deliveries,
      destination: reactDest,
      text: "ignored",
      idempotencyKey: "kr1",
      attributeAs: "Carol",
    });
    assert.equal(d.text, "");
    assert.deepEqual(d.destination.react, { messageTs: "1782340476.7", emoji: "white_check_mark" });
  });

  it("a deletion enqueues an empty-text delivery carrying the delete, bypassing attribution", async () => {
    const deliveries = createDeliveryStore();
    const delDest = withDelete(
      { type: "slack", target: "C-eng", audienceScopeId: scopeId("channel", "C-eng") },
      { messageTs: "1782340476.7" },
    );
    const d = await reachEnqueue({
      deliveries,
      destination: delDest,
      text: "ignored",
      idempotencyKey: "kd1",
      attributeAs: "Carol",
    });
    assert.equal(d.text, "");
    assert.deepEqual(d.destination.delete, { messageTs: "1782340476.7" });
  });

  it("an edit carries new text via editRef, delivered verbatim", async () => {
    const deliveries = createDeliveryStore();
    const editDest = withEdit(
      { type: "slack", target: "C-eng", audienceScopeId: scopeId("channel", "C-eng") },
      "1782340476.7",
    );
    const ok = await reachEnqueue({
      deliveries,
      destination: editDest,
      text: "the corrected summary",
      idempotencyKey: "ke1",
    });
    assert.equal(ok.destination.editRef, "1782340476.7");
    assert.equal(ok.text, "the corrected summary");
  });
});

function triggerDeps(run: (req: TurnRequest) => Promise<TurnResult>): TriggerDeps {
  return {
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(createMemoryMap()),
    identity: createIdentityService(),
    run,
    directory: fakeDirectory(),
  };
}

describe("runTrigger: cron produces deliveries, Reach gates them", () => {
  it("'summarize THIS channel, DM it to Alice' — channel read scope → teammate DM, gate passes", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "3 PRs merged, 1 incident resolved." }));
    const destination: Destination = {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U-carol",
    };
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("channel", "C-eng"),
      input: "summarize this channel",
      fireKey: "cron:c1:slot",
      surface: "cron",
      destination,
    });
    assert.equal(out.authzFailed, false);
    const pending = await deps.deliveries.pending("principal");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.text, "3 PRs merged, 1 incident resolved.");
    assert.equal(pending[0]!.destination.target, "U-alice");
  });

  it("team cron (scopeFloor) → an individual's DM including a NON-member of the channel — gate passes, no withhold", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "team digest" }));
    const destination: Destination = {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U-carol",
    };
    const members: Principal[] = [
      { id: "U-carol", type: "internal" },
      { id: "U-alice", type: "internal" },
    ];
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("channel", "C-secret"),
      input: "digest",
      fireKey: "cron:team1:slot",
      surface: "cron",
      destination,
      runAs: "scopeFloor",
      members,
    });
    assert.equal(out.authzFailed, false);
    const pending = await deps.deliveries.pending("principal");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.text, "team digest");
  });

  it("a verbatim message relay (cron) to a third party is attributed with the sender's name at fire time", async () => {
    const deps = triggerDeps(async () => {
      throw new Error("a literal message must NOT re-run a turn");
    });
    const destination: Destination = {
      type: "principal",
      target: "U-alice",
      audienceScopeId: scopeId("personal", "U-alice"),
      onBehalfOf: "U-carol",
    };
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("personal", "U-carol"),
      input: "",
      message: "the deploy is done 🚀",
      fireKey: "cron:relay1:slot",
      surface: "cron",
      destination,
    });
    assert.equal(out.authzFailed, false);
    const pending = await deps.deliveries.pending("principal");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.text, "Carol asked me to pass on:\nthe deploy is done 🚀");
  });

  it("a fire's outbox attachments ride the delivery with the reply (the tweet-digest regression)", async () => {
    const files = [
      {
        name: "1_tweet.png",
        mimetype: "image/png",
        sizeBytes: 113329,
        blobId: "b1",
        artifactId: "a1",
        artifactViewerId: "U-carol",
      },
      {
        name: "2_tweet.png",
        mimetype: "image/png",
        sizeBytes: 484244,
        blobId: "b2",
        artifactId: "a2",
        artifactViewerId: "U-carol",
      },
    ];
    const deps = triggerDeps(async () => ({ status: "ok", reply: "Today's catch:", attachments: files }));
    const destination: Destination = {
      type: "slack",
      target: "D-carol:1783.1",
      audienceScopeId: scopeId("personal", "U-carol"),
    };
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("personal", "U-carol"),
      input: "daily digest",
      fireKey: "cron:digest1:slot",
      surface: "cron",
      destination,
    });
    assert.equal(out.authzFailed, false);
    const pending = await deps.deliveries.pending("slack");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.text, "Today's catch:");
    assert.deepEqual(
      pending[0]!.attachments?.map((a) => a.name),
      ["1_tweet.png", "2_tweet.png"],
    );
  });

  it("an attachments-only fire (no reply text) still delivers, as a file-only post", async () => {
    const files = [{ name: "chart.png", mimetype: "image/png", sizeBytes: 9, blobId: "b3" }];
    const deps = triggerDeps(async () => ({ status: "ok", attachments: files }));
    const destination: Destination = {
      type: "slack",
      target: "D-carol:1783.2",
      audienceScopeId: scopeId("personal", "U-carol"),
    };
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("personal", "U-carol"),
      input: "chart only",
      fireKey: "cron:digest2:slot",
      surface: "cron",
      destination,
    });
    assert.equal(out.authzFailed, false);
    assert.equal(out.note, undefined, "an attachments-only success is not 'produced no reply'");
    const pending = await deps.deliveries.pending("slack");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.text, "");
    assert.equal(pending[0]!.attachments?.length, 1);
  });

  it("a channel cron whose output is composed from the channel delivers unprefixed", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "standup posted" }));
    const destination: Destination = { type: "slack", target: "C-eng", audienceScopeId: scopeId("channel", "C-eng") };
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("channel", "C-eng"),
      input: "post the standup",
      fireKey: "cron:ch1:slot",
      surface: "cron",
      destination,
    });
    assert.equal(out.authzFailed, false);
    const pending = await deps.deliveries.pending("slack");
    assert.equal(pending[0]!.text, "standup posted");
  });
});
