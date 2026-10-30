import assert from "node:assert/strict";
import test from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import {
  claimStagedEnvelopes,
  installedSlackTenants,
  tenantsWithSessionStatus,
  tenantsWithUnsettledAcks,
} from "../src/slack/slack-tables.ts";
import { createSlackInstallationStore } from "../src/surfaces/slack-installation.ts";
import { withTenant } from "../src/tenants/context.ts";
import { skipWithoutPg, withSlackDb } from "./support/slack-db.ts";

const skip = skipWithoutPg;
const ENVELOPE = { type: "event_callback", team_id: "T1", event: { type: "message", channel: "C1", ts: "1.0" } };
const replay = { staleAfterMs: 1_000, claimMs: 60_000, maxAttempts: 2, abandonAfterMs: 24 * 60 * 60_000 };

test("every Slack table keeps each tenant's rows to itself and refuses unbound access", { skip }, async () => {
  await withSlackDb(async ({ store, tenant, otherTenant }) => {
    const installs = createSlackInstallationStore(store.installation, "key");
    await withTenant(tenant, async () => {
      await installs.set({ botToken: "xoxb-a", appToken: "xapp-a", teamId: "TA", updatedBy: "admin" });
      await store.accounts.put("alice", {
        principalId: "alice",
        accountId: "ca_a",
        memberId: "alice",
        userId: "UA",
        teamId: "TA",
        user: "alice",
        workspace: "A",
      });
      await store.stagedEnvelopes.putIfAbsent("k", { body: ENVELOPE, account: "default", receivedAt: 1, attempts: 0 });
      await store.sessionStatus.putIfAbsent(JSON.stringify(["TA:UB", "C1", "1.0"]), {
        account: "TA:UB",
        channel: "C1",
        threadTs: "1.0",
        anchorRunId: "run-a",
      });
      await store.taskAcknowledgements.putIfAbsent("run-a", {
        channel: "C1",
        emoji: "eyes",
        target: "1.0",
        previous: ["0.9"],
        finished: false,
      });
    });
    await withTenant(otherTenant, async () => {
      assert.equal(await installs.get(), null);
      assert.deepEqual(await installs.status(), { configured: false, managed: false });
      assert.equal(await store.accounts.get("alice"), null);
      assert.deepEqual(await store.sessionStatus.entries(), []);
      assert.equal(await store.sessionStatus.get(JSON.stringify(["TA:UB", "C1", "1.0"])), null);
      assert.deepEqual(await store.taskAcknowledgements.unsettled(), []);
      assert.equal(await store.taskAcknowledgements.get("run-a"), null);
      assert.equal(await store.taskAcknowledgements.update!("run-a", (s) => ({ ...s, finished: true })), null);
      await store.stagedEnvelopes.delete("k");
      await installs.set({ botToken: "xoxb-b", appToken: "xapp-b", teamId: "TB", updatedBy: "admin" });
    });
    await withTenant(tenant, async () => {
      assert.equal((await installs.get())?.botToken, "xoxb-a");
      assert.equal((await store.accounts.get("alice"))?.accountId, "ca_a");
      assert.equal((await store.taskAcknowledgements.get("run-a"))?.previous[0], "0.9");
      assert.equal((await store.sessionStatus.entries()).length, 1);
    });
    await assert.rejects(installs.get(), /No tenant is bound/);
    await assert.rejects(store.accounts.get("alice"), /No tenant is bound/);
  });
});

test(
  "cross-tenant claims return each row's tenant and replay only due, unclaimed rows of live accounts",
  { skip },
  async () => {
    await withSlackDb(async ({ store, owner, tenant, otherTenant }) => {
      const installs = createSlackInstallationStore(store.installation, "key");
      const now = 10 * 24 * 60 * 60_000;
      for (const [id, team] of [
        [tenant, "TA"],
        [otherTenant, "TB"],
      ] as const) {
        await withTenant(id, async () => {
          await installs.set({ botToken: "xoxb", appToken: "xapp", teamId: team, updatedBy: "admin" });
          await store.stagedEnvelopes.putIfAbsent("stale", {
            body: ENVELOPE,
            account: "default",
            receivedAt: now - 5_000,
            attempts: 0,
          });
          await store.stagedEnvelopes.putIfAbsent("fresh", {
            body: ENVELOPE,
            account: "default",
            receivedAt: now,
            attempts: 0,
          });
          await store.stagedEnvelopes.putIfAbsent("abandoned", {
            body: ENVELOPE,
            account: "retired",
            receivedAt: now - 25 * 60 * 60_000,
            attempts: 0,
          });
          await store.sessionStatus.putIfAbsent(JSON.stringify([`${team}:UB`, "C1", "1.0"]), {
            account: `${team}:UB`,
            channel: "C1",
            threadTs: "1.0",
            anchorRunId: "run",
          });
        });
      }
      await withTenant(otherTenant, () =>
        store.taskAcknowledgements.putIfAbsent("run-b", {
          channel: "C1",
          emoji: "eyes",
          target: "1.0",
          previous: [],
          finished: true,
          synced: true,
        }),
      );
      await withTenant(tenant, () =>
        store.taskAcknowledgements.putIfAbsent("run-a", {
          channel: "C1",
          emoji: "eyes",
          target: "1.0",
          previous: [],
          finished: false,
        }),
      );
      assert.deepEqual(
        (await installedSlackTenants(owner.pool)).map((row) => row.tenant_id).sort(),
        [tenant, otherTenant].sort(),
      );
      assert.deepEqual(await tenantsWithUnsettledAcks(owner.pool), [{ tenant_id: tenant }]);
      assert.deepEqual(
        (await tenantsWithSessionStatus(owner.pool)).sort((a, b) => a.account.localeCompare(b.account)),
        [
          { tenant_id: tenant, account: "TA:UB" },
          { tenant_id: otherTenant, account: "TB:UB" },
        ],
      );
      const claim = () =>
        claimStagedEnvelopes(owner.pool, { now, ...replay, accounts: [{ tenantId: tenant, account: "default" }] });
      const first = await claim();
      assert.deepEqual(
        first.map((row) => [row.tenantId, row.key, row.attempts]),
        [[tenant, "stale", 1]],
      );
      assert.deepEqual(first[0]?.body, ENVELOPE);
      assert.deepEqual(await claim(), [], "a claimed row waits out its claim window");
      const abandoned = await owner.pool.q(
        `SELECT count(*)::int AS n FROM slack_staged_envelopes WHERE key = 'abandoned'`,
      );
      assert.equal(abandoned[0]!.n, 0, "rows older than a day are dropped for every tenant");
      const later = () =>
        claimStagedEnvelopes(owner.pool, {
          now: now + 120_000,
          ...replay,
          accounts: [
            { tenantId: tenant, account: "default" },
            { tenantId: otherTenant, account: "default" },
          ],
        });
      const second = await later();
      assert.deepEqual(
        second.map((row) => [row.tenantId, row.key, row.attempts]).sort(),
        [
          [otherTenant, "fresh", 1],
          [otherTenant, "stale", 1],
          [tenant, "fresh", 1],
          [tenant, "stale", 2],
        ].sort(),
      );
    });
  },
);

test("concurrent claimers never receive the same staged envelope", { skip }, async () => {
  await withSlackDb(async ({ store, owner, tenant }) => {
    await withTenant(tenant, async () => {
      for (let i = 0; i < 40; i++)
        await store.stagedEnvelopes.putIfAbsent(`k${i}`, {
          body: ENVELOPE,
          account: "default",
          receivedAt: 1,
          attempts: 0,
        });
    });
    const claim = () =>
      claimStagedEnvelopes(owner.pool, {
        now: 100_000,
        ...replay,
        accounts: [{ tenantId: tenant, account: "default" }],
      });
    const batches = await Promise.all([claim(), claim(), claim()]);
    const keys = batches.flat().map((row) => row.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(keys.length, 40);
  });
});

test(
  "the conversion stamps existing Slack rows with the single tenant and drops the key-value tables",
  { skip },
  async () => {
    const kv = {
      slack_installation: {
        company: {
          orgId: "company",
          disabled: false,
          serviceBlocked: true,
          botTokenEnc: "enc-bot",
          appTokenEnc: "enc-app",
          teamId: "TOLD",
          updatedAt: 5,
          updatedBy: "admin",
          version: "v1",
        },
      },
      slack_accounts: {
        alice: { accountId: "ca", memberId: "alice", userId: "UA", teamId: "TOLD", user: "alice", workspace: "Old" },
      },
      slack_staged_envelopes: {
        "slack:default:message:C1:1.0": { body: ENVELOPE, account: "default", receivedAt: 7, attempts: 1 },
      },
      slack_session_status: {
        '["TOLD:UB","C1","1.0"]': {
          account: "TOLD:UB",
          channel: "C1",
          threadTs: "1.0",
          anchorRunId: "r1",
          cardTs: "2.0",
        },
      },
      slack_task_acknowledgements: {
        r1: { channel: "C1", emoji: "eyes", target: "1.0", previous: ["0.5"], finished: false },
      },
    };
    await withSlackDb(
      async ({ store, admin, tenant }) => {
        const installs = createSlackInstallationStore(store.installation, "key");
        await withTenant(tenant, async () => {
          assert.equal((await installs.status()).teamId, "TOLD");
          assert.equal((await store.accounts.get("alice"))?.workspace, "Old");
          assert.equal((await store.sessionStatus.get('["TOLD:UB","C1","1.0"]'))?.cardTs, "2.0");
          assert.deepEqual((await store.taskAcknowledgements.get("r1"))?.previous, ["0.5"]);
        });
        const leftovers = await admin.query(
          `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'slack%_kv'`,
        );
        assert.equal(leftovers.rows[0].n, 0);
        const versions = await admin.query(`SELECT tbl FROM durable_map_versions WHERE tbl LIKE 'slack%'`);
        assert.deepEqual(versions.rows, []);
        const staged = await admin.query(`SELECT tenant_id::text AS tenant, attempts FROM slack_staged_envelopes`);
        assert.deepEqual(staged.rows, [{ tenant, attempts: 1 }]);
      },
      async (admin) => {
        await admin.query(`CREATE TABLE durable_map_versions(tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)`);
        for (const [table, rows] of Object.entries(kv)) {
          await admin.query(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
          await admin.query(`INSERT INTO durable_map_versions(tbl, v) VALUES ($1, 1)`, [table]);
          for (const [id, json] of Object.entries(rows))
            await admin.query(`INSERT INTO ${table}(id, json) VALUES ($1, $2)`, [id, JSON.stringify(json)]);
        }
        const url = new URL(process.env.DATABASE_URL!);
        url.searchParams.set(
          "options",
          `-c search_path=${(await admin.query("SELECT current_schema() AS s")).rows[0].s}`,
        );
        createPgPool(url.toString(), [
          {
            id: "seed/0001-tenant",
            statements: [`INSERT INTO tenants(id, slug, name) VALUES (gen_random_uuid(), 'main', 'Main')`],
          },
        ]);
      },
    );
  },
);
