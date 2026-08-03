import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

async function withServer(health: () => Promise<void>, run: (base: string) => Promise<void>): Promise<void> {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "healthz-")) }));
  const sessions = built.sessions as typeof built.sessions & { health: () => Promise<void> };
  sessions.health = health;
  const server = createInsecureTestServer(built.app, { sessions });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("healthz checks the configured session store", async () => {
  let calls = 0;
  await withServer(
    async () => {
      calls++;
    },
    async (base) => {
      const response = await fetch(`${base}/healthz`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    },
  );
  assert.equal(calls, 1);
});

test("healthz reports an unavailable session database without leaking the failure", async () => {
  await withServer(
    async () => {
      throw new Error("postgres://secret-host/internal");
    },
    async (base) => {
      const response = await fetch(`${base}/healthz`);
      assert.equal(response.status, 503);
      const body = await response.text();
      assert.deepEqual(JSON.parse(body), { ok: false });
      assert.doesNotMatch(body, /secret-host/);
    },
  );
});

test("healthz times out a hanging session database before the deployment probe", async () => {
  await withServer(
    () => new Promise<void>(() => {}),
    async (base) => {
      const started = Date.now();
      const response = await fetch(`${base}/healthz`);
      assert.equal(response.status, 503);
      assert.ok(Date.now() - started < 1_900);
    },
  );
});

test("runtime stop continues when session store close hangs", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "runtime-stop-")) }));
  const sessions = built.sessions as typeof built.sessions & { close: () => Promise<void> };
  sessions.close = () => new Promise<void>(() => {});
  const started = Date.now();

  await built.runtime.stop();

  assert.ok(Date.now() - started < 1_000);
});
