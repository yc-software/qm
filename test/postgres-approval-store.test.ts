import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresApprovalStore, type ApprovalStore } from "../src/slack/approval-store.ts";
import { createDeliveryStore, type DeliveryStore } from "../src/delivery/delivery-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { withTenant } from "../src/tenants/context.ts";
import type { PendingApprovalRecord } from "../src/types.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb, type TypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;

function record(threadRef: string, createdAt = 1): PendingApprovalRecord {
  return {
    sessionId: threadRef,
    command: "publish",
    createdAt,
    request: {
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      text: "publish report",
    },
    kind: "input",
    grantModes: { session: false, always: false },
  };
}

function withApprovals(
  fn: (db: TypedTableDb<ApprovalStore>, deliveries: DeliveryStore) => Promise<void>,
  enqueue?: Pick<DeliveryStore, "enqueue">,
): Promise<void> {
  const deliveries = createDeliveryStore();
  return withTypedTableDb(
    (url) => createPostgresApprovalStore(url, enqueue ?? deliveries),
    (db) => withTenant(db.tenant, () => fn(db, deliveries)),
  );
}

for (const threadRef of ["dm:D1", "agent:main:subagent:child"]) {
  test(`saving approval immediately delivers a native request for ${threadRef}`, { skip }, async () => {
    await withApprovals(async ({ store: approvals }, deliveries) => {
      await approvals.put("A1", record(threadRef));
      const [delivery] = await deliveries.pending("principal");
      assert.equal(delivery?.destination.commandApprovalId, "A1");
      assert.equal(delivery?.destination.target, "U1");
      assert.deepEqual((await approvals.get("A1"))?.grantModes, { session: false, always: false });
      await approvals.deliverPending();
      assert.equal((await deliveries.pending("principal")).length, 1);
      await deliveries.ack(delivery!.id, Date.now());
      await approvals.delete("A1");
      await approvals.put("A1", record(threadRef, 2));
      assert.equal((await deliveries.pending("principal")).length, 1);
      assert.notEqual((await deliveries.pending("principal"))[0]!.id, delivery!.id);
    });
  });
}

test("persisted approvals recover after enqueue failure and restart without failing the turn", { skip }, async () => {
  await withApprovals(
    async ({ store: failed, url }) => {
      await failed.put("A1", record("agent:main:subagent:child"));
      assert.ok(await failed.get("A1"));
      const deliveries = createDeliveryStore();
      const restarted = createPostgresApprovalStore(url, deliveries);
      try {
        await restarted.deliverPending();
        await restarted.deliverPending();
        assert.equal((await deliveries.pending("principal")).length, 1);
      } finally {
        await restarted.close?.();
      }
    },
    {
      enqueue: async () => {
        throw new Error("delivery unavailable");
      },
    },
  );
});

test("web approvals remain on their native surface", { skip }, async () => {
  await withApprovals(async ({ store: approvals }, deliveries) => {
    const approval = record("web:U1");
    approval.request!.surface = "web";
    await approvals.put("A1", approval);
    await approvals.deliverPending();
    assert.equal((await deliveries.pending("principal")).length, 0);
  });
});

test("system approvals stay pending without enqueuing or reviving an impossible Slack DM", { skip }, async () => {
  const deliveries = createDeliveryStore({ maxAgeMs: 0 });
  await withTypedTableDb(
    (url) => createPostgresApprovalStore(url, deliveries),
    ({ store: approvals, url, tenant }) =>
      withTenant(tenant, async () => {
        const approval = record("slack:C1:ambient:1.0");
        approval.request!.actor.externalId = "system:ambient:acme";
        const stale = await deliveries.enqueue({
          destination: { type: "principal", target: "system:ambient:acme", commandApprovalId: "A1" },
          text: "Approval needed: publish",
          idempotencyKey: "command-approval:A1:1",
        });
        await deliveries.claimPending("principal", 1);
        const expiredAt = (await deliveries.get(stale.id))?.expiredAt;
        assert.ok(expiredAt);

        await approvals.put("A1", approval);
        await approvals.put("A2", approval);
        await approvals.deliverPending();
        const restarted = createPostgresApprovalStore(url, deliveries);
        await restarted.deliverPending();
        await restarted.close?.();

        assert.deepEqual(await approvals.get("A1"), approval, "the protected action still requires approval");
        assert.deepEqual(await approvals.get("A2"), approval);
        assert.deepEqual(await deliveries.pending("principal"), []);
        assert.equal((await deliveries.get(stale.id))?.expiredAt, expiredAt, "a sweep must not revive the stale DM");
      }),
  );
});

test("approvals requested from a Slack DM thread are delivered into that thread", { skip }, async () => {
  for (const threadRef of ["dm:D1:1700.1", "agent:main:subagent:child"]) {
    await withApprovals(async ({ store: approvals }, deliveries) => {
      const approval = record(threadRef);
      approval.request!.slackSource = { accountId: "default", teamId: "T1", userId: "U1", replyThreadTs: "1700.1" };
      await approvals.put("A1", approval);
      const [delivery] = await deliveries.pending("principal");
      assert.equal(delivery?.destination.threadTs, "1700.1");
    });
  }
  await withApprovals(async ({ store: approvals }, deliveries) => {
    const channel = record("channel:C1:1700.2");
    channel.request!.conversation = { kind: "channel", threadRef: "channel:C1:1700.2" } as never;
    channel.request!.slackSource = { accountId: "default", teamId: "T1", userId: "U1", replyThreadTs: "1700.2" };
    await approvals.put("A2", channel);
    assert.equal((await deliveries.pending("principal"))[0]?.destination.threadTs, undefined);
  });
});

test("every record field round-trips and session reads return only the asked sessions", { skip }, async () => {
  await withApprovals(async ({ store: approvals }) => {
    const full: PendingApprovalRecord = {
      ...record("s1"),
      screenedOutput: { tool: "read", text: "secret\u0000 text", sourceScopeId: "personal:alice" },
      reason: "requires approval",
      matched: "publish *",
      purpose: "Publishing",
      summary: "Publish the report",
      summaryDetail: "details",
      approvalKey: "publish",
      blocksInput: false,
      kind: "approval",
    };
    await approvals.put("A1", full);
    await approvals.put("A2", { sessionId: "s2", command: "rm" });
    await approvals.put("A3", { sessionId: "s3", command: "ls", blocksInput: true });
    assert.deepEqual(await approvals.get("A1"), {
      ...full,
      screenedOutput: { ...full.screenedOutput!, text: "secret text" },
    });
    assert.deepEqual(await approvals.get("A2"), { sessionId: "s2", command: "rm" });
    assert.deepEqual(
      (await approvals.forSessions(["s2", "s3"])).map(([id]) => id),
      ["A2", "A3"],
    );
    assert.deepEqual(await approvals.forSessions([]), []);
    assert.deepEqual((await approvals.blockingSessionIds()).sort(), ["s2", "s3"]);
    await approvals.delete("A2");
    assert.equal(await approvals.get("A2"), null);
  });
});

test("approvals are isolated per tenant", { skip }, async () => {
  const deliveries = createDeliveryStore();
  await withTypedTableDb(
    (url) => createPostgresApprovalStore(url, deliveries),
    async ({ store, tenant, otherTenant }) => {
      await withTenant(tenant, () => store.put("A1", { sessionId: "s1", command: "mine" }));
      await withTenant(otherTenant, async () => {
        assert.equal(await store.get("A1"), null);
        assert.deepEqual(await store.forSessions(["s1"]), []);
        assert.deepEqual(await store.blockingSessionIds(), []);
        await store.delete("A1");
        await store.put("A1", { sessionId: "s1", command: "theirs" });
      });
      assert.equal((await withTenant(tenant, () => store.get("A1")))?.command, "mine");
      assert.equal((await withTenant(otherTenant, () => store.get("A1")))?.command, "theirs");
    },
  );
});

test("the conversion backfills approvals into the instance tenant and drops the old table", { skip }, async () => {
  const deliveries = createDeliveryStore();
  const kept = { ...record("s1", 5), screenedOutput: { tool: "read", text: "x" }, blocksInput: false };
  await withTypedTableDb(
    (url) => createPostgresApprovalStore(url, deliveries),
    async ({ store, admin, tenant }) => {
      assert.deepEqual(await withTenant(tenant, () => store.get("A1")), kept);
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, id, to_regclass('approvals_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'approvals') AS versions
           FROM approvals`,
      );
      assert.deepEqual(rows, [{ tenant, id: "A1", dropped: true, versions: 0 }]);
    },
    (admin) => seedKeyValueTable(admin, "approvals", { A1: kept, broken: { command: "no session" } }),
  );
});

test(
  "row security alone hides other tenants' approvals from the app role and fails closed unbound",
  { skip },
  async () => {
    await withTypedTableDb(
      (url) => createPostgresApprovalStore(url, createDeliveryStore()),
      async ({ store, url, tenant, otherTenant }) => {
        await withTenant(tenant, () => store.put("A1", { sessionId: "s1", command: "ls" }));
        const app = createPgPool(url);
        try {
          const rows = (bound: string) => withTenant(bound, () => app.q(`SELECT id FROM approvals`));
          assert.deepEqual(await rows(tenant), [{ id: "A1" }]);
          assert.deepEqual(await rows(otherTenant), []);
          await assert.rejects(app.q(`SELECT id FROM approvals`), /No tenant is bound/);
          await assert.rejects(store.get("A1"), /No tenant is bound/);
        } finally {
          await app.close();
        }
      },
    );
  },
);
