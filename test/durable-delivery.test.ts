import { createSlackCoreClient } from "../src/api/slack-core-client.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSurfaceToolDeps } from "../src/core/orchestrator/surface-tools.ts";
import { turnPostKeys } from "../src/core/orchestrator/turn-helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { LogLevel, WebClient } from "@slack/web-api";
import { NO_RETRY } from "../src/slack/config.ts";
import { withOperationSignal } from "../src/util/async.ts";
import { DurableTaskDeferred } from "../src/durable/tasks.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createDeliveryDispatcher, type DeliveryTaskContext } from "../src/delivery/task-delivery.ts";
import { createSlackDeliveryHandler } from "../src/slack/task-delivery.ts";
import { uploadDurableAttachment } from "../src/slack/attachments.ts";
import { createWebDeliveryHandler } from "../src/delivery/web-transcript-delivery.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { runResultDelivery } from "../src/delivery/run-result-delivery.ts";
import type { Delivery } from "../src/types.ts";
import type { Run } from "../src/runs/run-store.ts";

function checkpoints(after?: (key: string) => void): DeliveryTaskContext {
  const saved = new Map<string, unknown>();
  return {
    async step<T>(key: string, execute: () => Promise<T>): Promise<T> {
      if (saved.has(key)) return structuredClone(saved.get(key)) as T;
      const value = await execute();
      after?.(key);
      saved.set(key, structuredClone(value));
      return value;
    },
  };
}

test("durable delivery retries only unfinished effects and does not expire accepted work", async () => {
  const spawned: string[] = [];
  const store = createDeliveryStore({
    maxAgeMs: 0,
    scheduler: {
      spawnDelivery: async (id) => {
        spawned.push(id);
      },
    },
  });
  const delivery = await store.enqueue({
    destination: { type: "slack", target: "C1" },
    text: "answer",
    idempotencyKey: "result",
  });
  const dispatcher = createDeliveryDispatcher(store);
  let posts = 0;
  let fail = true;
  dispatcher.register(["slack"], async (_delivery, context) => {
    await context.step("post", async () => {
      posts++;
      return "posted";
    });
    if (fail) throw new Error("worker exited after posting");
  });
  const context = checkpoints();
  await assert.rejects(dispatcher.execute(delivery.id, context), /worker exited/);
  assert.equal((await store.get(delivery.id))?.deliveredAt, null);
  assert.deepEqual(await store.claimPending("slack", 1), []);
  assert.equal((await store.get(delivery.id))?.expiredAt, undefined);
  fail = false;
  await dispatcher.execute(delivery.id, context);
  assert.equal(posts, 1);
  assert.notEqual((await store.get(delivery.id))?.deliveredAt, null);
  assert.deepEqual(spawned, [delivery.id]);
});

test("a missing surface keeps delivery outstanding for a worker with the adapter", async () => {
  const store = createDeliveryStore();
  const delivery = await store.enqueue({
    destination: { type: "slack", target: "C1" },
    text: "answer",
    idempotencyKey: "missing-adapter",
  });
  await assert.rejects(createDeliveryDispatcher(store).execute(delivery.id, checkpoints()), DurableTaskDeferred);
  assert.equal((await store.get(delivery.id))?.deliveredAt, null);
});

test("an attachment reconciles a completed share after losing the step receipt", async () => {
  let allocations = 0;
  let transfers = 0;
  let shares = 0;
  let shared = false;
  let crash = true;
  const context = checkpoints((key) => {
    if (key.endsWith(":share") && crash) {
      crash = false;
      throw new Error("lost receipt");
    }
  });
  const client = {
    files: {
      getUploadURLExternal: async () => {
        allocations++;
        return { file_id: "F1", upload_url: "https://example.test/upload" };
      },
      completeUploadExternal: async () => {
        shares++;
        shared = true;
        return {};
      },
      info: async () => {
        if (!shared) throw { data: { error: "file_deleted" } };
        return { file: { shares: { private: { C1: [{ ts: "200.001" }] } } } };
      },
    },
  };
  const transfer = (async () => {
    transfers++;
    return new Response("ok");
  }) as typeof fetch;
  const execute = () =>
    uploadDurableAttachment(
      context,
      "file",
      client,
      "C1",
      "100.001",
      { name: "answer.txt", sizeBytes: 6, mimetype: "text/plain", blobId: "b1" },
      { readBlob: async () => Buffer.from("answer"), readFileArtifact: async () => Buffer.from("answer") },
      transfer,
    );
  await assert.rejects(execute(), /lost receipt/);
  assert.deepEqual(await execute(), { fileId: "F1", messageTs: "200.001" });
  assert.deepEqual({ allocations, transfers, shares }, { allocations: 1, transfers: 1, shares: 1 });
});

test("an expired Slack upload ticket is replaced from its durable artifact on retry", async () => {
  let allocations = 0;
  let blobReads = 0;
  let artifactReads = 0;
  let shares = 0;
  let shared = false;
  const context = checkpoints();
  const client = {
    files: {
      getUploadURLExternal: async () => ({ file_id: `F${++allocations}`, upload_url: "https://example.test/upload" }),
      completeUploadExternal: async ({ files }: { files: Array<{ id: string }> }) => {
        if (files[0]!.id === "F1") throw { data: { error: "file_not_found" } };
        shares++;
        shared = true;
      },
      info: async ({ file }: { file: string }) => {
        if (file === "F1" || !shared) throw { data: { error: "file_deleted" } };
        return { file: { shares: { private: { C1: [{ ts: "200.001" }] } } } };
      },
    },
  };
  const execute = () =>
    uploadDurableAttachment(
      context,
      "file",
      client,
      "C1",
      undefined,
      {
        name: "answer.txt",
        sizeBytes: 6,
        mimetype: "text/plain",
        blobId: "b1",
        artifactId: "artifact1",
        artifactViewerId: "U1",
      },
      {
        readBlob: async () => {
          if (++blobReads > 1) throw new Error("blob expired");
          return Buffer.from("answer");
        },
        readFileArtifact: async () => {
          artifactReads++;
          return Buffer.from("answer");
        },
      },
      (async () => new Response("ok")) as typeof fetch,
    );
  await assert.rejects(execute(), /expired before completion/);
  assert.deepEqual(await execute(), { fileId: "F2", messageTs: "200.001" });
  assert.deepEqual(await execute(), { fileId: "F2", messageTs: "200.001" });
  assert.deepEqual({ allocations, artifactReads, shares }, { allocations: 2, artifactReads: 1, shares: 1 });
});

test("a missing approval card is delivered from its durable request", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    conversations: {
      open: async () => ({ channel: { id: "D1" } }),
      history: async () => ({ messages: posts }),
      replies: async () => ({ messages: posts }),
    },
    chat: {
      postMessage: async (message: Record<string, unknown>) => {
        posts.push({ ...message, ts: String(posts.length + 1) });
        return { ts: String(posts.length) };
      },
    },
  };
  const core = {
    getApproval: async () => ({
      requestId: "a1",
      command: "deploy",
      reason: "needs approval",
      request: {
        surface: "slack",
        actor: { externalId: "U1" },
        conversation: { kind: "channel" },
        deliveryTarget: "C1:100.001",
        text: "deploy",
      },
    }),
  };
  const execute = createSlackDeliveryHandler({
    core: core as never,
    client,
    clientForIdentity: () => client,
    threads: { mark() {} },
  });
  const delivery: Delivery = {
    id: "d1",
    idempotencyKey: "approval-delivery",
    destination: { type: "slack", target: "C1:100.001", approvalRequestIds: ["a1"] },
    text: "",
    createdAt: 1,
    deliveredAt: null,
  };
  await execute(delivery, checkpoints());
  await execute(delivery, checkpoints());
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.channel, "D1");
  assert.equal(posts[1]!.channel, "C1");
});

test("approval-only run results retain a durable delivery obligation", () => {
  const delivery = runResultDelivery({
    id: "r1",
    status: "done",
    request: {
      surface: "slack",
      surfaceTools: true,
      deliveryTarget: "C1",
      actor: { id: "U1", type: "internal" },
      conversation: { kind: "dm", threadRef: "t1", audience: [] },
      origin: { kind: "human" },
    },
    result: { status: "pending_approval", pendingApprovals: [{ requestId: "a1", command: "deploy", reason: "ask" }] },
  } as unknown as Run);
  assert.deepEqual(delivery?.destination.approvalRequestIds, ["a1"]);
});

test("web delivery is recorded without a browser and stays idempotent beyond the old scan limit", async () => {
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("web:one", "dm", "personal:U1");
  const delivery: Delivery = {
    id: "d1",
    destination: { type: "web", target: "web:one" },
    text: "durable answer",
    idempotencyKey: "web-result",
    createdAt: 1,
    deliveredAt: null,
  };
  let notifications = 0;
  const execute = createWebDeliveryHandler(sessions, () => {
    notifications++;
  });
  await execute(delivery, checkpoints());
  const { lease } = await sessions.acquireLease(session.id, "turn");
  for (let i = 0; i < 220; i++)
    await sessions.append(lease!, { type: "user", payload: { text: `later ${i}` }, scopeLabel: session.scopeId });
  await sessions.releaseLease(lease!);
  await execute(delivery, checkpoints());
  const entries = await sessions.getEntries(session.id);
  assert.equal(
    entries.filter((entry) => (entry.payload as { deliveryKey?: string }).deliveryKey === "web-result").length,
    1,
  );
  assert.equal(notifications, 2);
});

test("a terminal delivery waits for an in-flight progress edit and fences later progress", async () => {
  const run = { id: "r-order", status: "running", request: {}, result: {} } as unknown as Run;
  const core = createSlackCoreClient({
    advisoryLock: createMemoryAdvisoryLock(),
    agentRequests: createMemoryMap(),
    runs: { get: async () => run, onTerminal: () => () => {} },
  } as any);
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const writes: string[] = [];
  const progress = core.runProgress!(run.id, async () => {
    entered.resolve();
    await finish.promise;
    writes.push("progress");
  });
  await entered.promise;
  run.status = "done";
  const handler = createSlackDeliveryHandler({
    core,
    client: {
      chat: {
        update: async () => {
          writes.push("final");
          return {};
        },
      },
    },
    clientForIdentity: () => null,
    threads: { mark() {} },
  });
  const store = createDeliveryStore();
  const delivery = await store.enqueue({
    destination: { type: "slack", target: "C1", editRef: "1.1" },
    text: "done",
    idempotencyKey: `run:${run.id}`,
  });
  const final = handler(delivery, checkpoints());
  const late = core.runProgress!(run.id, async () => {
    writes.push("late");
  });
  finish.resolve();
  await Promise.all([progress, final, late]);
  assert.deepEqual(writes, ["progress", "final"]);
});

test("resuming a surface turn does not overwrite a prior explicit post that consumed its progress message", async () => {
  const deliveries = createDeliveryStore();
  const context = {
    deps: { deliveries, runs: { get: async () => ({ deliveryState: { editRef: "1.1" } }) } },
    input: { surfaceTools: true, runId: "r-surface" },
    actor: { id: "u1" },
    conversation: {},
    session: { id: "s1" },
    defaultDestination: { type: "slack", target: "C1" },
    postProvenance: (key: string) => ({ fireKey: key }),
    spine: { surfaceOutboundCount: 0 },
  };
  const keys = turnPostKeys("r-surface");
  const first = createSurfaceToolDeps({ ...context, postKeys: keys } as any)!;
  assert.equal((await first.post!("first answer"))?.ok, true);
  const resumedKeys = turnPostKeys("r-surface");
  resumedKeys.seed(1);
  const resumed = createSurfaceToolDeps({ ...context, postKeys: resumedKeys } as any)!;
  assert.equal((await resumed.post!("next answer"))?.ok, true);
  assert.equal((await deliveries.getByKey(keys.key(context.defaultDestination, 0)))?.destination.editRef, "1.1");
  assert.equal((await deliveries.getByKey(keys.key(context.defaultDestination, 1)))?.destination.editRef, undefined);
});

test("delivery adapters are isolated by Slack account and release their registrations", async () => {
  const store = createDeliveryStore();
  const dispatcher = createDeliveryDispatcher(store);
  const delivered: string[] = [];
  dispatcher.register(["slack"], async () => {
    delivered.push("default");
  });
  const unregister = dispatcher.register(
    ["slack"],
    async () => {
      delivered.push("staff");
    },
    "staff",
  );
  const row = await store.enqueue({
    destination: { type: "slack", target: "C1", slackAccount: "staff" },
    text: "answer",
    idempotencyKey: "account-route",
  });
  await dispatcher.execute(row.id, checkpoints());
  assert.deepEqual(delivered, ["staff"]);
  unregister();
  const next = await store.enqueue({
    destination: row.destination,
    text: "next",
    idempotencyKey: "account-route-next",
  });
  await assert.rejects(dispatcher.execute(next.id, checkpoints()), DurableTaskDeferred);
});

test("a known completed upload waits for delayed visibility without completing or allocating again", async () => {
  const context = checkpoints();
  let allocations = 0;
  let completions = 0;
  let visible = false;
  const client = {
    files: {
      getUploadURLExternal: async () => ({ file_id: `F${++allocations}`, upload_url: "https://example.test/upload" }),
      completeUploadExternal: async () => {
        if (++completions > 1) throw { data: { error: "file_not_found" } };
      },
      info: async () => ({ file: { shares: visible ? { private: { C1: [{ ts: "2.1" }] } } : {} } }),
    },
  };
  const execute = () =>
    uploadDurableAttachment(
      context,
      "file",
      client,
      "C1",
      undefined,
      { name: "x", mimetype: "text/plain", sizeBytes: 1, blobId: "b" },
      { readBlob: async () => Buffer.from("x"), readFileArtifact: async () => Buffer.from("x") },
      (async () => new Response("ok")) as typeof fetch,
    );
  await assert.rejects(execute(), DurableTaskDeferred);
  visible = true;
  assert.deepEqual(await execute(), { fileId: "F1", messageTs: "2.1" });
  assert.deepEqual({ allocations, completions }, { allocations: 1, completions: 1 });
});

test("an uncertain completed upload keeps the same file when its one-shot ticket disappears", async () => {
  let loseReceipt = true;
  const context = checkpoints((key) => {
    if (key === "file:complete" && loseReceipt) {
      loseReceipt = false;
      throw new Error("lost completion receipt");
    }
  });
  let allocations = 0;
  let completions = 0;
  let visible = false;
  const client = {
    files: {
      getUploadURLExternal: async () => ({ file_id: `F${++allocations}`, upload_url: "https://example.test/upload" }),
      completeUploadExternal: async () => {
        if (++completions > 1) throw { data: { error: "file_not_found" } };
      },
      info: async () => ({ file: { shares: visible ? { private: { C1: [{ ts: "2.1" }] } } : {} } }),
    },
  };
  const execute = () =>
    uploadDurableAttachment(
      context,
      "file",
      client,
      "C1",
      undefined,
      { name: "x", mimetype: "text/plain", sizeBytes: 1, blobId: "b" },
      { readBlob: async () => Buffer.from("x"), readFileArtifact: async () => Buffer.from("x") },
      (async () => new Response("ok")) as typeof fetch,
    );
  await assert.rejects(execute(), /lost completion receipt/);
  await assert.rejects(
    execute(),
    (error: unknown) => error instanceof DurableTaskDeferred && /uncertain/.test(error.message),
  );
  assert.equal(allocations, 1);
  visible = true;
  assert.deepEqual(await execute(), { fileId: "F1", messageTs: "2.1" });
  assert.deepEqual({ allocations, completions }, { allocations: 1, completions: 2 });
});

test(
  "a handed-off Slack post remains uncertain until the original request is reconciled",
  { timeout: 3000 },
  async () => {
    const { createDurableTasks } = await import("../src/durable/tasks.ts");
    const { createAdmittedWork } = await import("../src/util/admitted-work.ts");
    const tasks = createDurableTasks({ queue: "slack_post_handoff" });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const replayed = Promise.withResolvers<void>();
    const messages: Array<{ ts: string; metadata?: unknown }> = [];
    let posts = 0;
    const client = {
      chat: {
        async postMessage(args: { metadata?: unknown }) {
          const index = ++posts;
          if (index === 1) {
            entered.resolve();
            await release.promise;
          }
          messages.push({ ...args, ts: String(index) });
          return { ts: String(index), channel: "C1" };
        },
      },
      conversations: {
        history: async () => ({ messages }),
        replies: async () => ({ messages }),
      },
    };
    const handler = createSlackDeliveryHandler({
      client,
      clientForIdentity: () => client,
      core: {} as Parameters<typeof createSlackDeliveryHandler>[0]["core"],
      threads: { mark() {} },
    });
    tasks.register("delivery", (context) =>
      handler(
        {
          id: "d1",
          destination: { type: "slack", target: "C1" },
          text: "Deliver exactly once",
          idempotencyKey: "post-handoff",
          createdAt: Date.now(),
        } as Delivery,
        context,
      ),
    );
    await tasks.spawn("delivery", {}, { idempotencyKey: "post-handoff" });
    const retiring = tasks.start({ pollIntervalMs: 1 });
    try {
      await entered.promise;
      retiring.requestHandoff(0);
      await retiring.drained();
      const replacement = tasks.start({
        pollIntervalMs: 1,
        admittedWork: {
          ...createAdmittedWork(),
          run: async (run) => {
            try {
              return await run();
            } finally {
              replayed.resolve();
            }
          },
        },
      });
      await replayed.promise;
      await replacement.stop();
      release.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(posts, 1);
      assert.equal(messages.length, 1);
    } finally {
      release.resolve();
      await tasks.close();
    }
  },
);

test("a durable Slack post reconciles delayed visibility without resending an ambiguous request", async () => {
  const { postWithVerify } = await import("../src/slack/delivery.ts");
  const context = checkpoints();
  let posts = 0;
  let visible = false;
  const message = { ts: "1.1", metadata: { event_type: "qm_delivery", event_payload: { idempotency_key: "pending" } } };
  const client = {
    chat: {
      postMessage: async () => {
        posts++;
        throw new Error("connection closed before response");
      },
    },
    conversations: {
      history: async () => ({ messages: visible ? [message] : [] }),
      replies: async () => ({ messages: visible ? [message] : [] }),
    },
  };
  const post = () => postWithVerify(client, { channel: "C1", text: "once" }, "pending", { context, verifyFirst: true });
  await assert.rejects(post(), DurableTaskDeferred);
  await assert.rejects(post(), DurableTaskDeferred);
  assert.equal(posts, 1);
  visible = true;
  assert.deepEqual(await post(), { channel: "C1", ts: "1.1", reused: true });
  assert.equal(posts, 1);
});

test("a durable Slack post retries a confirmed rate limit without duplicating an accepted attempt", async () => {
  const { postWithVerify } = await import("../src/slack/delivery.ts");
  const context = checkpoints();
  let posts = 0;
  const client = {
    chat: {
      postMessage: async () => {
        if (++posts === 1) throw { code: "slack_webapi_rate_limited_error", retryAfter: 0 };
        return { ts: "1.1", channel: "C1" };
      },
    },
    conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) },
  };
  const post = () =>
    postWithVerify(client, { channel: "C1", text: "once" }, "rate-limit", { context, verifyFirst: true });
  assert.deepEqual(await post(), { channel: "C1", ts: "1.1" });
  assert.deepEqual(await post(), { channel: "C1", ts: "1.1" });
  assert.equal(posts, 2);
});

test("a real Slack client preserves a definite rate limit for durable retries", { timeout: 5000 }, async () => {
  const { postWithVerify } = await import("../src/slack/delivery.ts");
  let posts = 0;
  const server = createServer((request, response) => {
    const posting = request.url?.endsWith("chat.postMessage");
    const limited = posting && ++posts === 1;
    const success = posting ? { ok: true, ts: "1.1", channel: "C1" } : { ok: true, messages: [] };
    response.writeHead(limited ? 429 : 200, { "retry-after": "0", "content-type": "application/json" });
    response.end(JSON.stringify(limited ? { ok: false, error: "ratelimited" } : success));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new WebClient("test-token", {
    ...NO_RETRY,
    slackApiUrl: `http://127.0.0.1:${address.port}/api/`,
    logLevel: LogLevel.ERROR,
  });
  const context = checkpoints();
  const post = () =>
    postWithVerify(
      client as unknown as Parameters<typeof postWithVerify>[0],
      { channel: "C1", text: "once" },
      "sdk-rate-limit",
      {
        context,
        verifyFirst: true,
      },
    );
  try {
    assert.deepEqual(await post(), { channel: "C1", ts: "1.1" });
    assert.deepEqual(await post(), { channel: "C1", ts: "1.1" });
    assert.equal(posts, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const prerequisite of ["lock", "progress lookup"] as const) {
  for (const mutation of ["update", "delete"] as const) {
    test(`a retired Slack ${mutation} cannot run after its pending ${prerequisite} completes`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      let reads = 0;
      let mutations = 0;
      const wait = async () => {
        entered.resolve();
        await release.promise;
      };
      const client = { chat: { [mutation]: async () => mutations++ } };
      const handler = createSlackDeliveryHandler({
        core: {
          async getDeliveryRun() {
            if (++reads === 2 && prerequisite === "progress lookup") await wait();
            return { id: "r1", request: {}, deliveryState: { editRef: "1.1" } };
          },
          async withRunDeliveryLock(_id: string, run: () => Promise<unknown>) {
            if (prerequisite === "lock") await wait();
            return run();
          },
        } as unknown as Parameters<typeof createSlackDeliveryHandler>[0]["core"],
        client,
        clientForIdentity: () => client,
        threads: { mark() {} },
      });
      const active = withOperationSignal(controller.signal, () =>
        handler(
          {
            id: "d1",
            destination: { type: "slack", target: "C1" },
            text: mutation === "update" ? "done" : "",
            idempotencyKey: "run:r1",
            createdAt: Date.now(),
            deliveredAt: null,
          },
          checkpoints(),
        ),
      );
      await entered.promise;
      controller.abort();
      release.resolve();
      await assert.rejects(active, { name: "AbortError" });
      assert.equal(mutations, 0);
    });
  }
}

test("a durable Slack post retries a recorded rejection after the destination is repaired", async () => {
  const { postWithVerify } = await import("../src/slack/delivery.ts");
  const context = checkpoints();
  let posts = 0;
  const client = {
    chat: {
      postMessage: async () => {
        if (++posts === 1) throw { code: "slack_webapi_platform_error", data: { error: "not_in_channel" } };
        return { ts: "1.1", channel: "C1" };
      },
    },
    conversations: { history: async () => ({ messages: [] }), replies: async () => ({ messages: [] }) },
  };
  const post = () =>
    postWithVerify(client, { channel: "C1", text: "once" }, "repaired", { context, verifyFirst: true });
  await assert.rejects(post(), { code: "slack_webapi_platform_error" });
  assert.deepEqual(await post(), { channel: "C1", ts: "1.1" });
  assert.deepEqual(await post(), { channel: "C1", ts: "1.1" });
  assert.equal(posts, 2);
});
