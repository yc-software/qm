import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  FIXTURE_TAIL_TURNS,
  fixtureGroupId,
  PAYLOAD_BUCKETS,
  makeSeedPlan,
  latestMemoryBody,
  payloadLengths,
  payloadMinimum,
  payloadText,
  seedFailure,
  validateTarget,
  visiblePayloads,
  type AggregateProfile,
} from "./seed.ts";
import { uiRows } from "./seed-ui.ts";
import { resourceRows } from "./seed-resources.ts";
import { entrySearchText } from "../../src/sessions/entry-search.ts";

test("fixture errors preserve PostgreSQL diagnostics while redacting database URLs", () => {
  const error = Object.assign(new Error("query failed postgres://fixture:private@localhost/qm_perf_test"), {
    code: "22003",
    routine: "int4mul",
    position: "42",
    detail: "private row content",
    query: "private query parameters",
  });
  const actual = seedFailure(error);
  assert.equal(actual.code, "22003");
  assert.equal(actual.routine, "int4mul");
  assert.equal(actual.position, "42");
  assert.ok(actual.stack?.includes("seed.test.ts"));
  assert.ok(!JSON.stringify(actual).includes("private"));
  assert.equal(actual.detail, undefined);
  assert.equal(actual.query, undefined);
});

test(
  "session seed timestamps retain bigint arithmetic beyond 24 days",
  {
    skip: process.env.QM_PERF_TEST_DATABASE_URL
      ? false
      : "set QM_PERF_TEST_DATABASE_URL for read-only PostgreSQL check",
  },
  async () => {
    const url = process.env.QM_PERF_TEST_DATABASE_URL!;
    validateTarget(url, new URL(url).pathname.slice(1));
    const pg = (await import("pg")).default;
    const client = new pg.Client({ connectionString: url, options: "-c default_transaction_read_only=on" });
    await client.connect();
    try {
      const source = readFileSync(new URL("./seed-db.ts", import.meta.url), "utf8");
      const expression = /scope,thread,surface,([^,]+),title/.exec(source)?.[1];
      assert.ok(expression);
      const at = 1_700_000_000_000;
      for (const days of [1, 25, 108]) {
        const result: import("pg").QueryResult<{ created_at: string }> = await client.query(
          `SELECT ${expression.replace("${durationDays}", String(days))} AS created_at FROM (VALUES($1::bigint)) AS session(at)`,
          [at],
        );
        assert.equal(Number(result.rows[0]!.created_at), at - days * 86_400_000);
      }
    } finally {
      await client.end();
    }
  },
);

test("weighted searchable payloads retain nonempty text in the minimum-size bucket", () => {
  const weights = Array<number>(PAYLOAD_BUCKETS).fill(0);
  weights[0] = 3;
  weights[PAYLOAD_BUCKETS / 2] = 2;
  for (const kind of ["user", "text"]) {
    const lengths = payloadLengths({ bytes: [32, 64, 96, 128], max_bytes: 256 }, "bytes", 40, payloadMinimum(kind));
    const payloads = visiblePayloads(kind, lengths, undefined, 0.5);
    const actual = payloads.reduce(
      (count, row, bucket) => count + (entrySearchText(row.payload)?.trim() ? weights[bucket]! : 0),
      0,
    );
    assert.equal(
      actual,
      weights.reduce((count, weight) => count + weight, 0),
    );
    assert.equal(
      lengths.reduce((count, length) => count + length, 0),
      40 * PAYLOAD_BUCKETS,
    );
  }
  const assistant = visiblePayloads(
    "assistant",
    Array<number>(PAYLOAD_BUCKETS).fill(1024),
    {
      sampled_rows: 100,
      searchable_rows: 25,
      avg_text_chars: 100,
      text_chars: [0, 400, 400, 400],
      newlines: [0, 0, 0, 0],
      code_block_rows: 10,
      table_rows: 5,
    },
    0.5,
  );
  assert.equal(
    assistant.filter((row) => row.body.includes("```text\nQM performance fixture\n```\n")).length,
    Math.round(PAYLOAD_BUCKETS * 0.1),
  );
  assert.equal(
    assistant.filter((row) => row.body.includes("| Fixture | Value |\n| --- | --- |\n| QM | performance |\n")).length,
    Math.round(PAYLOAD_BUCKETS * 0.05),
  );
});

test("fixture planning preserves totals and cohorts deterministically and rejects unsafe targets", () => {
  const bridge = readFileSync(new URL("../../plugins/web-ui/src/core-bridge.ts", import.meta.url), "utf8");
  assert.equal(Number(/export const TAIL_TURNS = (\d+)/.exec(bridge)?.[1]), FIXTURE_TAIL_TURNS);
  const profile: AggregateProfile = {
    collectedAt: "2025-01-01T00:00:00Z",
    results: [
      {
        label: "tables",
        rows: [
          { relname: "sessions", n_live_tup: "1000" },
          { relname: "session_entries", n_live_tup: "10000" },
          { relname: "session_tape", n_live_tup: "16000" },
          { relname: "participants", n_live_tup: "100" },
        ],
      },
      {
        label: "participant_distribution",
        rows: [{ principals: 5, memberships: 100, sessions_per_principal: [4, 50, 60, 65], max_sessions: 70 }],
      },
      {
        label: "session_distribution",
        rows: [
          {
            surface: "cron",
            origin: "cron",
            sessions: 950,
            messages: [4, 8, 12, 20],
            max_messages: 40,
            turns: [1, 1, 1],
          },
          {
            surface: "web",
            origin: "conversation",
            sessions: 50,
            messages: [20, 50, 100, 150],
            max_messages: 400,
            turns: [2, 5, 10],
          },
        ],
      },
      {
        label: "scope_distribution",
        rows: [{ kind: "personal", scopes: 5, sessions: [20, 100, 300], max_sessions: 500 }],
      },
    ],
  };
  profile.results.find((r) => r.label === "session_distribution")!.rows[0]!.sessions = 900;
  profile.results.find((r) => r.label === "session_distribution")!.rows[1]!.sessions = 100;
  const first = makeSeedPlan([profile]);
  assert.deepEqual(first, makeSeedPlan([profile]));
  assert.equal(first.sessions.length, 1000);
  assert.equal(
    first.sessions.reduce((sum, s) => sum + s.messages, 0),
    10000,
  );
  assert.equal(
    first.principals.reduce((sum, p) => sum + p.sessionCount, 0),
    100,
  );
  assert.equal(first.cohorts.max!.sessionCount, 70);
  assert.equal(new Set(first.multiview.map((c) => c.sessionId)).size, 12);
  assert.equal(first.cases.long!.messageCount, 400);
  assert.equal(
    Object.values(first.entryTypes).reduce((sum, count) => sum + count, 0),
    10000,
  );
  assert.equal(first.memberships.length, 100);
  assert.ok(first.multiview.every((c) => c.principalId.endsWith("@example.invalid")));
  const diagnostic = makeSeedPlan([profile], 0.1);
  assert.equal(diagnostic.scale, 0.1);
  assert.equal(diagnostic.cohorts.max!.sessionCount, first.cohorts.max!.sessionCount);
  assert.ok(diagnostic.sessions.filter((s) => s.origin === "conversation").length >= 70);
  assert.equal(payloadText("case", 8192), payloadText("case", 8192));
  assert.notEqual(payloadText("case", 8192), payloadText("other", 8192));
  assert.equal(Buffer.byteLength(payloadText("case", 8192)), 8192);
  const sizes = payloadLengths({ bytes: [32, 64, 96, 128], max_bytes: 256 }, "bytes", 40);
  assert.equal(
    sizes.reduce((sum, size) => sum + size, 0),
    40 * PAYLOAD_BUCKETS,
  );
  assert.equal(sizes[PAYLOAD_BUCKETS / 2 - 1], 32);
  assert.equal(sizes[PAYLOAD_BUCKETS - 1], 256);
  const heavy = payloadLengths({ bytes: [1024, 8000, 20000, 80000], max_bytes: 2000000 }, "bytes", 8000);
  assert.equal(
    heavy.reduce((sum, size) => sum + size, 0),
    8000 * PAYLOAD_BUCKETS,
  );
  assert.equal(Math.max(...heavy), 2000000);
  assert.equal(JSON.stringify(visiblePayloads("tool_call", [500], undefined, 0.9)[0]!.payload).length, 500);
  const shaped = visiblePayloads(
    "user",
    Array<number>(256).fill(4096),
    {
      sampled_rows: 100,
      searchable_rows: 100,
      avg_text_chars: 128,
      text_chars: [100, 200, 300, 400],
      newlines: [0, 1, 2, 3],
      code_block_rows: 0,
      table_rows: 0,
    },
    0.5,
  );
  assert.equal(
    shaped.reduce((sum, row) => sum + row.body.length, 0),
    128 * 256,
  );
  const textLengths = shaped.map((row) => row.body.length).sort((a, b) => a - b);
  assert.ok(Math.abs((textLengths[127]! + textLengths[128]!) / 2 - 100) <= 2);
  assert.ok(
    shaped.every(
      (row) =>
        row.body.length > 0 && JSON.stringify(row.payload).length >= 4084 && JSON.stringify(row.payload).length <= 4096,
    ),
  );
  profile.results.push(
    {
      label: "tape_distribution",
      rows: [
        { kind: "annotation", frequency: 0.5 },
        { kind: "message", frequency: 0.45 },
        { kind: "context_event", frequency: 0.05 },
      ],
    },
    { label: "canonical_tape_entries", rows: [{ rows: 3000 }] },
  );
  const tape = makeSeedPlan([profile]);
  assert.equal(tape.canonicalTapeRows, 3000);
  assert.deepEqual(tape.tapeKinds, { annotation: 8000, message: 7200, context_event: 800 });
  assert.equal(
    tape.sessions.reduce((sum, s) => sum + s.tapeEntries, 0),
    tape.canonicalTapeRows,
  );
  assert.ok(tape.sessions.some((s) => s.tapeEntries === 0));
  for (const fixtureCase of [...Object.values(tape.cases), ...tape.multiview]) {
    const session = tape.sessions.find((s) => s.id === fixtureCase.sessionId)!;
    if (fixtureCase.transcriptStorage === "legacy") assert.equal(session.tapeEntries, 0);
    else if (fixtureCase.transcriptStorage === "mixed")
      assert.equal(session.tapeEntries, Math.floor(session.messages / 2));
    else assert.equal(session.tapeEntries, session.messages);
    assert.ok(tape.memberships.some((m) => m.sessionId === session.id && m.principalId === fixtureCase.principalId));
  }
  profile.results.push({
    label: "ui_table_counts",
    rows: [
      { relname: "loops", n_live_tup: 2 },
      { relname: "loop_items", n_live_tup: 3 },
      { relname: "deployments", n_live_tup: 2 },
      { relname: "base_model_configs", n_live_tup: 2 },
    ],
  });
  const ui = uiRows(makeSeedPlan([profile]));
  assert.equal(ui.length, 9);
  assert.ok(
    ui
      .filter((row) => row.table === "deployments")
      .every((row) => (row.json as { status: string }).status === "stopped"),
  );
  assert.ok(
    ui.filter((row) => row.table === "loops").every((row) => (row.json as { enabled: boolean }).enabled === false),
  );
  profile.results[0]!.rows.push(
    { relname: "file_artifacts", n_live_tup: 40 },
    { relname: "memory_revisions", n_live_tup: 100 },
  );
  profile.results.push(
    {
      label: "file_owner_distribution",
      rows: [
        {
          scopes: 4,
          rows: 40,
          enabled_rows: 38,
          total_quantiles: [10, 10, 10],
          total_max: 10,
          enabled_quantiles: [10, 10, 10],
          enabled_max: 10,
        },
      ],
    },
    {
      label: "memory_scope_distribution",
      rows: [
        {
          scopes: 4,
          revisions_quantiles: [25, 25, 25],
          revisions_max: 25,
          latest_body_quantiles: [300, 300, 300],
          latest_body_max: 300,
          latest_body_mean: 300,
        },
      ],
    },
  );
  const owned = makeSeedPlan([profile]);
  assert.deepEqual(
    owned.resourceOwners.file_artifacts!.map((row) => row.rows),
    [10, 10, 10, 10],
  );
  assert.equal(owned.resourceOwners.file_artifacts!.length, 4);
  assert.equal(
    owned.resourceOwners.file_artifacts!.reduce((n, r) => n + r.rows, 0),
    40,
  );
  assert.equal(
    owned.resourceOwners.file_artifacts!.reduce((n, r) => n + r.enabledRows!, 0),
    38,
  );
  assert.equal(
    owned.resourceOwners.memory_revisions!.reduce((n, r) => n + r.rows, 0),
    100,
  );
  assert.equal(owned.resourceOwners.memory_revisions!.at(-1)!.scopeId, owned.cohorts.max!.scopeId);
  assert.doesNotThrow(() => makeSeedPlan([profile], 0.5));
  const memory = latestMemoryBody(
    { scopeId: "personal:fixture", rows: 1, latestBodyBytes: 1000, latestFacts: 20, latestNewlines: 30 },
    0.5,
  )!;
  assert.equal(Buffer.byteLength(memory), 1000);
  assert.equal(memory.split("\n").length - 1, 30);
  assert.equal(memory.split("\n").filter((line) => /^\s*[-*]\s+.*\S\s*$/.test(line)).length, 20);
  assert.equal(validateTarget("postgres://localhost/qm_perf_case", "qm_perf_case"), "qm_perf_case");
  for (const [url, name] of [
    ["postgres://localhost/prod", "prod"],
    ["postgres://localhost/prod", "qm_perf_case"],
    ["postgres://localhost/qm_perf_case?options=-csearch_path=prod", "qm_perf_case"],
    ["https://localhost/qm_perf_case", "qm_perf_case"],
  ])
    assert.throws(() => validateTarget(url!, name!));
  const namespaced = structuredClone(profile);
  namespaced.results
    .find((r) => r.label === "scope_distribution")!
    .rows.push(
      { kind: "channel", scopes: 2, sessions: [1, 10, 100], max_sessions: 200 },
      { kind: "group", scopes: 2, sessions: [1, 10, 100], max_sessions: 200 },
    );
  namespaced.results
    .find((r) => r.label === "ui_table_counts")!
    .rows.push(
      { relname: "projects", n_live_tup: 1 },
      { relname: "directory_channels", n_live_tup: 2 },
      { relname: "directory_groups", n_live_tup: 2 },
      { relname: "directory_group_members", n_live_tup: 3 },
      { relname: "command_policies", n_live_tup: 10 },
      { relname: "skills", n_live_tup: 10 },
    );
  const namespaces = makeSeedPlan([namespaced]);
  assert.deepEqual(
    namespaces.scopes.filter((scope) => scope.startsWith("channel:")),
    ["channel:perf-1", "channel:perf-2"],
  );
  assert.ok(namespaces.scopes.includes(`group:${fixtureGroupId(2)}`));
  assert.equal(namespaces.scopes.filter((scope) => scope.startsWith("group:web-project-")).length, 1);
  assert.ok(!namespaces.scopes.includes("group:perf-2"));
  assert.deepEqual([fixtureGroupId(1), fixtureGroupId(2)], ["G0000000001", "G0000000002"]);
  assert.ok(namespaces.sessions.every((session) => !session.thread.includes("G000000")));
  assert.equal(namespaces.sessions.length, first.sessions.length);
  assert.equal(namespaces.targets.directory_groups, 2);
  assert.equal(namespaces.targets.directory_group_members, 3);
  assert.ok(
    uiRows(namespaces).some(
      (row) => row.table === "skills" && (row.json as { scopeId: string }).scopeId === "group:G0000000002",
    ),
  );
  assert.ok(
    resourceRows(namespaces).some(
      (row) =>
        row.table === "command_policies" &&
        row.id === "group:G0000000002" &&
        (row.json as { scopeId: string }).scopeId === row.id,
    ),
  );
  assert.throws(() => makeSeedPlan([profile], 0));
  assert.throws(() => makeSeedPlan([profile], 1.1));
});
