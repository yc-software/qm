import test from "node:test";
import assert from "node:assert/strict";
import type { PgMigrationDefinition } from "../../src/persistence/pg-pool.ts";
import { HELD_BACK_CONTRACT_MIGRATIONS } from "../../src/persistence/contract-migrations.ts";
import { registerLegacyMigrations } from "../../src/wiring/legacy-migrations.ts";
import type { StoresModule } from "../../src/wiring/stores.ts";

test("boot registers the numbered contracts and leaves the held-back ones unregistered", () => {
  const ids: string[] = [];
  const pgPool = { registerMigration: (migration: PgMigrationDefinition) => void ids.push(migration.id) };
  registerLegacyMigrations({ stores: { pgPool } as unknown as StoresModule });
  const contracts = ids.filter((id) => id.startsWith("contract/"));
  assert.deepEqual(
    contracts.map((id) => id.slice("contract/".length, "contract/".length + 4)),
    ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010"],
  );
  for (const { id } of HELD_BACK_CONTRACT_MIGRATIONS) assert.ok(!ids.includes(id), `${id} stays held back`);
});
