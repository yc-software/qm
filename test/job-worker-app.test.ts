import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createJobWorker } from "../src/jobs/job-worker.ts";
import { scopeId } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { settle } from "./support/settle.ts";

const HOOK_SECRET = "hook-secret";

test("a built app runs manual cron fires and webhook fires through the real job worker", async () => {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "jobs-app-")) });
  const built = buildApp(config, { jobs: createJobWorker(config.databaseUrl!) });
  const server = createInsecureTestServer(built.app, { webhookReceiver: built.webhookReceiver });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await built.jobs.start();
  try {
    const cron = await built.crons.create({
      schedule: { everyMs: 60 * 60_000 },
      action: "post the standup",
      owner: "U1",
      createdBy: "U1",
      ownerScopeId: scopeId("personal", "U1"),
    });
    const fired = await built.scheduler.runNow(cron.id);
    assert.ok(fired.started);
    await settle(async () => (await built.crons.listFires(cron.id)).runs[0]?.status !== "running");
    const { runs } = await built.crons.listFires(cron.id);
    assert.deepEqual(
      runs.map((r) => [r.fireKey, r.status]),
      [[fired.fireKey, "ok"]],
    );

    const created = await fetch(`${base}/v1/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ownerScopeId: "personal:U1",
        owner: "U1",
        createdBy: "U1",
        action: "triage",
        verification: { scheme: "github", secret: HOOK_SECRET },
      }),
    });
    const { webhook } = (await created.json()) as { webhook: { id: string } };
    const eventBody = JSON.stringify({ message: "durable webhook event" });
    const accepted = await fetch(`${base}/v1/webhooks/incoming/${webhook.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=" + createHmac("sha256", HOOK_SECRET).update(eventBody).digest("hex"),
      },
      body: eventBody,
    });
    assert.equal(accepted.status, 202);
    const history = async () =>
      (await (await fetch(`${base}/v1/webhooks/${webhook.id}/events?viewer=U1`)).json()) as {
        events: Array<{ deliveryId: string; pending?: boolean; sessionId?: string }>;
      };
    await settle(async () => (await history()).events[0]?.pending === false);
    const { events } = await history();
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event?.pending, false, "the fire job settled the event");
    assert.ok(event?.sessionId, "the fire ran a turn");
  } finally {
    await built.jobs.stop();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
