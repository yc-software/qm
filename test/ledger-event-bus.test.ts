import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createPostgresLedgerEventBus, type OwnedLedgerEvent } from "../src/loops/ledger-events.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenants } from "./support/test-tenants.ts";
import { withTenant } from "../src/tenants/context.ts";

function event(over: Partial<OwnedLedgerEvent> = {}): OwnedLedgerEvent {
  return { loopId: "loop-1", itemId: "item-1", op: "ingest", at: 111, owner: "josh", ...over };
}

test("ledger events cross bus instances and an unsubscribed listener hears nothing more", async () => {
  const url = testDatabaseUrl();
  const a = createPostgresLedgerEventBus(url);
  const b = createPostgresLedgerEventBus(url);
  try {
    const got: OwnedLedgerEvent[] = [];
    let off = (): void => {};
    const ready = new Promise<void>((resolve) => {
      off = b.subscribe((e) => {
        if (e.loopId === "loop-xbus") {
          got.push(e);
          resolve();
        }
      });
    });
    const deadline = Date.now() + 5_000;
    for (;;) {
      a.emit(event({ loopId: "loop-xbus", itemId: "item-9", op: "shipped", at: 42, owner: "ada" }));
      const landed = await Promise.race([
        ready.then(() => true),
        new Promise((r) => setTimeout(r, 250)).then(() => false),
      ]);
      if (landed) break;
      if (Date.now() > deadline) assert.fail("event never crossed instances");
    }
    assert.equal(got[0]?.itemId, "item-9");
    assert.equal(got[0]?.op, "shipped");
    assert.equal(got[0]?.owner, "ada");
    assert.equal(got[0]?.at, 42);
    off();
    await new Promise((r) => setTimeout(r, 300));
    const heard = got.length;
    a.emit(event({ loopId: "loop-xbus", op: "reopen" }));
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(got.length, heard, "an unsubscribed listener hears nothing");
  } finally {
    await a.close?.();
    await b.close?.();
  }
});

test("GET /v1/loop-items/events streams every tenant's ledger writes as SSE frames, stamped with the loop owner and tenant", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ap-ledger-sse-"));
  const built = buildApp(testConfig({ dataDir, orgId: "acme" }));
  built.runtime.start();
  const core = createInsecureTestServer(built.app, { webhookReceiver: built.webhookReceiver });
  core.listen(0);
  const base = `http://localhost:${(core.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base}/v1/loop-items/events`, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const ingestIn = (tenant: string) =>
      withTenant(tenant, async () => {
        const { loop } = await built.loops.store.create({
          owner: "josh",
          createdBy: "josh",
          ownerScopeId: "personal:josh",
          name: `Sentry triage ${tenant}`,
          playbook: "triage",
          successCondition: "fixed",
        });
        await built.loops.items.ingest([
          { loopId: loop.id, dedupeKey: "SENTRY-1", sourcePayload: { issue: "SENTRY-1" } },
        ]);
        return loop.id;
      });
    const [a, b] = testTenants();
    const loopA = await ingestIn(a);
    const loopB = await ingestIn(b);

    const reader = res.body!.getReader();
    let buf = "";
    const frames = new Map<string, OwnedLedgerEvent & { tenantId?: string }>();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && frames.size < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      for (const chunk of buf.split("\n\n")) {
        if (!chunk.split("\n").includes("event: loop_item")) continue;
        const data = chunk
          .split("\n")
          .find((l) => l.startsWith("data: "))
          ?.slice("data: ".length);
        if (!data) continue;
        const frame = JSON.parse(data) as OwnedLedgerEvent & { tenantId?: string };
        frames.set(frame.loopId, frame);
      }
    }
    await reader.cancel().catch(() => {});
    for (const [loopId, tenant] of [
      [loopA, a],
      [loopB, b],
    ] as const) {
      const frame = frames.get(loopId);
      assert.ok(frame, "each tenant's ledger write reached the SSE stream");
      assert.equal(frame.op, "ingest");
      assert.equal(frame.owner, "josh", "the frame carries the loop owner the BFF routes by");
      assert.equal(frame.tenantId, tenant);
    }
  } finally {
    await new Promise<void>((r) => core.close(() => r()));
    await built.runtime.stop();
  }
});
