import "./support/auto-fake-sprites.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createSlackDeliverer } from "../src/slack/deliveries.ts";

const TS = "1723497600.123456";

test("a threaded principal delivery persists provenance before posting even if acknowledgement fails", async () => {
  const built = buildApp(testConfig());
  const provenance = {
    trigger: "cron",
    surface: "cron",
    fireKey: "share:1",
    sourceScopeId: "personal:U-source",
    sourceThreadRef: "cron:source",
    contextProvenance: { sources: ["group:source"], sensitivity: "restricted" as const, sourceUnknown: false },
  };
  const posts: Array<Record<string, unknown>> = [];
  const acks: Array<{ id: string; body: unknown }> = [];
  const delivery = await built.deliveries.enqueue({
    destination: { type: "principal", target: "U-alice", threadTs: TS },
    text: "in the DM thread",
    idempotencyKey: "reach:1",
    provenance,
  });
  const client = {
    conversations: { open: async () => ({ channel: { id: "D-alice" } }) },
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        const session = (await built.sessions.getByThread(`dm:D-alice:${TS}`))!;
        const viewed = await built.app.getSessionForViewer(session.id, { actorId: "U-alice" });
        assert.ok(viewed?.session.sourceProvenance?.sources.includes("group:source"));
        assert.equal((await built.deliveries.get(delivery.id))!.deliveredAt, null);
        return { ts: "1723497601.000001" };
      },
    },
  };
  const deliverer = createSlackDeliverer({
    core: {
      prepareDelivery: (id: string, thread: string) => built.app.preparePrincipalDelivery(id, thread),
      ackDelivery: async (id: string, body: unknown) => {
        acks.push({ id, body });
        throw new Error("synthetic acknowledgement failure");
      },
    } as any,
    flow: { inFlightRuns: { add() {}, delete() {}, has: () => false } } as never,
    threads: { mark: () => undefined } as any,
    clientForIdentity: () => client,
  });

  await deliverer.deliver(client, delivery as never);

  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.channel, "D-alice");
  assert.equal(posts[0]!.thread_ts, TS);
  assert.equal(acks.length, 1);
  assert.equal(acks[0]!.id, delivery.id);
  assert.equal((await built.deliveries.get(delivery.id))!.deliveredAt, null);
  assert.equal((acks[0]!.body as { recipientThreadRef?: string }).recipientThreadRef, `dm:D-alice:${TS}`);
});

test("failed principal provenance preparation cannot post the invitation", async () => {
  let posts = 0;
  const client = {
    conversations: { open: async () => ({ channel: { id: "D-alice" } }) },
    chat: {
      postMessage: async () => {
        posts++;
        return { ts: TS };
      },
    },
  };
  const deliverer = createSlackDeliverer({
    core: {
      prepareDelivery: async () => {
        throw new Error("synthetic provenance failure");
      },
      ackDelivery: async () => {
        throw new Error("must not acknowledge");
      },
    } as never,
    flow: { inFlightRuns: { add() {}, delete() {}, has: () => false } } as never,
    threads: { mark() {} } as never,
    clientForIdentity: () => client,
  });
  await deliverer.deliver(client, {
    id: "prepare-fails",
    destination: { type: "principal", target: "U-alice" },
    text: "Restricted invitation",
    idempotencyKey: "prepare-fails",
    createdAt: Date.now(),
    deliveredAt: null,
    provenance: {
      trigger: "cron",
      surface: "cron",
      fireKey: "share:2",
      sourceScopeId: "personal:U-source",
      sourceThreadRef: "cron:source",
      contextProvenance: { sources: ["group:source"], sensitivity: "restricted", sourceUnknown: false },
    },
  });
  assert.equal(posts, 0);
});
