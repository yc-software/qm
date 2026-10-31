import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresSwarmRows } from "../src/swarms/swarm-table.ts";
import type { SwarmStorage } from "../src/swarms/swarm-store.ts";
import { withTenant, withoutTenant } from "../src/tenants/context.ts";
import { PG_URL, seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;

function swarm(id: string, extra: Partial<SwarmStorage> = {}): SwarmStorage {
  return {
    id,
    scopeId: "channel:C1",
    ownerId: "U1",
    participants: ["U1", "U2"],
    createdAt: 1_700_000_000_000,
    template: { model: "m" } as unknown as SwarmStorage["template"],
    settings: { turnMs: 777 } as unknown as SwarmStorage["settings"],
    backend: "modal",
    members: [
      {
        id: `${id}-root`,
        threadRef: `swarm:${id}`,
        depth: 0,
        state: "ready",
        attempts: 0,
        contextJson: JSON.stringify({ role: "root", raw: "\u0000" }),
      },
    ],
    messages: [],
    spawnRequests: { r1: { memberIds: [`${id}-root`], signature: "sig" } },
    messageRequests: {},
    notificationCount: 0,
    pending: false,
    ...extra,
  };
}

const put = (value: SwarmStorage) => () => value;

function ownerUrl(appUrl: string): string {
  const owner = new URL(appUrl);
  const base = new URL(PG_URL!);
  owner.username = base.username;
  owner.password = base.password;
  return owner.toString();
}

async function asOwner<T>(appUrl: string, fn: (rows: ReturnType<typeof createPostgresSwarmRows>) => Promise<T>) {
  const rows = createPostgresSwarmRows(ownerUrl(appUrl));
  try {
    return await fn(rows);
  } finally {
    await rows.close?.();
  }
}

test("writes round-trip every field and pending claims page across tenants", { skip }, async () => {
  await withTypedTableDb(createPostgresSwarmRows, async ({ store, url, tenant, otherTenant }) => {
    const full = swarm("s1", { expiresAt: 1_800_000_000_000, board: { sandboxId: "box" }, pending: true });
    assert.deepEqual(await withTenant(tenant, () => store.write("s1", put(full))), full);
    assert.deepEqual(await withTenant(tenant, () => store.get("s1")), full);
    await withTenant(tenant, () => store.write("s2", put(swarm("s2"))));
    await withTenant(otherTenant, () => store.write("s3", put(swarm("s3", { pending: true }))));
    await withTenant(otherTenant, () => store.write("s1", put(swarm("s1", { ownerId: "U9", pending: true }))));
    assert.equal((await withTenant(tenant, () => store.get("s1")))!.ownerId, "U1");
    assert.equal(await withTenant(otherTenant, () => store.get("s2")), null);
    const claimed = (await asOwner(url, (owner) => owner.pending(undefined, 10))).map((row) => [
      row.id,
      row.tenantId,
      row.ownerId,
    ]);
    assert.deepEqual(
      claimed.sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      [
        ["s1", tenant, "U1"],
        ["s1", otherTenant, "U9"],
        ["s3", otherTenant, "U1"],
      ].sort((a, b) => a[1]!.localeCompare(b[1]!)),
    );
    assert.deepEqual(
      (await asOwner(url, (owner) => owner.pending("s1", 10))).map((row) => row.id),
      ["s3"],
    );
    assert.equal((await asOwner(url, (owner) => owner.pending(undefined, 1))).length, 1);
    assert.deepEqual(
      (await withTenant(tenant, () => store.pending(undefined, 10))).map((row) => [row.id, row.tenantId]),
      [["s1", tenant]],
    );
    await assert.rejects(
      withoutTenant(() => store.pending(undefined, 10)),
      /No tenant is bound/,
    );
    await withTenant(tenant, () => store.write("s1", (current) => ({ ...current!, pending: false })));
    assert.deepEqual(
      (await asOwner(url, (owner) => owner.pending(undefined, 10))).map((row) => row.tenantId),
      [otherTenant, otherTenant],
    );
    await assert.rejects(
      withoutTenant(() => store.get("s1")),
      /No tenant is bound/,
    );
    await assert.rejects(
      withoutTenant(() => store.write("s4", put(swarm("s4")))),
      /No tenant is bound/,
    );
  });
});

test("a failed mutation leaves the stored swarm unchanged", { skip }, async () => {
  await withTypedTableDb(createPostgresSwarmRows, async ({ store, tenant }) => {
    await withTenant(tenant, async () => {
      await store.write("s1", put(swarm("s1")));
      await assert.rejects(
        store.write("s1", () => {
          throw new Error("rollback");
        }),
        /rollback/,
      );
      await assert.rejects(
        store.write("missing", (current) => {
          if (!current) throw new Error("swarm not found");
          return current;
        }),
        /swarm not found/,
      );
      assert.deepEqual(await store.get("s1"), swarm("s1"));
      assert.equal(await store.get("missing"), null);
    });
  });
});

test("the conversion backfills swarms into the instance tenant and drops the old table", { skip }, async () => {
  const full = swarm("full", { expiresAt: 1_800_000_000_000, board: { sandboxId: "box" }, pending: true });
  const minimal = swarm("minimal");
  await withTypedTableDb(
    createPostgresSwarmRows,
    async ({ store, admin, url, tenant }) => {
      assert.deepEqual(await withTenant(tenant, () => store.get("full")), full);
      assert.deepEqual(await withTenant(tenant, () => store.get("minimal")), minimal);
      assert.deepEqual(
        (await asOwner(url, (owner) => owner.pending(undefined, 10))).map((row) => [row.id, row.tenantId]),
        [["full", tenant]],
      );
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, id, participants, expires_at::text AS expires, board, notification_count::int AS count,
                to_regclass('swarms_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'swarms') AS versions,
                (SELECT relrowsecurity FROM pg_class WHERE oid = 'swarms'::regclass) AS rls
           FROM swarms ORDER BY id`,
      );
      const row = { tenant, participants: ["U1", "U2"], count: 0, dropped: true, versions: 0, rls: true };
      assert.deepEqual(rows, [
        { ...row, id: "full", expires: "1800000000000", board: { sandboxId: "box" } },
        { ...row, id: "minimal", expires: null, board: null },
      ]);
    },
    (admin) => seedKeyValueTable(admin, "swarms", { full, minimal }),
  );
});
