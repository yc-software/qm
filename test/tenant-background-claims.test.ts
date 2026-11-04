import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { scopeId, type Principal } from "../src/types.ts";
import { createSweeper } from "../src/util/sweeper.ts";
import { createAskExpirySweep } from "../src/triggers/keychain-ask.ts";
import type { KeychainAsk } from "../src/credentials/keychain.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the claim tests";
const actor: Principal = { id: "internal:U1", type: "internal" };
const turn = (text: string): OrchestratorInput => ({
  actor,
  conversation: { kind: "dm", threadRef: `t-${text}`, audience: [actor] },
  origin: { kind: "direct" },
  text,
});

test("loop bodies and sweeps run unbound even when started under a tenant", async () => {
  const seen: Array<string | undefined> = [];
  const sweeper = createSweeper(() => seen.push(boundTenant()), 60_000, { immediate: true });
  withTenant(A, () => sweeper.start());
  await sweeper.stop();
  assert.deepEqual(seen, [undefined]);
});

test("the ask sweep settles each resolved ask under its own tenant", async () => {
  const ask = (id: string, tenantId?: string): KeychainAsk & { tenantId?: string } => ({
    id,
    credentialId: "cred",
    ownerId: "U1",
    requesterId: "U2",
    requesterScopeId: scopeId("personal", "U1"),
    purpose: "test",
    status: "expired",
    createdAt: 0,
    expiresAt: 0,
    ...(tenantId === undefined ? {} : { tenantId }),
  });
  const fired: Array<[string, string | undefined]> = [];
  const notified: Array<[string, string | undefined]> = [];
  const sweep = createAskExpirySweep({
    keychain: {
      unnotifiedResolvedAsks: async () => [ask("a", A), ask("b", B), ask("c")],
      markAskNotified: async (id) => {
        notified.push([id, boundTenant()]);
      },
    },
    fire: async (settled) => fired.push([settled.id, boundTenant()]),
  });
  await sweep(1);
  const expected: Array<[string, string | undefined]> = [
    ["a", A],
    ["b", B],
    ["c", undefined],
  ];
  assert.deepEqual(fired, expected);
  assert.deepEqual(notified, expected);
});

test(
  "a human turn under a bound tenant pokes the reaper unbound, and the poke reaps an expired run",
  { skip },
  async () => {
    const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "reaper-poke-")), workers: 0 });
    const built = buildApp(config);
    try {
      const owner = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
      await built.runs.list();
      const installed = String((await owner.query("SELECT id FROM tenants")).rows[0].id);
      await owner.end();
      const stale = (await built.runs.enqueue({ sessionId: "s-stale", request: turn("stale"), maxAttempts: 3 })).run;
      assert.equal((await built.runs.claim("dead-worker", 10))[0]?.id, stale.id);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await withTenant(installed, () =>
        built.app.turn({
          surface: "test",
          actor: { externalId: "U1" },
          conversation: { kind: "dm", threadRef: "poke" },
          origin: { kind: "human" },
          text: "hello",
          async: true,
        }),
      );
      let status = (await built.runs.get(stale.id))?.status;
      for (let i = 0; i < 200 && status !== "pending"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        status = (await built.runs.get(stale.id))?.status;
      }
      assert.equal(status, "pending");
    } finally {
      await built.runtime.stop();
    }
  },
);
