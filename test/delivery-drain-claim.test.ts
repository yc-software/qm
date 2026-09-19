import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { sleep, withTimeout } from "../src/util/async.ts";

const SECRET = "test-signing-secret".repeat(3);

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "claim-")) }));
  const server = createServer(built.app, { signingSecret: SECRET });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    ...built,
    base,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await built.runtime.stop();
    },
  };
}

function sign(method: string, pathWithQuery: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

async function fetchPending(base: string, query: string): Promise<{ id: string }[]> {
  const path = `/v1/deliveries?${query}`;
  const res = await fetch(`${base}${path}`, { headers: sign("GET", path, "") });
  assert.equal(res.status, 200);
  return ((await res.json()) as { deliveries?: { id: string }[] }).deliveries ?? [];
}

test("overlapping legacy claim pollers cannot take workflow-owned deliveries", async () => {
  const srv = start();
  try {
    await srv.app.enqueueDelivery({
      destination: { type: "group", target: "C1:171.001" },
      text: "reply enqueued mid-deploy",
      idempotencyKey: "post:sess-1:one",
    });
    const [oldTask, newTask] = await Promise.all([
      fetchPending(srv.base, "type=group&claimMs=15000"),
      fetchPending(srv.base, "type=group&claimMs=15000"),
    ]);
    assert.deepEqual(oldTask, []);
    assert.deepEqual(newTask, []);
    assert.equal((await fetchPending(srv.base, "type=group")).length, 1, "the workflow obligation remains visible");
  } finally {
    await srv.close();
  }
});

test("read-only delivery queries remain repeatable while work is pending", async () => {
  const srv = start();
  try {
    await srv.app.enqueueDelivery({
      destination: { type: "web", target: "web:owner:thread" },
      text: "nudge",
      idempotencyKey: "post:sess-2:one",
    });
    const first = await fetchPending(srv.base, "type=web");
    assert.equal(first.length, 1);
    assert.deepEqual(await fetchPending(srv.base, "type=web"), first);
  } finally {
    await srv.close();
  }
});

test("legacy claim expiry and acknowledgements cannot complete a workflow-owned delivery", async () => {
  const srv = start();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let executions = 0;
  const unregister = srv.slackCore.registerDeliveryHandler!(async (_delivery, context) => {
    await context.step("provider:post", async () => {
      executions++;
      entered.resolve();
      await finish.promise;
    });
  });
  try {
    await srv.app.enqueueDelivery({
      destination: { type: "group", target: "C2" },
      text: "owned by the workflow",
      idempotencyKey: "post:sess-3:one",
    });
    const pending = await fetchPending(srv.base, "type=group");
    assert.equal(pending.length, 1);
    srv.runtime.start();
    await withTimeout(() => entered.promise, 2_000, "delivery workflow admission");
    assert.deepEqual(await fetchPending(srv.base, "type=group&claimMs=50"), []);
    for (const [path, payload] of [
      [`/v1/deliveries/${pending[0]!.id}/ack`, {}],
      ["/v1/deliveries/ack-by-key", { idempotencyKey: "post:sess-3:one" }],
    ] as const) {
      const body = JSON.stringify(payload);
      const res = await fetch(`${srv.base}${path}`, { method: "POST", headers: sign("POST", path, body), body });
      assert.equal(res.status, 200);
    }
    await sleep(80);
    assert.deepEqual(await fetchPending(srv.base, "type=group&claimMs=15000"), []);
    assert.deepEqual(await fetchPending(srv.base, "type=group"), pending);
    assert.equal((await srv.deliveries.get(pending[0]!.id))?.deliveredAt, null);
    await srv.runtime.stopBackgroundClaims();
    finish.resolve();
    await withTimeout(() => srv.runtime.backgroundDrained(), 2_000, "delivery workflow handoff");
    assert.deepEqual(await fetchPending(srv.base, "type=group"), pending);
    srv.runtime.startBackground();
    await withTimeout(
      async () => {
        while ((await srv.deliveries.get(pending[0]!.id))?.deliveredAt === null) await sleep(10);
      },
      2000,
      "resumed delivery acknowledgement",
    );
    assert.deepEqual(await fetchPending(srv.base, "type=group"), []);
    assert.notEqual((await srv.deliveries.get(pending[0]!.id))?.deliveredAt, null);
    assert.equal(executions, 1);
  } finally {
    finish.resolve();
    await srv.close();
    unregister();
  }
});
