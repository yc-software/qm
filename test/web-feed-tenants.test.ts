import "./support/auto-fake-sprites.ts";

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { canonicalPayload, TENANT_HEADER } from "../plugins/chassis/src/source-auth-sign.ts";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { OTHER_TENANT, provisionTestTenants, TEST_TENANT } from "./support/tenant.ts";

const SECRET = "test-signing-secret".repeat(3);
const A = TEST_TENANT;
const B = OTHER_TENANT;
const EMAIL = "same@example.com";
const TARGET = `web:${EMAIL}:t1`;

const DATABASE_URL = process.env.DATABASE_URL;

for (const backend of ["memory", "postgres"] as const) {
  describe(`${backend} web feeds`, { skip: backend === "postgres" && !DATABASE_URL }, () => {
    let built: BuiltApp;
    let server: Server;
    before(async () => {
      if (backend === "postgres") await provisionTestTenants(DATABASE_URL!);
      built = buildApp(
        testConfig({
          dataDir: mkdtempSync(join(tmpdir(), "web-feed-tenants-")),
          ...(backend === "postgres" ? { databaseUrl: appLogin(DATABASE_URL!), databaseOwnerUrl: DATABASE_URL! } : {}),
        }),
      );
      server = withoutTenant(() => createServer(built.app, { signingSecret: SECRET }));
      await new Promise<void>((resolve) => withoutTenant(() => server.listen(0, resolve)));
      base = `http://localhost:${(server.address() as AddressInfo).port}`;
    });
    after(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await built.runtime.stop();
    });
    feedTests(() => built);
  });
}

let base = "";

function appLogin(url: string): string {
  const app = new URL(url);
  app.username = "qm_app";
  app.password = "qm-app-test";
  return app.toString();
}

function sign(method: string, path: string, body = "", tenant?: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    ...(tenant ? { [TENANT_HEADER]: tenant } : {}),
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, canonicalPayload(method, path, body, tenant ?? "")),
  };
}

async function listWeb(run: string, tenant?: string): Promise<Array<{ id: string; tenantId?: string; text: string }>> {
  const path = "/v1/deliveries?type=web";
  const res = await fetch(`${base}${path}`, { headers: sign("GET", path, "", tenant) });
  assert.equal(res.status, 200);
  const { deliveries } = (await res.json()) as { deliveries: Array<{ id: string; tenantId?: string; text: string }> };
  return deliveries.filter((d) => d.text.endsWith(run));
}

function ack(id: string, tenant?: string): Promise<Response> {
  const path = `/v1/deliveries/${id}/ack`;
  return fetch(`${base}${path}`, { method: "POST", headers: sign("POST", path, "", tenant) });
}

function openFeed(path: string, tenant?: string): { frames: () => string; close: () => void; ready: Promise<void> } {
  const controller = new AbortController();
  let seen = "";
  const ready = (async () => {
    const res = await fetch(`${base}${path}`, { headers: sign("GET", path, "", tenant), signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    seen += decoder.decode(first.value, { stream: true });
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        seen += decoder.decode(value, { stream: true });
      }
    })();
  })();
  return { frames: () => seen, close: () => controller.abort(), ready };
}

function dataFrames(raw: string, event: string): Array<Record<string, unknown>> {
  return raw
    .split("\n\n")
    .filter((frame) => frame.split("\n").includes(`event: ${event}`))
    .map(
      (frame) =>
        JSON.parse(
          frame
            .split("\n")
            .find((l) => l.startsWith("data: "))!
            .slice(6),
        ) as Record<string, unknown>,
    );
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

function feedTests(app: () => BuiltApp): void {
  test("an unbound delivery poll spans tenants and each ack runs under the delivery's tenant", async () => {
    const run = randomUUID();
    const enqueue = (tenant: string, text: string) =>
      withTenant(tenant, () =>
        app().app.enqueueDelivery({ destination: { type: "web", target: TARGET }, text, idempotencyKey: run }),
      );
    await enqueue(A, `a ${run}`);
    await enqueue(B, `b ${run}`);
    const all = await listWeb(run);
    const forA = all.find((d) => d.text === `a ${run}`)!;
    assert.equal(forA.tenantId, A);
    assert.equal(all.find((d) => d.text === `b ${run}`)?.tenantId, B);
    assert.deepEqual(
      (await listWeb(run, A)).map((d) => d.text),
      [`a ${run}`],
    );
    assert.equal((await ack(forA.id)).status, 401);
    assert.equal((await ack(forA.id, B)).status, 200);
    assert.equal((await listWeb(run)).length, 2);
    assert.equal((await ack(forA.id, A)).status, 200);
    assert.deepEqual(
      (await listWeb(run)).map((d) => d.text),
      [`b ${run}`],
    );
  });

  test("an unbound session-state feed hears every tenant, tagged; a bound feed hears only its own", async () => {
    const feed = openFeed("/v1/session-state/events");
    const onlyA = openFeed("/v1/session-state/events", A);
    await Promise.all([feed.ready, onlyA.ready]);
    for (const tenant of [A, B])
      withTenant(tenant, () =>
        app().sessionStateBus.emit({ threadRef: `web:${EMAIL}:${tenant}`, state: "idle", at: 1 }),
      );
    await until(() => dataFrames(feed.frames(), "session_state").length >= 2);
    await until(() => dataFrames(onlyA.frames(), "session_state").length >= 1);
    feed.close();
    onlyA.close();
    assert.deepEqual(
      dataFrames(feed.frames(), "session_state").map((f) => [f.tenant, f.threadRef]),
      [
        [A, `web:${EMAIL}:${A}`],
        [B, `web:${EMAIL}:${B}`],
      ],
    );
    assert.deepEqual(
      dataFrames(onlyA.frames(), "session_state").map((f) => f.tenant),
      [A],
    );
  });

  test("an unbound loop-item feed hears every tenant, tagged; a bound feed hears only its own", async () => {
    const feed = openFeed("/v1/loop-items/events");
    const onlyB = openFeed("/v1/loop-items/events", B);
    await Promise.all([feed.ready, onlyB.ready]);
    for (const tenant of [A, B])
      withTenant(tenant, () =>
        app().ledgerEventBus.emit({ loopId: `loop-${tenant}`, itemId: "i1", op: "ingest", at: 1, owner: EMAIL }),
      );
    await until(() => dataFrames(feed.frames(), "loop_item").length >= 2);
    await until(() => dataFrames(onlyB.frames(), "loop_item").length >= 1);
    feed.close();
    onlyB.close();
    assert.deepEqual(
      dataFrames(feed.frames(), "loop_item").map((f) => [f.tenant, f.loopId]),
      [
        [A, `loop-${A}`],
        [B, `loop-${B}`],
      ],
    );
    assert.deepEqual(
      dataFrames(onlyB.frames(), "loop_item").map((f) => f.tenant),
      [B],
    );
  });

  test("inbox viewers refuses a request that carries no tenant", async () => {
    const body = JSON.stringify({ loopId: "loop-x", candidates: [EMAIL] });
    const res = await fetch(`${base}/v1/inbox/viewers`, {
      method: "POST",
      headers: sign("POST", "/v1/inbox/viewers", body),
      body,
    });
    assert.equal(res.status, 401);
  });
}
