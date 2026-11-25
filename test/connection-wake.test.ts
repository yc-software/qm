import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectionWake } from "../src/connectors/connection-wake.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { Session, TurnRequest } from "../src/types.ts";
import { testMap } from "./support/test-database.ts";

const known: Record<string, Partial<Session>> = {
  mine: { scopeId: "personal:U1", threadRef: "web:U1:mine", surface: "web" },
  shared: { scopeId: "channel:C1", threadRef: "C1:1", surface: "web" },
  slackDm: { scopeId: "personal:U1", threadRef: "D1", surface: "slack" },
};

function harness(recent: string[]) {
  const turns: TurnRequest[] = [];
  let arrived = (): void => {};
  const wake = createConnectionWake({
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(testMap()),
    identity: createIdentityService(testMap(), { externalMembers: testMap() }),
    run: async (req) => {
      turns.push(req);
      arrived();
      return { status: "ok", reply: "ideas" };
    },
    sessions: {
      getForParticipant: async (id: string) => (known[id] ?? null) as Session | null,
      listParticipantPage: async () => ({
        sessions: recent.map((threadRef) => ({ threadRef }) as Session),
        next: null,
      }),
      getOrCreateByThread: async (threadRef: string) => ({ id: "created", threadRef }) as Session,
      addParticipant: async () => {},
      participantScopes: async () => [],
    },
  });
  const next = (link: Parameters<typeof wake>[0]) =>
    new Promise<TurnRequest>((resolve) => {
      arrived = () => resolve(turns.at(-1)!);
      wake(link);
    });
  return { next, turns };
}

test("a new connection wakes the person's own web conversation once, never a shared or non-web one", async () => {
  const h = harness(["web:U1:recent"]);
  const turn = await h.next({ principal: "U1", connector: "gmail", linkId: "composio:ca_1", sessionId: "mine" });
  assert.equal(turn.conversation.threadRef, "web:U1:mine");
  assert.equal(turn.displayText, "Connected gmail");
  assert.equal(turn.origin?.kind, "automation");
  assert.match(turn.text, /^<wake reason="connection" surface="connection" connector="gmail"/);
  const shared = await h.next({ principal: "U1", connector: "notion", linkId: "composio:ca_2", sessionId: "shared" });
  assert.equal(shared.conversation.threadRef, "web:U1:recent");
  const slackDm = await h.next({ principal: "U1", connector: "exa", linkId: "composio:ca_3", sessionId: "slackDm" });
  assert.equal(slackDm.conversation.threadRef, "web:U1:recent");
  h.next({ principal: "U1", connector: "gmail", linkId: "composio:ca_1", sessionId: "mine" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.turns.length, 3);
});

test("a person with no web conversation gets a new one for the wake", async () => {
  const turn = await harness([]).next({ principal: "U1", connector: "Google", linkId: "oauth:n1" });
  assert.match(turn.conversation.threadRef, /^web:U1:/);
});
