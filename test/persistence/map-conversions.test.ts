import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import "../../src/wiring.ts";
import { columnName, mapConversions, mapToTableMigration } from "../../src/persistence/typed-table.ts";
import { CONTRACT_MIGRATIONS, pgMigrationOrder } from "../../src/persistence/contract-migrations.ts";
import { readFileSync } from "node:fs";
import { createPgPool, pgMigrationFrom, registeredPgMigrations } from "../../src/persistence/pg-pool.ts";
import { MODAL_BODIES } from "../../src/sandbox/modal-sandbox.ts";
import { MANAGED_AGENTS_BODIES } from "../../src/sandbox/managed-agents-sandbox.ts";
import { BACKGROUND_OWNERSHIP_MIGRATION } from "../../src/runs/background-ownership.ts";
import { E2B_BODIES } from "../../src/sandbox/e2b-sandbox.ts";
import { assertMapConversion } from "../support/map-conversion.ts";
import { testDatabaseUrl } from "../support/test-database.ts";

const CONVERSIONS = mapConversions();
const CONTRACTS = [...CONTRACT_MIGRATIONS, ...CONVERSIONS.map((conversion) => conversion.contract)];

test("every former durable-map table has a conversion", () => assert.equal(CONVERSIONS.length, 80));

for (const conversion of CONVERSIONS)
  test(`${conversion.spec.table} converts in place for one tenant and for two`, () => assertMapConversion(conversion));

test("a row that does not rebuild from the typed columns fails the conversion and keeps the map", async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    await pool.query(`CREATE TABLE conv_probe (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    await pool.query(`INSERT INTO conv_probe VALUES ('a', '{"n": 1, "stray": true}'), ('b', '{"n": "two"}')`);
    const spec = { table: "conv_probe", key: "id", columns: { n: { type: "bigint", required: true } } } as const;
    for (const dropKeys of [[], ["stray"]]) {
      const { statements } = mapToTableMigration("probe", spec, { dropKeys });
      await assert.rejects(
        (async () => {
          for (const statement of statements) await pool.query(statement);
        })(),
        /conv_probe: row (a|b) does not convert/,
      );
    }
    const kept = await pool.query(`SELECT id, json FROM conv_probe ORDER BY id`);
    assert.deepEqual(kept.rows, [
      { id: "a", json: { n: 1, stray: true } },
      { id: "b", json: { n: "two" } },
    ]);
  } finally {
    await pool.end();
  }
});

test("contracts apply twice after every expand and leave only typed tables", async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    for (const migration of CONTRACTS)
      for (let run = 0; run < 2; run++) for (const statement of migration.statements) await pool.query(statement);
    const tables = CONVERSIONS.map((conversion) => conversion.spec.table);
    const json = await pool.query(
      "SELECT table_name FROM information_schema.columns WHERE column_name = 'json' AND table_name = ANY($1)",
      [tables],
    );
    assert.deepEqual(json.rows, []);
    assert.equal((await pool.query("SELECT to_regclass('durable_map_versions') AS t")).rows[0].t, null);
    const triggers = await pool.query(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text = ANY($1)",
      [tables],
    );
    assert.deepEqual(triggers.rows, []);
  } finally {
    await pool.end();
  }
});

test("contract migrations sort after every other migration", () => {
  const url = "postgresql://contract-order.invalid/probe";
  createPgPool(url, [
    { id: "zeta/0001", statements: ["SELECT 1"] },
    { id: "contract/0001", statements: ["SELECT 2"] },
    { id: "alpha/0001", statements: ["SELECT 3"] },
  ]);
  assert.deepEqual(
    registeredPgMigrations(url).map((migration) => migration.id),
    ["alpha/0001", "zeta/0001", "contract/0001"],
  );
});

test("a fresh database records the drops and the contract of every conversion it expanded", async () => {
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    const recorded = new Set(
      (await pool.query("SELECT id FROM qm_schema_migrations")).rows.map((row: { id: string }) => row.id),
    );
    const expanded = CONVERSIONS.filter((conversion) => recorded.has(conversion.id));
    assert.ok(expanded.length > 0);
    for (const migration of [...CONTRACT_MIGRATIONS, ...expanded.map((conversion) => conversion.contract)])
      assert.ok(recorded.has(migration.id), migration.id);
    for (const conversion of CONVERSIONS.filter((c) => !recorded.has(c.id)))
      assert.ok(!recorded.has(conversion.contract.id), conversion.contract.id);
  } finally {
    await pool.end();
  }
});

test("a store that registers a conversion registers its contract with it", () => {
  const url = "postgresql://contract-pairing.invalid/probe";
  const conversion = CONVERSIONS[0]!;
  createPgPool(url, [conversion]);
  assert.deepEqual(
    registeredPgMigrations(url).map((migration) => migration.id),
    [conversion.id, conversion.contract.id],
  );
});

test("data migrations that clean a table's json run before its typed expand, and every contract runs last", async () => {
  const pairs: Array<[string, string]> = [
    ["durable-map/crons/0002-loops-to-crons", "triggers/crons/0001-typed"],
    ["triggers/crons/0000-drop-retired-keys", "triggers/crons/0001-typed"],
    ["runtime/0002-drop-harness-choice", "typed/config/base_model_configs/0001"],
    ["core/approvals/0000-drop-screened-output", "core/approvals/0001-typed"],
    ["connectors/consent-links/0000-drop-channel-scope-id", "connectors/consent-links/0001-typed"],
  ];
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    const recorded = new Set(
      (await pool.query("SELECT id FROM qm_schema_migrations")).rows.map((row: { id: string }) => row.id),
    );
    for (const [before, after] of pairs) {
      assert.ok(recorded.has(before) && recorded.has(after), `${before} and ${after} are registered`);
      assert.ok(pgMigrationOrder(before, after) < 0, `${before} runs before ${after}`);
      assert.ok(pgMigrationOrder(after, "contract/0001-drop-deliveries") < 0, `${after} runs before the contracts`);
    }
  } finally {
    await pool.end();
  }
});

test("e2b bodies move the older line's keys into columns before the expand and keep them through the contract", async () => {
  const url = "postgresql://e2b-legacy.invalid/probe";
  createPgPool(url, [E2B_BODIES]);
  const ordered = registeredPgMigrations(url);
  assert.deepEqual(
    ordered.map((migration) => migration.id),
    [
      "sandbox/e2b_sandbox_bodies/0000-retired-columns",
      E2B_BODIES.id,
      "contract/sandbox/e2b_sandbox_bodies/0000-retired-columns",
      E2B_BODIES.contract.id,
    ],
  );
  const pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    await pool.query("DROP TABLE IF EXISTS e2b_sandbox_bodies");
    await pool.query("CREATE TABLE e2b_sandbox_bodies (id TEXT PRIMARY KEY, json JSONB NOT NULL)");
    const row = {
      sandboxId: "sbx-1",
      homeDirty: true,
      lastSnapshotMs: 5,
      createdAtMs: 1,
      nativePause: true,
      preservationState: "paused",
      preservationError: "slow",
      recoverySnapshotId: "snap-1",
      recoveryError: "gone",
      operatorFilesStagedAt: 2,
      operatorRecoveryCompletedAt: 3,
    };
    await pool.query("INSERT INTO e2b_sandbox_bodies VALUES ('scope:a', $1)", [JSON.stringify(row)]);
    for (const migration of ordered) for (const statement of migration.statements) await pool.query(statement);
    const columns = E2B_BODIES.spec.columns;
    const typed = await pool.query(
      `SELECT ${Object.keys(columns).map(columnName).join(", ")} FROM e2b_sandbox_bodies WHERE scope_id = 'scope:a'`,
    );
    const back = Object.fromEntries(
      Object.entries(typed.rows[0] as Record<string, unknown>).filter(([, value]) => value !== null),
    );
    assert.deepEqual(back, {
      sandbox_id: "sbx-1",
      home_dirty: true,
      last_snapshot_ms: "5",
      created_at_ms: "1",
      native_pause: true,
      preservation_state: "paused",
      preservation_error: "slow",
      recovery_snapshot_id: "snap-1",
      recovery_error: "gone",
      operator_files_staged_at: "2",
      operator_recovery_completed_at: "3",
    });
  } finally {
    await pool.end();
  }
});

test("released expand migrations keep the checksums databases recorded for them", () => {
  const pinned = JSON.parse(readFileSync(new URL("./expand-checksums.json", import.meta.url), "utf8")) as Record<
    string,
    string
  >;
  const registered = new Map(CONVERSIONS.map((conversion) => [conversion.id, conversion]));
  for (const definition of [MODAL_BODIES, BACKGROUND_OWNERSHIP_MIGRATION, E2B_BODIES, MANAGED_AGENTS_BODIES])
    registered.set(definition.id, definition);
  assert.deepEqual([...registered.keys()].sort(), Object.keys(pinned).sort());
  for (const [id, definition] of registered) assert.equal(pgMigrationFrom(definition).checksum, pinned[id], id);
});

test("e2b and managed-agents bodies re-copy their legacy keys right before their contract", () => {
  for (const bodies of [E2B_BODIES, MANAGED_AGENTS_BODIES]) {
    const url = `postgresql://retired-columns.invalid/${bodies.spec.table}`;
    createPgPool(url, [bodies]);
    const table = bodies.spec.table;
    assert.deepEqual(
      registeredPgMigrations(url).map((migration) => migration.id),
      [
        `sandbox/${table}/0000-retired-columns`,
        bodies.id,
        `contract/sandbox/${table}/0000-retired-columns`,
        bodies.contract.id,
      ],
    );
  }
});
