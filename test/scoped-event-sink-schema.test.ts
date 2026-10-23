import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresEventSink, scopedEventMigrationId, type EventColumn } from "../src/admin/scoped-event-sink.ts";
import { createPostgresErrorLog } from "../src/admin/postgres-error-log.ts";
import { createPostgresEgressAuditSink } from "../src/admin/postgres-egress-audit-sink.ts";
import { createPostgresCredentialUsageSink } from "../src/admin/postgres-credential-usage-sink.ts";
import { registeredPgMigrations } from "../src/persistence/pg-pool.ts";

let n = 0;
const fakeUrl = () => `postgres://unused/schema-test-${process.pid}-${n++}`;

type Ev = { ts: number; scopeLabel: string; a?: number; b?: number };
const BASE: readonly EventColumn<keyof Ev & string>[] = [
  ["ts", "ts", "BIGINT", "number", true],
  ["scope_label", "scopeLabel", "TEXT", "string", true],
  ["a", "a", "INT", "number"],
];
const common = { defaultLimit: 10, equalityFilters: {}, persistErrorMessage: "x" };

test("0001 is rendered from the frozen initial columns, not the live column list", () => {
  const frozenUrl = fakeUrl();
  createPostgresEventSink<Ev>({ ...common, connectionString: frozenUrl, table: "ev", columns: BASE });
  const frozen = registeredPgMigrations(frozenUrl)[0]!;

  const grownUrl = fakeUrl();
  createPostgresEventSink<Ev>({
    ...common,
    connectionString: grownUrl,
    table: "ev",
    columns: [...BASE, ["b", "b", "INT", "number"]],
    schema: {
      initialColumns: BASE,
      expectedChecksum: frozen.checksum,
      followUps: [
        { id: scopedEventMigrationId("ev", 2), statements: ["ALTER TABLE ev ADD COLUMN IF NOT EXISTS b INT"] },
      ],
    },
  });
  const grown = registeredPgMigrations(grownUrl);
  assert.equal(grown[0]!.id, "admin/scoped-events/ev/0001");
  assert.equal(grown[0]!.checksum, frozen.checksum, "adding a follow-up column leaves 0001 untouched");
  assert.equal(grown[1]!.id, "admin/scoped-events/ev/0002");
});

test("editing the frozen 0001 columns trips the pinned checksum", () => {
  assert.throws(
    () =>
      createPostgresEventSink<Ev>({
        ...common,
        connectionString: fakeUrl(),
        table: "ev",
        columns: [...BASE, ["b", "b", "INT", "number"]],
        schema: { expectedChecksum: "0".repeat(64) },
      }),
    /source checksum mismatch/,
  );
});

test("every released scoped-event sink pins its 0001 checksum", () => {
  const url = fakeUrl();
  createPostgresErrorLog(url);
  createPostgresEgressAuditSink(url);
  createPostgresCredentialUsageSink(url);
  assert.deepEqual(
    registeredPgMigrations(url).map((m) => m.id),
    [
      "admin/scoped-events/credential_usage/0001",
      "admin/scoped-events/credential_usage/0002",
      "admin/scoped-events/credential_usage/0003",
      "admin/scoped-events/egress_events/0001",
      "admin/scoped-events/error_events/0001",
    ],
  );
});
