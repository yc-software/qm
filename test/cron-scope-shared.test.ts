import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTrigger, type TriggerDeps } from "../src/triggers/run-trigger.ts";
import { composeCronEditNotice, notifyOwnerOfCronEdit, type CronEditNoticeSink } from "../src/triggers/edit-notice.ts";
import type { Cron } from "../src/types.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId, type Destination, type TurnRequest, type TurnResult } from "../src/types.ts";

const members = [
  { id: "U-carol", type: "internal" as const },
  { id: "U2", type: "internal" as const },
];
const toChannel: Destination = { type: "slack", target: "C-eng", audienceScopeId: scopeId("channel", "C-eng") };

function captureDeps(): { deps: TriggerDeps; seen: TurnRequest[] } {
  const seen: TurnRequest[] = [];
  const run = async (req: TurnRequest): Promise<TurnResult> => {
    seen.push(req);
    return { status: "ok", reply: "digest" };
  };
  return {
    deps: {
      deliveries: createDeliveryStore(),
      idempotency: createIdempotencyStore(createMemoryMap()),
      identity: createIdentityService(),
      run,
    },
    seen,
  };
}

describe("runTrigger: scopeShared unions the owner's keychain into the scope run", () => {
  it("fires AS the owner, flags ownerKeychainUnion, carries the member audience, and delivers to the channel", async () => {
    const { deps, seen } = captureDeps();
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("channel", "C-eng"),
      input: "compose",
      fireKey: "ss1",
      surface: "cron",
      runAs: "scopeShared",
      members,
      destination: toChannel,
    });
    assert.equal(out.ran, true);
    assert.equal(seen.length, 1);
    const req = seen[0]!;
    assert.equal(req.ownerKeychainUnion, true, "the fire flags the owner∪scope keychain union");
    assert.equal(req.actor.externalId, "U-carol", "runs as the owner, not a substituted scope member");
    assert.equal(req.conversation.kind, "channel");
    assert.equal(req.conversation.audience?.length, 2);
    assert.equal((await deps.deliveries.pending("slack")).length, 1);
  });

  it("an owner cron does NOT set the union flag", async () => {
    const { deps, seen } = captureDeps();
    await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("personal", "U-carol"),
      input: "x",
      fireKey: "o1",
      surface: "cron",
    });
    assert.equal(seen[0]!.ownerKeychainUnion, undefined);
  });

  it("an owner-mode task cannot read a managed group after leaving its current roster", async () => {
    const { deps, seen } = captureDeps();
    deps.currentScopeMembers = async () => [members[1]!];
    const out = await runTrigger(deps, {
      owner: "U-owner",
      ownerScopeId: scopeId("group", "web-project-p1"),
      input: "x",
      fireKey: "owner-revoked",
      surface: "cron",
    });
    assert.equal(out.authzFailed, false);
    assert.equal(out.ran, true);
    assert.match(out.note ?? "", /no longer a member/);
    assert.equal(seen.length, 0);
  });

  it("a scopeFloor cron does NOT set the union flag (it runs at the scope floor, not the owner's creds)", async () => {
    const { deps, seen } = captureDeps();
    await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("channel", "C-eng"),
      input: "x",
      fireKey: "f1",
      surface: "cron",
      runAs: "scopeFloor",
      members,
    });
    assert.equal(seen[0]!.ownerKeychainUnion, undefined);
  });

  it("disables scopeShared when its owner left the current roster", async () => {
    const { deps, seen } = captureDeps();
    deps.currentScopeMembers = async () => [members[1]!];
    const out = await runTrigger(deps, {
      owner: "U-owner",
      ownerScopeId: scopeId("channel", "C-eng"),
      input: "x",
      fireKey: "ss-revoked",
      surface: "cron",
      runAs: "scopeShared",
      members,
    });
    assert.equal(out.authzFailed, true);
    assert.equal(out.ran, false);
    assert.match(out.note ?? "", /no longer a current scope member/);
    assert.equal(seen.length, 0);
  });

  it("scopeFloor refreshes its audience and re-actors to a current member", async () => {
    const { deps, seen } = captureDeps();
    const current = [{ id: "U3", type: "internal" as const }];
    deps.currentScopeMembers = async () => current;
    const out = await runTrigger(deps, {
      owner: "U-owner",
      ownerScopeId: scopeId("channel", "C-eng"),
      input: "x",
      fireKey: "floor-refresh",
      surface: "cron",
      runAs: "scopeFloor",
      members,
    });
    assert.equal(out.ran, true);
    assert.equal(seen[0]!.actor.externalId, "U3");
    assert.deepEqual(
      seen[0]!.conversation.audience?.map((member) => member.externalId),
      ["U3"],
    );
  });
});

describe("composeCronEditNotice: a heads-up with enough context to skip clicking", () => {
  const link = "<https://x/admin?cron=c1|Review backlog worker>";

  it("names the editor, the cron (linked), where it lives, and what the edit actually did", () => {
    const text = composeCronEditNotice({ editorName: "Casey", ref: link, place: "#internal", changes: ["task"] });
    assert.equal(text, `Heads up: Casey changed your ${link} cron in #internal to do something different.`);
    assert.doesNotMatch(text, /ref:|Changed:|wasn't you|credentials/, "no system-alert scaffolding or ominous tail");
  });

  it("describes a schedule change concretely from the new schedule", () => {
    assert.equal(
      composeCronEditNotice({
        editorName: "Casey",
        ref: link,
        changes: ["schedule"],
        detail: { schedule: { everyMs: 3_600_000 } },
      }),
      `Heads up: Casey changed your ${link} cron to run every hour.`,
    );
    assert.equal(
      composeCronEditNotice({
        editorName: "Casey",
        ref: link,
        changes: ["schedule"],
        detail: { schedule: { everyMs: 86_400_000 } },
      }),
      `Heads up: Casey changed your ${link} cron to run every day.`,
    );
  });

  it("describes a retarget with the destination label", () => {
    assert.equal(
      composeCronEditNotice({
        editorName: "Casey",
        ref: link,
        changes: ["destination"],
        detail: { destinationLabel: "#eng" },
      }),
      `Heads up: Casey changed your ${link} cron to post to #eng.`,
    );
  });

  it("falls back to a generic clause when the task summary is unavailable", () => {
    assert.equal(
      composeCronEditNotice({ editorName: "Casey", ref: link, changes: ["task"] }),
      `Heads up: Casey changed your ${link} cron to do something different.`,
    );
  });

  it("renders lifecycle changes as their own verb", () => {
    assert.equal(
      composeCronEditNotice({ editorName: "Casey", ref: link, place: "#internal", changes: ["enabled=false"] }),
      `Heads up: Casey paused your ${link} cron in #internal.`,
    );
    assert.equal(
      composeCronEditNotice({ editorName: "Casey", ref: link, changes: ["deleted"] }),
      `Heads up: Casey deleted your ${link} cron.`,
    );
    assert.equal(
      composeCronEditNotice({ editorName: "Casey", ref: link, changes: ["title"] }),
      `Heads up: Casey renamed your ${link} cron.`,
    );
  });

  it("joins multiple changes into one sentence, naming the cron once", () => {
    assert.equal(
      composeCronEditNotice({
        editorName: "Casey",
        ref: link,
        place: "#internal",
        changes: ["enabled=false", "schedule"],
        detail: { schedule: { everyMs: 600_000 } },
      }),
      `Heads up: Casey paused your ${link} cron in #internal and changed it to run every 10 minutes.`,
    );
  });
});

describe("notifyOwnerOfCronEdit: the one chokepoint both edit paths share", () => {
  function fakeSink(members: Record<string, { displayName?: string; principalId?: string; slackId?: string }> = {}): {
    sink: CronEditNoticeSink;
    enqueued: Array<{ destination: { target: string }; text: string; idempotencyKey: string }>;
  } {
    const enqueued: Array<{ destination: { target: string }; text: string; idempotencyKey: string }> = [];
    return {
      enqueued,
      sink: {
        enqueueDelivery: async (i) =>
          void enqueued.push(i as { destination: { target: string }; text: string; idempotencyKey: string }),
        directoryMember: async (p) => members[p] ?? null,
        cronAdminUrl: (c) => `https://x/admin/?cron=${c.id}`,
      },
    };
  }
  const cron = (over: Partial<Cron> = {}): Cron =>
    ({
      id: "cron_x",
      runAs: "scopeShared",
      owner: "U-owner",
      ownerScopeId: "channel:C",
      title: "Digest",
      schedule: { everyMs: 1 },
      createdAt: 0,
      ...over,
    }) as Cron;

  it("notifies the owner when a NON-owner edits, naming the editor and linking to admin", async () => {
    const { sink, enqueued } = fakeSink({ "U-mate": { displayName: "Casey" } });
    await notifyOwnerOfCronEdit(sink, {
      cron: cron(),
      editorId: "U-mate",
      changeSummary: ["title"],
      editFingerprint: "f1",
    });
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0]!.destination.target, "U-owner");
    assert.match(enqueued[0]!.idempotencyKey, /^cron-edit-notice:cron_x:/);
    assert.match(enqueued[0]!.text, /^Heads up: Casey /, "names the editor, not 'someone'");
    assert.match(enqueued[0]!.text, /<https:\/\/x\/admin\/\?cron=cron_x\|Digest>/, "links the cron in admin");
  });

  it("does NOT notify on a cross-surface self-edit (email owner ↔ Slack-id editor, same person)", async () => {
    const { sink, enqueued } = fakeSink({
      "alice@acme.com": { principalId: "alice@acme.com", slackId: "U-alice" },
      "U-alice": { principalId: "alice@acme.com", slackId: "U-alice" },
    });
    await notifyOwnerOfCronEdit(sink, {
      cron: cron({ owner: "alice@acme.com" }),
      editorId: "U-alice",
      changeSummary: ["task"],
      editFingerprint: "f1",
    });
    assert.equal(enqueued.length, 0, "same person via directory bridge → no notice");
  });

  it("does NOT notify on an email-case self-edit", async () => {
    const { sink, enqueued } = fakeSink();
    await notifyOwnerOfCronEdit(sink, {
      cron: cron({ owner: "Alice@acme.com" }),
      editorId: "alice@acme.com",
      changeSummary: ["task"],
      editFingerprint: "f1",
    });
    assert.equal(enqueued.length, 0, "case-only difference → no notice");
  });

  it("does NOT notify on an owner self-edit, or for non-scopeShared crons", async () => {
    const a = fakeSink();
    await notifyOwnerOfCronEdit(a.sink, {
      cron: cron(),
      editorId: "U-owner",
      changeSummary: ["title"],
      editFingerprint: "f1",
    });
    assert.equal(a.enqueued.length, 0, "owner editing own cron → no notice");
    const b = fakeSink();
    await notifyOwnerOfCronEdit(b.sink, {
      cron: cron({ runAs: "scopeFloor" }),
      editorId: "U-mate",
      changeSummary: ["title"],
      editFingerprint: "f1",
    });
    assert.equal(b.enqueued.length, 0, "scopeFloor edit → no notice");
    const c = fakeSink();
    await notifyOwnerOfCronEdit(c.sink, {
      cron: cron({ runAs: "owner" }),
      editorId: "U-mate",
      changeSummary: ["title"],
      editFingerprint: "f1",
    });
    assert.equal(c.enqueued.length, 0, "owner-mode edit → no notice");
  });

  it("keys idempotency on edit content: same fingerprint repeats one key, a different edit gets a new one", async () => {
    const { sink, enqueued } = fakeSink();
    await notifyOwnerOfCronEdit(sink, {
      cron: cron(),
      editorId: "U-mate",
      changeSummary: ["title"],
      editFingerprint: "same",
    });
    await notifyOwnerOfCronEdit(sink, {
      cron: cron(),
      editorId: "U-mate",
      changeSummary: ["title"],
      editFingerprint: "same",
    });
    await notifyOwnerOfCronEdit(sink, {
      cron: cron(),
      editorId: "U-mate",
      changeSummary: ["task"],
      editFingerprint: "different",
    });
    assert.equal(enqueued[0]!.idempotencyKey, enqueued[1]!.idempotencyKey, "identical retry → same idempotency key");
    assert.notEqual(enqueued[0]!.idempotencyKey, enqueued[2]!.idempotencyKey, "distinct edit → new idempotency key");
  });
});
