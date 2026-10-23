// #2317: a secret-drop/keychain-ask resume in a Slack conversation sends its approval card; other fires keep main's behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import { runTrigger } from "../src/triggers/run-trigger.ts";
import type { PendingApprovalRecord, TurnRequest, TurnResult } from "../src/types.ts";
import { fireAskResolution, fireDropResolution } from "../src/triggers/keychain-ask.ts";
import { createApprovalStore } from "../src/core/approval-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
for (const resume of ["secret-drop", "keychain-ask", "cron", "loop", "monitor", "webhook"]) {
  for (const transport of ["slack", "web"])
    test(`${resume} in ${transport}: native approval routing`, async () => {
      const deliveries = createDeliveryStore();
      const backing = createMemoryMap<PendingApprovalRecord>();
      const approvals = createApprovalStore(backing, deliveries);
      let seen: TurnRequest | undefined;
      const deps = {
        deliveries,
        idempotency: createIdempotencyStore(createMemoryMap()),
        identity: createIdentityService(),
        run: async (request: TurnRequest) => {
          seen = request;
          await approvals.put("approval", { sessionId: "session", command: "publish", createdAt: 1, request });
          return { status: "pending_approval" as const, sessionId: "session" } as TurnResult;
        },
      };
      const destination = {
        type: transport,
        target: transport === "slack" ? "D1:1.0" : "web:U1:conversation",
        audienceScopeId: "personal:U1",
      };
      const threadRef = transport === "slack" ? "dm:D1:1.0" : "web:U1:conversation";
      if (resume === "secret-drop")
        await fireDropResolution(deps, {
          id: "drop",
          ownerId: "U1",
          service: "github",
          purpose: "publish",
          audienceScopeId: "personal:U1",
          destination,
          threadRef,
          granted: false,
        });
      else if (resume === "keychain-ask")
        await fireAskResolution(deps, {
          id: "ask",
          credentialId: "credential",
          ownerId: "U2",
          requesterId: "U1",
          requesterScopeId: "personal:U1",
          requesterDestination: destination,
          requesterThreadRef: threadRef,
          purpose: "publish",
          status: "approved",
          createdAt: 1,
          expiresAt: 2,
        });
      else
        await runTrigger(deps, {
          owner: "U1",
          ownerScopeId: "personal:U1",
          surface: resume,
          fireKey: resume,
          input: "publish",
          destination,
          threadRef,
        });
      const isResume = resume === "secret-drop" || resume === "keychain-ask";
      assert.equal(seen!.triggered, true, "does not acquire live-human authority");
      assert.deepEqual(seen!.actor, { externalId: "U1" });
      assert.deepEqual(seen!.triggerDestination, destination);
      assert.ok(await backing.get("approval"), "gate remains durable");
      const cards = (await deliveries.pending("principal")).filter((d) => d.destination.commandApprovalId);
      assert.equal(cards.length, isResume && transport === "slack" ? 1 : 0);
      if (cards.length) assert.equal(cards[0]!.destination.target, "U1");
      if (!isResume) assert.equal(seen!.surface, resume, "background fire keeps main semantics");
    });
}
