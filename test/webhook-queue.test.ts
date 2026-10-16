import { createPgBossAutomationQueue } from "../src/triggers/job-queue.ts";
import { withAbort } from "../src/util/async.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { IdempotencyRecord } from "../src/idempotency/idempotency-store.ts";
import { spawn } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createPgBossWebhookQueue } from "../src/webhooks/job-queue.ts";
import { createWebhookReceiver } from "../src/webhooks/webhook-receiver.ts";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { scopeId } from "../src/types.ts";

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;
async function until(check: () => boolean, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(check(), "condition did not become true");
}
function request(deliveryId: string) {
  const rawBody = '{"action":"opened"}';
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": "sha256=" + createHmac("sha256", "secret").update(rawBody).digest("hex"),
    },
  };
}
async function fixture(schema: string, run: () => Promise<{ status: "ok"; reply: string }>) {
  const webhooks = createWebhookStore();
  const webhook = await webhooks.create({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
    action: "Review event",
    verification: { scheme: "github", secret: "secret" },
  });
  const deps = {
    webhooks,
    run,
    deliveries: createDeliveryStore(),
    identity: createIdentityService(),
  };
  const idempotencyBacking = createMemoryMap<IdempotencyRecord>();
  const receiver = () =>
    createWebhookReceiver({
      ...deps,
      idempotency: createIdempotencyStore(idempotencyBacking),
      jobQueue: createPgBossWebhookQueue(databaseUrl!, schema, 2),
    });
  return { webhook, webhooks, receiver };
}

test(
  "acknowledged webhook survives producer shutdown before any worker starts",
  { skip, timeout: 30_000 },
  async () => {
    let calls = 0;
    const f = await fixture("webhook_restart_test", async () => {
      calls++;
      return { status: "ok", reply: "done" };
    });
    const producer = f.receiver();
    assert.deepEqual(await producer.deliver(f.webhook.id, request("restart")), { status: 202 });
    assert.equal(calls, 0);
    await producer.stop();
    const worker = f.receiver();
    try {
      await worker.start();
      await until(() => calls === 1);
      await worker.drained();
      assert.equal((await f.webhooks.listFires(f.webhook.id)).runs[0]?.status, "ok");
      assert.deepEqual(await worker.deliver(f.webhook.id, request("restart")), { status: 200, body: "duplicate" });
    } finally {
      await worker.stop();
    }
  },
);

test("webhook queue retries thrown dispatch failures", { skip, timeout: 40_000 }, async () => {
  let calls = 0;
  const f = await fixture("webhook_retry_test", async () => {
    if (++calls === 1) throw new Error("temporary handoff failure");
    return { status: "ok", reply: "recovered" };
  });
  const worker = f.receiver();
  try {
    await worker.deliver(f.webhook.id, request("retry"));
    await worker.start();
    await until(() => calls === 2, 30_000);
    await worker.drained();
    assert.equal((await f.webhooks.listFires(f.webhook.id)).runs[0]?.reply, "recovered");
  } finally {
    await worker.stop();
  }
});

test("duplicate webhook requests cannot run concurrently across workers", { skip, timeout: 30_000 }, async () => {
  let calls = 0;
  const gate = Promise.withResolvers<void>();
  const f = await fixture("webhook_duplicates_test", async () => {
    calls++;
    await gate.promise;
    return { status: "ok", reply: "done" };
  });
  const a = f.receiver(),
    b = f.receiver();
  try {
    await Promise.all([a.start(), b.start()]);
    await a.deliver(f.webhook.id, request("duplicate"));
    await until(() => calls === 1);
    await Promise.all(Array.from({ length: 8 }, () => b.deliver(f.webhook.id, request("duplicate"))));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(calls, 1);
  } finally {
    gate.resolve();
    await Promise.all([a.stop(), b.stop()]);
  }
});

test("disabled webhook is not executed after being queued", { skip, timeout: 30_000 }, async () => {
  let calls = 0;
  const f = await fixture("webhook_disabled_test", async () => {
    calls++;
    return { status: "ok", reply: "done" };
  });
  const worker = f.receiver();
  try {
    await worker.deliver(f.webhook.id, request("disabled"));
    await f.webhooks.setEnabled(f.webhook.id, false);
    await worker.start();
    let completed = false;
    const end = Date.now() + 15_000;
    while (!completed && Date.now() < end) {
      completed = (await f.webhooks.listFires(f.webhook.id)).runs[0]?.status === "refused";
      if (!completed) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(completed);
    assert.equal(calls, 0);
  } finally {
    await worker.stop();
  }
});

test("paused workers retain new deliveries for resumed claims", { skip, timeout: 30_000 }, async () => {
  let calls = 0;
  const f = await fixture("webhook_resume_test", async () => {
    calls++;
    return { status: "ok", reply: "done" };
  });
  const worker = f.receiver();
  try {
    await worker.start();
    await worker.stopClaims();
    await worker.deliver(f.webhook.id, request("resume"));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(calls, 0);
    await worker.start();
    await until(() => calls === 1);
  } finally {
    await worker.stop();
  }
});

test(
  "a crashed webhook worker loses its lease and another worker retries the job",
  { skip, timeout: 120_000 },
  async () => {
    const schema = "webhook_crashed_worker_test";
    const producer = createPgBossWebhookQueue(databaseUrl!, schema);
    await producer.enqueueFire({
      webhookId: "crash",
      deliveryId: "crash",
      receivedAt: Date.now(),
      input: "event",
      payload: "{}",
    });
    await producer.stop();
    const moduleUrl = new URL("../src/webhooks/job-queue.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { createPgBossWebhookQueue } from ${JSON.stringify(moduleUrl)};
    const queue = createPgBossWebhookQueue(process.env.DATABASE_URL, ${JSON.stringify(schema)});
    await queue.start({ onFire: async () => { process.exit(17); } });
  `,
      ],
      { env: process.env, stdio: "ignore" },
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.equal(
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              child.kill();
              reject(new Error("worker did not claim"));
            }, 20_000);
          }),
        ]),
        17,
      );
    } finally {
      clearTimeout(timer);
    }
    let calls = 0;
    const replacement = createPgBossWebhookQueue(databaseUrl!, schema);
    try {
      await replacement.start({
        onFire: async (job) => {
          assert.equal(job.deliveryId, "crash");
          calls++;
        },
      });
      await until(() => calls === 1, 95_000);
    } finally {
      await replacement.stop();
    }
  },
);

test(
  "queue expiration aborts the waiter before a retry claims the same delivery",
  { skip, timeout: 30_000 },
  async () => {
    const queue = createPgBossAutomationQueue<{ id: string }>(databaseUrl!, "webhook_expiration_test", 2, {
      name: "expiration",
      key: (job) => job.id,
      startAfter: () => Date.now(),
      retryLimit: 1,
      exclusive: true,
      timeoutMs: 1000,
    });
    let attempts = 0;
    let cancelled = false;
    let completed = false;
    try {
      await queue.start({
        onFire: async (_job, signal) => {
          attempts++;
          assert.ok(signal);
          if (attempts === 1) {
            try {
              await withAbort(() => new Promise<void>(() => {}), signal);
            } finally {
              cancelled = signal.aborted;
            }
          } else {
            assert.equal(cancelled, true);
            completed = true;
          }
        },
      });
      await queue.enqueueFire({ id: "delivery" });
      await until(() => completed, 25_000);
      assert.equal(attempts, 2);
    } finally {
      await queue.stop();
    }
  },
);
