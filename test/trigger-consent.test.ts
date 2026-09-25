import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runTrigger, type TriggerDeps } from "../src/triggers/run-trigger.ts";
import {
  consentRequiredRecipient,
  recipientConsentSatisfied,
  decideRecipientConsent,
} from "../src/triggers/trigger-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId, type Destination, type RecipientConsent, type TurnRequest, type TurnResult } from "../src/types.ts";

describe("consentRequiredRecipient: who must consent before a standing delivery starts", () => {
  const dm = (target: string): Destination => ({
    type: "principal",
    target,
    audienceScopeId: scopeId("personal", target),
    onBehalfOf: "U-carol",
  });

  it("a standing delivery to a teammate's DM needs that teammate's consent", () => {
    assert.equal(consentRequiredRecipient({ owner: "U-carol", standing: true, destination: dm("U-alice") }), "U-alice");
  });
  it("DMing yourself needs no consent (it's your own inbox)", () => {
    assert.equal(consentRequiredRecipient({ owner: "U-carol", standing: true, destination: dm("U-carol") }), undefined);
  });
  it("a one-shot send needs no consent (a single message, like reach send-now)", () => {
    assert.equal(
      consentRequiredRecipient({ owner: "U-carol", standing: false, destination: dm("U-alice") }),
      undefined,
    );
  });
  it("a channel destination needs no recipient consent (parity-gated, not a private inbox)", () => {
    assert.equal(
      consentRequiredRecipient({ owner: "U-carol", standing: true, destination: { type: "slack", target: "C-eng" } }),
      undefined,
    );
  });
});

describe("recipientConsentSatisfied: the fire-time gate (record present ⇒ must be accepted)", () => {
  it("no record passes (one-shot / owner / channel / legacy pre-consent crons)", () => {
    assert.equal(recipientConsentSatisfied({}), true);
  });
  it("pending withholds, accepted delivers, declined withholds", () => {
    assert.equal(recipientConsentSatisfied({ recipientConsent: { recipientId: "U-alice", status: "pending" } }), false);
    assert.equal(recipientConsentSatisfied({ recipientConsent: { recipientId: "U-alice", status: "accepted" } }), true);
    assert.equal(
      recipientConsentSatisfied({ recipientConsent: { recipientId: "U-alice", status: "declined" } }),
      false,
    );
  });

  it("a required recipient needs an accepted record bound to that person", () => {
    assert.equal(recipientConsentSatisfied({}, "U-alice"), false);
    assert.equal(
      recipientConsentSatisfied({ recipientConsent: { recipientId: "U-bob", status: "accepted" } }, "U-alice"),
      false,
    );
    assert.equal(
      recipientConsentSatisfied({ recipientConsent: { recipientId: "U-alice", status: "accepted" } }, "U-alice"),
      true,
    );
  });
});

describe("decideRecipientConsent: only the recipient flips their own switch", () => {
  const pending: RecipientConsent = { recipientId: "U-alice", status: "pending" };
  it("the recipient may accept (on) and decline (off)", () => {
    const a = decideRecipientConsent(pending, "U-alice", "accept", 1000);
    assert.ok(a.ok && a.consent.status === "accepted" && a.consent.decidedAt === 1000);
    const d = decideRecipientConsent({ recipientId: "U-alice", status: "accepted" }, "U-alice", "decline", 2000);
    assert.ok(d.ok && d.consent.status === "declined");
  });
  it("a non-recipient (incl. the owner) cannot decide", () => {
    const r = decideRecipientConsent(pending, "U-carol", "accept", 1000);
    assert.ok(!r.ok && r.reason === "not_recipient");
  });
  it("there must be a consent gate to decide on", () => {
    const r = decideRecipientConsent(undefined, "U-alice", "accept", 1000);
    assert.ok(!r.ok && r.reason === "no_consent");
  });
});

function triggerDeps(run: (req: TurnRequest) => Promise<TurnResult>): TriggerDeps {
  return {
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(createMemoryMap()),
    identity: createIdentityService(),
    run,
  };
}

describe("runTrigger: recipient-consent gate", () => {
  const toAlice: Destination = {
    type: "principal",
    target: "U-alice",
    audienceScopeId: scopeId("personal", "U-alice"),
    onBehalfOf: "U-carol",
  };

  it("withholds a composed delivery while the recipient hasn't accepted", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "your digest" }));
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("personal", "U-carol"),
      input: "compose",
      fireKey: "c1",
      surface: "cron",
      destination: toAlice,
      recipientConsent: { recipientId: "U-alice", status: "pending" },
    });
    assert.equal(
      (await deps.deliveries.pending("principal")).filter((delivery) => delivery.destination.target === "U-alice")
        .length,
      0,
      "nothing reaches a recipient who hasn't accepted",
    );
    assert.match(out.note ?? "", /consent/);
  });

  it("delivers once the recipient has accepted", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "your digest" }));
    await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("personal", "U-carol"),
      input: "compose",
      fireKey: "c2",
      surface: "cron",
      destination: toAlice,
      recipientConsent: { recipientId: "U-alice", status: "accepted" },
    });
    assert.equal((await deps.deliveries.pending("principal")).length, 1);
  });

  it("a standing teammate-DM with no consent record is withheld", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "fyi" }));
    await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("personal", "U-carol"),
      input: "compose",
      fireKey: "c3",
      surface: "cron",
      destination: toAlice,
      recipientConsentRequired: true,
    });
    assert.equal(
      (await deps.deliveries.pending("principal")).filter((delivery) => delivery.destination.target === "U-alice")
        .length,
      0,
    );
  });

  it("accepted consent for a prior recipient does not authorize a retargeted standing DM", async () => {
    const deps = triggerDeps(async () => ({ status: "ok", reply: "fyi" }));
    await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("personal", "U-carol"),
      input: "compose",
      fireKey: "c3-retarget",
      surface: "cron",
      destination: { ...toAlice, target: "U-bob", audienceScopeId: scopeId("personal", "U-bob") },
      recipientConsent: { recipientId: "U-alice", status: "accepted" },
      recipientConsentRequired: true,
    });
    assert.equal(
      (await deps.deliveries.pending("principal")).filter((delivery) => delivery.destination.target === "U-bob").length,
      0,
    );
  });

  it("an unrelated turn refusal sends no consent notice (nothing was withheld for consent)", async () => {
    const deps = triggerDeps(async () => ({ status: "refused", reason: "runtime not approved" }));
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("personal", "U-carol"),
      input: "compose",
      fireKey: "c-unrelated",
      surface: "cron",
      destination: toAlice,
      recipientConsentRequired: true,
    });
    assert.equal(out.status, "refused");
    assert.doesNotMatch(out.note ?? "", /consent/);
    assert.equal((await deps.deliveries.pending("principal")).length, 0, "no misleading skip notice to anyone");
  });

  it("withholds a verbatim relay too (a declined recipient gets nothing)", async () => {
    const deps = triggerDeps(async () => {
      throw new Error("a relay must not re-run a turn");
    });
    const out = await runTrigger(deps, {
      owner: "U-carol",
      ownerScopeId: scopeId("personal", "U-carol"),
      input: "",
      message: "standup in 5",
      fireKey: "c4",
      surface: "cron",
      destination: toAlice,
      recipientConsent: { recipientId: "U-alice", status: "declined" },
    });
    assert.equal(
      (await deps.deliveries.pending("principal")).filter((delivery) => delivery.destination.target === "U-alice")
        .length,
      0,
    );
    assert.match(out.note ?? "", /turned this delivery off/);
  });
});
