import pg from "pg";
import assert from "node:assert/strict";
import { getConstructionPlans, PgBoss } from "pg-boss";
import { createPgPool, migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { createPostgresMap } from "../../src/persistence/durable-map.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import { createPostgresRunStore } from "../../src/runs/postgres-run-store.ts";
import { createPostgresRunActivityStore } from "../../src/runs/postgres-run-activity-store.ts";
import { createPostgresAuditLog } from "../../src/admin/postgres-audit-log.ts";
import { createPostgresEgressAuditSink } from "../../src/admin/postgres-egress-audit-sink.ts";
import { createPostgresCredentialUsageSink } from "../../src/admin/postgres-credential-usage-sink.ts";
import { createPostgresMetricsSink } from "../../src/admin/postgres-metrics-sink.ts";
import { createPostgresErrorLog } from "../../src/admin/postgres-error-log.ts";
import { createPostgresAdminGrantStore } from "../../src/admin/postgres-admin-grant-store.ts";
import { createPostgresCronFireStore } from "../../src/cron/fire-store.ts";
import { createPostgresDeliveryStore } from "../../src/delivery/postgres-delivery-store.ts";
import { createPostgresDirectoryStore } from "../../src/directory/postgres-directory-store.ts";
import { createPostgresProcessRegistry } from "../../src/processes/process-registry.ts";
import { createPostgresMemoryService } from "../../src/memory/postgres-memory-service.ts";
import { createPostgresFileArtifactStore } from "../../src/files/postgres-file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../../src/files/durable-byte-store.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";
import { createPostgresSurfaceCache } from "../../src/surface-cache/surface-cache.ts";
import { createPostgresAmbientJudgmentStore } from "../../src/surface-cache/ambient-judgment-store.ts";
import { createPostgresAckEmojiPickStore } from "../../src/surface-cache/ack-emoji-pick-store.ts";
import { createTranscriptSource } from "../../src/harness/tape-projection.ts";
import { entrySearchText } from "../../src/sessions/entry-search.ts";
import {
  PAYLOAD_BUCKETS,
  payloadLengths,
  payloadMinimum,
  latestMemoryBody,
  principalId,
  fixtureGroupId,
  validateTarget,
  visiblePayloads,
  type SeedPlan,
} from "./seed.ts";
import { UI_MAPS, uiRows } from "./seed-ui.ts";
import { RESOURCE_MAPS, resourceRows, registerResourceSchemas, seedResourceRelations } from "./seed-resources.ts";
import { activityTimestampSql, prepareActivityPayloads, activityRunSql, activityChannelSql } from "./seed-activity.ts";

const MAPS = ["idempotency", "session_mailbox"];

async function migrate(url: string, client: pg.Client): Promise<void> {
  createPostgresSessionStore(url);
  createPostgresRunStore(url);
  createPostgresRunActivityStore(url);
  createPostgresAuditLog(url);
  createPostgresEgressAuditSink(url);
  createPostgresCredentialUsageSink(url);
  createPostgresMetricsSink(url);
  createPostgresErrorLog(url);
  createPostgresAdminGrantStore(url);
  createPostgresCronFireStore(url);
  createPostgresDeliveryStore(url);
  createPostgresDirectoryStore(url);
  createPostgresProcessRegistry(url);
  createPostgresMemoryService(url);
  createPostgresFileArtifactStore(url, createMemoryDurableByteStore());
  createPostgresGrantStore(url);
  createPostgresSurfaceCache(url);
  createPostgresAmbientJudgmentStore(url);
  createPostgresAckEmojiPickStore(url);
  registerResourceSchemas(url);
  const maps = createPgPool(url);
  for (const table of MAPS) createPostgresMap(maps, table, table === "session_mailbox" ? ["recipientId"] : []);
  for (const [table, indexes] of Object.entries({ ...UI_MAPS, ...RESOURCE_MAPS }))
    createPostgresMap<Record<string, unknown>>(maps, table, indexes);
  await migrateRegisteredPgSchemas(url);
  await maps.close();
  await client.query(getConstructionPlans("pgboss"));
  const boss = new PgBoss({
    connectionString: url,
    schema: "pgboss",
    schedule: false,
    supervise: false,
    migrate: false,
  });
  boss.on("error", () => {});
  try {
    await boss.start();
    await boss.createQueue("cron-fire", { policy: "short", notify: true });
    await boss.createQueue("cron-tick", { policy: "short", notify: true });
  } finally {
    await boss.stop({ close: true, graceful: false });
  }
}

async function bank(client: pg.Client, plan: SeedPlan): Promise<Array<Record<string, unknown>>> {
  const shapeDiagnostics: Array<Record<string, unknown>> = [];
  await client.query(
    "CREATE TEMP TABLE perf_payloads(kind text, bucket int, body text, payload jsonb, PRIMARY KEY(kind,bucket))",
  );
  const profiles = [
    ...(plan.aggregates.entry_sample ?? []).map((row) => ({ kind: String(row.type), row, key: "payload_bytes" })),
    ...[
      ["prompt", "prompt_payloads", "body_bytes"],
      ["request", "request_payloads", "request_bytes"],
      ["memory", "memory_payloads", "body_bytes"],
    ].map(([kind, label, key]) => ({ kind: kind!, row: plan.aggregates[label!]?.[0] ?? {}, key: key! })),
    ...(plan.aggregates.tape_payloads ?? []).map((row) => ({ kind: `tape-${row.kind}`, row, key: "payload_bytes" })),
  ];
  for (const required of [
    "user",
    "assistant",
    "text",
    "thinking",
    "tool_call",
    "tool_result",
    "tape-message",
    "tape-context_event",
    "tape-annotation",
  ])
    if (!profiles.some((p) => p.kind === required)) profiles.push({ kind: required, row: {}, key: "payload_bytes" });
  for (const { kind, row, key } of profiles) {
    const storage =
      plan.aggregates.entry_storage_sample?.find((r) => r.type === kind) ??
      plan.aggregates[`${kind}_storage_sample`]?.[0];
    const ratio = storage ? Math.min(1, Number(storage.avg_stored_bytes) / Number(storage.avg_payload_bytes)) : 0.75;
    const lengths = payloadLengths(
      row,
      key,
      storage ? Number(storage.avg_payload_bytes) : undefined,
      payloadMinimum(kind),
    );
    const shape = plan.aggregates.entry_search_shape?.find((shape) => shape.type === kind);
    const payloads = visiblePayloads(kind, lengths, shape, ratio);
    if (kind === "user" || kind === "text")
      assert.ok(
        payloads.every((row) => entrySearchText(row.payload)?.trim()),
        `Empty searchable ${kind} payload bank`,
      );
    if (shape) {
      const searchable = Math.round((Number(shape.searchable_rows) / Number(shape.sampled_rows)) * PAYLOAD_BUCKETS);
      assert.ok(
        payloads.every(
          (row, bucket) => Boolean(entrySearchText(row.payload)?.trim()) === bucket >= PAYLOAD_BUCKETS - searchable,
        ),
        `Searchable ${kind} payload allocation mismatch`,
      );
      const requested = {
        meanTextChars: Number(shape.avg_text_chars),
        textChars: shape.text_chars,
        maxTextChars: shape.max_text_chars ?? null,
        meanNewlines: shape.avg_newlines ?? null,
        codeBuckets: Math.round((Number(shape.code_block_rows) / Number(shape.sampled_rows)) * PAYLOAD_BUCKETS),
        tableBuckets: Math.round((Number(shape.table_rows) / Number(shape.sampled_rows)) * PAYLOAD_BUCKETS),
      };
      const actual = {
        meanTextChars: payloads.reduce((sum, row) => sum + row.body.length, 0) / PAYLOAD_BUCKETS,
        maxTextChars: Math.max(...payloads.map((row) => row.body.length)),
        meanNewlines: payloads.reduce((sum, row) => sum + row.body.split("\n").length - 1, 0) / PAYLOAD_BUCKETS,
        textChars: [0.5, 0.9, 0.95, 0.99].map((q) => {
          const lengths = payloads.map((row) => row.body.length).sort((a, b) => a - b);
          const rank = (lengths.length - 1) * q;
          const lower = Math.floor(rank);
          return lengths[lower]! + (lengths[Math.ceil(rank)]! - lengths[lower]!) * (rank - lower);
        }),
        codeBuckets: payloads.filter((row) => row.body.includes("```text\nQM performance fixture\n```\n")).length,
        tableBuckets: payloads.filter((row) =>
          row.body.includes("| Fixture | Value |\n| --- | --- |\n| QM | performance |\n"),
        ).length,
      };
      shapeDiagnostics.push({
        kind,
        requested,
        actual,
        textQuantileResiduals: actual.textChars.map((value, i) => value - Number((shape.text_chars as number[])[i])),
        clamped:
          Math.abs(requested.meanTextChars - actual.meanTextChars) > 1 / PAYLOAD_BUCKETS ||
          requested.codeBuckets !== actual.codeBuckets ||
          requested.tableBuckets !== actual.tableBuckets,
      });
    }
    for (let bucket = 0; bucket < PAYLOAD_BUCKETS; bucket++) {
      const { body, payload } = payloads[bucket]!;
      await client.query("INSERT INTO perf_payloads VALUES ($1,$2,$3,$4)", [
        kind,
        bucket,
        body,
        JSON.stringify(payload),
      ]);
    }
  }
  return shapeDiagnostics;
}

export async function seedChannelStates(client: pg.Client, plan: SeedPlan): Promise<number> {
  const result = await client.query(
    `INSERT INTO channel_state(org_id,container,last_ts,oldest_ts,name,kind,members,updated_at)
    SELECT 'perf','perf-'||g,m.last_ts,m.oldest_ts,COALESCE(d.name,'performance-channel-'||g),'channel',COALESCE(r.members,'[]'::jsonb),COALESCE(m.updated_at,$2)
    FROM generate_series(1,$1::int) g
    LEFT JOIN (SELECT container,max(ts::numeric)::text AS last_ts,min(ts::numeric)::text AS oldest_ts,max(created_at) AS updated_at FROM channel_messages WHERE org_id='perf' GROUP BY container) m ON m.container='perf-'||g
    LEFT JOIN directory_channels d ON d.org_id='perf' AND d.channel_id='perf-'||g
    LEFT JOIN (SELECT channel_id,jsonb_agg(principal_id ORDER BY principal_id) AS members FROM directory_channel_members WHERE org_id='perf' GROUP BY channel_id) r ON r.channel_id='perf-'||g`,
    [plan.targets.channel_state ?? 0, plan.anchorTime],
  );
  return result.rowCount ?? 0;
}

export async function seedDatabase(
  url: string,
  databaseName: string,
  plan: SeedPlan,
): Promise<Record<string, unknown>> {
  validateTarget(url, databaseName);
  const client = new pg.Client({
    connectionString: url,
    application_name: "qm-performance-seeder",
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  const verifiedCounts: Record<string, number> = {};
  const target = (table: string) => plan.targets[table] ?? 0;
  const admin = plan.cohorts.max!.principalId;
  const at = plan.anchorTime;
  const durationDays = Math.max(1, target("session_spend_days") || 108);
  const sessionCount = plan.sessions.length;
  const sq = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const scope = "s.scope";
  const browserResourceScope = `CASE WHEN g=1 THEN ${sq(`personal:${admin}`)} WHEN g=2 THEN 'org:perf' ELSE s.scope END`;
  const principal = sq(admin);
  const stamp = activityTimestampSql(at, durationDays);
  const id = (kind: string, value = "g") => `md5('qm-perf-${kind}-' || (${value})::text)::uuid::text`;
  const genericJoin = `FROM generate_series($1::bigint, $2::bigint) g JOIN perf_sessions s ON s.n = ((g-1) % ${sessionCount})+1`;
  const write = async (table: string, sql: string, count = target(table)) => {
    for (let first = 1; first <= count; first += 10_000)
      await client.query(sql, [first, Math.min(count, first + 9_999)]);
    console.log(JSON.stringify({ table, seeded: count }));
  };
  try {
    const identity = (
      await client.query(
        "SELECT current_database() AS name, pg_is_in_recovery() AS recovery, pg_try_advisory_lock(hashtext('qm-performance-seed')) AS locked",
      )
    ).rows[0];
    if (identity.name !== databaseName || identity.recovery || !identity.locked)
      throw new Error("Fixture database identity/ownership check failed");
    const occupied = await client.query(
      "SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S') LIMIT 1",
    );
    if (occupied.rows.length)
      throw new Error(
        "Refusing a nonempty database; seed requires a new isolated database with no application relations",
      );
    const connections = await client.query(
      "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' LIMIT 1",
    );
    if (connections.rows.length) throw new Error("Refusing a database already used by another client");
    await client.query(
      "CREATE TABLE qm_performance_fixture(fixture_id text PRIMARY KEY, profile_sha256 text NOT NULL, status text NOT NULL, manifest jsonb)",
    );
    await client.query("INSERT INTO qm_performance_fixture VALUES ($1,$2,'seeding',NULL)", [
      plan.fixtureId,
      plan.profileSha256,
    ]);
    await migrate(url, client);
    await client.query(
      "CREATE TEMP TABLE perf_sessions(n bigint PRIMARY KEY, id text, scope text, surface text, origin text, thread text, messages int, turns int, title text, at bigint, other_offset bigint, assistant_offset bigint, tape_entries int)",
    );
    for (let first = 0; first < sessionCount; first += 2000)
      await client.query(
        "INSERT INTO perf_sessions SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(n bigint,id text,scope text,surface text,origin text,thread text,messages int,turns int,title text,at bigint,other_offset bigint,assistant_offset bigint,tape_entries int)",
        [
          JSON.stringify(
            plan.sessions.slice(first, first + 2000).map((s) => ({
              ...s,
              other_offset: s.otherOffset,
              assistant_offset: s.assistantOffset,
              tape_entries: s.tapeEntries,
            })),
          ),
        ],
      );
    await client.query("ANALYZE perf_sessions");
    await client.query(
      "CREATE TEMP TABLE perf_resource_owners(table_name text,first_row bigint,last_row bigint,scope_id text,enabled_rows bigint,latest_body text)",
    );
    for (const [table, owners] of Object.entries(plan.resourceOwners)) {
      let first = 1;
      for (const owner of owners) {
        const measured = plan.aggregates.memory_scope_distribution?.[0];
        const body = latestMemoryBody(
          owner,
          Math.min(1, Number(measured?.latest_stored_mean) / Number(measured?.latest_body_mean)),
        );
        await client.query("INSERT INTO perf_resource_owners VALUES($1,$2,$3,$4,$5,$6)", [
          table,
          first,
          first + owner.rows - 1,
          owner.scopeId,
          owner.enabledRows ?? owner.rows,
          body,
        ]);
        first += owner.rows;
      }
    }
    const payloadShapeDiagnostics = await bank(client, plan);
    await prepareActivityPayloads(client, plan);
    await client.query(`INSERT INTO sessions(id,type,scope_id,thread_ref,surface,created_at,title,last_activity,messages,turns,origin,origin_id)
      SELECT id,CASE WHEN scope LIKE 'channel:%' THEN 'channel' WHEN scope LIKE 'group:%' THEN 'group' ELSE 'dm' END,scope,thread,surface,at-${durationDays}::bigint*86400000,title,at,messages,turns,origin,CASE WHEN origin='cron' THEN 'perf-cron-'||(n % ${Math.max(1, target("crons"))}) END FROM perf_sessions`);
    const memberships = plan.memberships;
    for (let first = 0; first < memberships.length; first += 2000)
      await client.query(
        'INSERT INTO participants(session_id,principal_id,valid_from,valid_from_seq) SELECT "sessionId","principalId",0,0 FROM jsonb_to_recordset($1::jsonb) AS t("sessionId" text,"principalId" text)',
        [JSON.stringify(memberships.slice(first, first + 2000))],
      );
    await client.query("CREATE TEMP TABLE perf_entry_kinds(first bigint,last bigint,kind text)");
    const forcedAssistants = plan.sessions.filter((s) => s.messages > 1).length + Number(plan.earlierEntry.seq > 0);
    let otherEntries = 0;
    for (const [kind, count] of Object.entries(plan.entryTypes)) {
      if (kind === "user") continue;
      const remaining = kind === "assistant" ? count - forcedAssistants : count;
      if (remaining < 0) throw new Error("Entry type quotas cannot accommodate required sentinels");
      if (remaining)
        await client.query("INSERT INTO perf_entry_kinds VALUES($1,$2,$3)", [
          otherEntries,
          otherEntries + remaining - 1,
          kind,
        ]);
      otherEntries += remaining;
    }
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    let multiplier = 65537;
    while (gcd(multiplier, otherEntries) !== 1) multiplier += 2;
    const earlier = `s.id=${sq(plan.earlierEntry.sessionId)} AND e.seq=${plan.earlierEntry.seq}`;
    const cases = [...new Set([...Object.values(plan.cases), ...plan.multiview].map((c) => c.sessionId))]
      .map(sq)
      .join(",");
    const ordinal = `(s.other_offset+e.seq-floor(e.seq::numeric*s.turns/greatest(1,s.messages-1))::bigint-1-CASE WHEN s.id=${sq(plan.earlierEntry.sessionId)} AND ${plan.earlierEntry.seq}>0 AND e.seq>${plan.earlierEntry.seq} THEN 1 ELSE 0 END)`;
    const mappedOrdinal = `((${ordinal}*${multiplier})%${Math.max(1, otherEntries)})`;
    const assistantOrdinal = `(CASE WHEN k.kind='assistant' THEN s.assistant_offset+CASE WHEN s.id=${sq(plan.earlierEntry.sessionId)} AND ${plan.earlierEntry.seq}>0 AND e.seq=s.messages-1 THEN 1 ELSE 0 END ELSE ${mappedOrdinal}-p.first+${forcedAssistants} END)`;
    const searchableAssistant = plan.entrySearchTargets?.assistant;
    const shape = plan.aggregates.entry_search_shape?.find((row) => row.type === "assistant");
    const blankAssistantBuckets = shape
      ? PAYLOAD_BUCKETS - Math.round((PAYLOAD_BUCKETS * Number(shape.searchable_rows)) / Number(shape.sampled_rows))
      : 0;
    if (searchableAssistant !== undefined && (!blankAssistantBuckets || blankAssistantBuckets === PAYLOAD_BUCKETS))
      throw new Error("Exact search counts require both visible and metadata-only assistant payloads");
    const bucket =
      searchableAssistant === undefined
        ? `(e.seq*37+s.n*17)%${PAYLOAD_BUCKETS}`
        : `CASE WHEN COALESCE(k.kind,p.kind)='assistant' THEN CASE WHEN ${assistantOrdinal}<${searchableAssistant} THEN ${blankAssistantBuckets}+(${assistantOrdinal}*37)%${PAYLOAD_BUCKETS - blankAssistantBuckets} ELSE (${assistantOrdinal}*37)%${blankAssistantBuckets} END ELSE (e.seq*37+s.n*17)%${PAYLOAD_BUCKETS} END`;
    for (let first = 1; first <= sessionCount; first += 500) {
      await client.query(
        `INSERT INTO session_entries(session_id,seq,parent_seq,type,payload,scope_label,created_at)
        SELECT s.id,e.seq,CASE WHEN e.seq=0 THEN NULL ELSE e.seq-1 END,COALESCE(k.kind,p.kind),
          CASE WHEN s.id IN (${cases}) AND e.seq=0 THEN jsonb_set(b.payload,'{text}',to_jsonb('QM PERF '||s.id||' first '||COALESCE(b.payload->>'text','')))::text
               WHEN s.id IN (${cases}) AND e.seq=s.messages-1 THEN jsonb_set(b.payload,'{text}',to_jsonb('QM PERF '||s.id||' last '||COALESCE(b.payload->>'text','')))::text
               WHEN ${earlier} THEN jsonb_set(b.payload,'{text}',to_jsonb('QM PERF '||s.id||' earlier '||COALESCE(b.payload->>'text','')))::text
               WHEN COALESCE(k.kind,p.kind) IN ('tool_call','tool_result') THEN jsonb_set(b.payload,'{callId}',to_jsonb(s.id||':'||(row_number() OVER(PARTITION BY s.id,COALESCE(k.kind,p.kind) ORDER BY e.seq))::text))::text ELSE b.payload::text END,
          s.scope,s.at-(s.messages-1-e.seq)*100
        FROM perf_sessions s CROSS JOIN LATERAL generate_series(0,s.messages-1) e(seq)
        CROSS JOIN LATERAL (SELECT CASE WHEN (e.seq=s.messages-1 AND e.seq>0) OR (${earlier}) THEN 'assistant' WHEN e.seq=0 OR floor(e.seq::numeric*s.turns/greatest(1,s.messages-1))>floor((e.seq-1)::numeric*s.turns/greatest(1,s.messages-1)) THEN 'user' END AS kind) k
        LEFT JOIN perf_entry_kinds p ON k.kind IS NULL AND ${mappedOrdinal} BETWEEN p.first AND p.last
        JOIN perf_payloads b ON b.kind=COALESCE(k.kind,p.kind) AND b.bucket=${bucket} WHERE s.n BETWEEN $1 AND $2`,
        [first, Math.min(sessionCount, first + 499)],
      );
      if (first % 10_000 === 1)
        console.log(
          JSON.stringify({
            table: "session_entries",
            sessionsDone: Math.min(sessionCount, first + 499),
            totalSessions: sessionCount,
          }),
        );
    }
    for (let first = 1; first <= sessionCount; first += 500)
      await client.query(
        `INSERT INTO session_tape(session_id,seq,kind,harness,payload,scope_label,entry_seq,entry_created_at,created_at)
      SELECT e.session_id,e.seq,'annotation','mock',json_build_object('event','transcript_entry','entry',json_build_object('parentSeq',e.parent_seq,'type',e.type,'payload',e.payload::json,'at',e.created_at))::text,e.scope_label,e.seq,e.created_at,e.created_at
      FROM session_entries e JOIN perf_sessions s ON s.id=e.session_id WHERE s.n BETWEEN $1 AND $2 AND e.seq<s.tape_entries`,
        [first, Math.min(sessionCount, first + 499)],
      );
    let tapeOffset = 0;
    for (const [kind, total] of Object.entries(plan.tapeKinds)) {
      const count = total - (kind === "annotation" ? plan.canonicalTapeRows : 0);
      await write(
        "session_tape",
        `INSERT INTO session_tape(session_id,seq,kind,harness,payload,scope_label,created_at)
        SELECT s.id,s.messages+((g-1+${tapeOffset})/${sessionCount})::int,${sq(kind)},'mock',b.payload::text,${scope},${stamp}
        FROM generate_series($1::bigint,$2::bigint) g JOIN perf_sessions s ON s.n=((g-1+${tapeOffset})%${sessionCount})+1
        JOIN perf_payloads b ON b.kind=${sq(`tape-${kind}`)} AND b.bucket=g%${PAYLOAD_BUCKETS}`,
        count,
      );
      tapeOffset += count;
    }
    await write(
      "llm_prompt_envelopes",
      `INSERT INTO llm_prompt_envelopes(hash,body,created_at) SELECT md5('perf-prompt-'||g),json_build_object('messages',json_build_array(json_build_object('role','user','content',b.body)))::text,${stamp} FROM generate_series($1::bigint,$2::bigint) g JOIN perf_payloads b ON b.kind='prompt' AND b.bucket=g%${PAYLOAD_BUCKETS}`,
    );
    const storage = plan.aggregates.request_storage_sample?.[0];
    const nullFraction = storage ? Number(storage.null_requests) / Number(storage.sampled_rows) : 0;
    await write(
      "session_llm_requests",
      `INSERT INTO session_llm_requests(id,session_id,turn_seq,step,model,scope_label,created_at,request,prompt_hash,truncated,usage_json,duration_ms,ttft_ms)
      SELECT ${id("llm")},s.id,0,(g/${sessionCount})::int,'gpt-4.1',${scope},${stamp},CASE WHEN g%10000<${Math.round(nullFraction * 10000)} THEN NULL ELSE json_build_object('messages',json_build_array(json_build_object('role','user','content',b.body)))::text END,
      CASE WHEN g%10000<${Math.round(nullFraction * 10000)} AND ${target("llm_prompt_envelopes")}>0 THEN md5('perf-prompt-'||((g-1)%${Math.max(1, target("llm_prompt_envelopes"))}+1)) END,false,
      '{"costUsd":0.01,"input":1000,"output":200,"cacheRead":100,"cacheWrite":0}',1200,200 ${genericJoin} JOIN perf_payloads b ON b.kind='request' AND b.bucket=g%${PAYLOAD_BUCKETS}`,
    );
    await write(
      "runs",
      `INSERT INTO runs(id,session_id,status,request,result,idempotency_key,attempts,created_at,started_at,finished_at,returned_at) ${activityRunSql(plan)}`,
    );
    await write(
      "tool_calls",
      `INSERT INTO tool_calls(run_id,attempt,call_index,output,created_at) SELECT ${id("run", `((g-1)%${Math.max(1, target("runs"))})+1`)},1,((g-1)/${Math.max(1, target("runs"))})::int,b.payload::text,${stamp} FROM generate_series($1::bigint,$2::bigint) g JOIN perf_payloads b ON b.kind='tool_result' AND b.bucket=g%${PAYLOAD_BUCKETS}`,
    );
    await write(
      "audit_log",
      `INSERT INTO audit_log(at,principal_id,action,resource,scope_label,status) SELECT ${stamp},${principal},(ARRAY['credential.broker.use','credential.broker.use','credential.broker.use','session.read','session.llm.read','keychain.materialize','sessions.read','audit.read'])[1+(g%8)::int],'QM performance audit '||g,${scope},'ok' ${genericJoin}`,
    );
    await write(
      "egress_events",
      `INSERT INTO egress_events(ts,source,host,allowed,scope_label,principal_id,verdict) SELECT ${stamp},'proxy','fixture.example.invalid',g%20<>0,${scope},${principal},CASE WHEN g%20=0 THEN 'host_denied' ELSE 'allow' END ${genericJoin}`,
    );
    await write(
      "credential_usage",
      `INSERT INTO credential_usage(ts,slug,host,status,scope_label,principal_id) SELECT ${stamp},'fixture-service','fixture.example.invalid','ok',${scope},${principal} ${genericJoin}`,
    );
    await write(
      "turn_metrics",
      `INSERT INTO turn_metrics(ts,scope_label,session_id,run_id,status,total_ms,ttft_ms,model_calls,tool_calls) SELECT ${stamp},${scope},s.id,${id("run", `((g-1)%${Math.max(1, target("runs"))})+1`)},'ok',1200+(g%1200)::int,200+(g%100)::int,2,5 ${genericJoin}`,
    );
    await write(
      "error_events",
      `INSERT INTO error_events(ts,scope_label,category,code,message,session_id) SELECT ${stamp},${scope},'fixture','fixture_error','QM performance error '||g,s.id ${genericJoin}`,
    );
    await write(
      "process_sessions",
      `INSERT INTO process_sessions(process_id,scope_id,kind,command,started_at,expires_at,status,session_ref,run_id) SELECT ${id("process")},${scope},'background','printf fixture',${stamp},${stamp}+1000,'exited',s.thread,${id("run", `((g-1)%${Math.max(1, target("runs"))})+1`)} ${genericJoin}`,
    );
    await write(
      "cron_fires",
      `INSERT INTO cron_fires(cron_id,fire_key,thread_ref,session_id,fired_at,scheduled_at,ended_at,status,reply) SELECT 'perf-cron-'||(g%${Math.max(1, target("crons"))}),${id("fire")},s.thread,s.id,${stamp},${stamp},${stamp}+1200,'done','QM performance cron result' ${genericJoin}`,
    );
    await write(
      "memory_revisions",
      plan.resourceOwners.memory_revisions
        ? `INSERT INTO memory_revisions(scope_id,seq,op,body,author,at) SELECT o.scope_id,g-o.first_row+1,'replace',CASE WHEN g=o.last_row THEN o.latest_body ELSE '- QM performance memory '||b.body END,${principal},${stamp} FROM generate_series($1::bigint,$2::bigint) g JOIN perf_resource_owners o ON o.table_name='memory_revisions' AND g BETWEEN o.first_row AND o.last_row JOIN perf_payloads b ON b.kind='memory' AND b.bucket=g%${PAYLOAD_BUCKETS}`
        : `INSERT INTO memory_revisions(scope_id,seq,op,body,author,at) SELECT ${browserResourceScope},g,'replace','- QM performance memory '||b.body,${principal},${stamp} ${genericJoin} JOIN perf_payloads b ON b.kind='memory' AND b.bucket=g%${PAYLOAD_BUCKETS}`,
    );
    await write(
      "deliveries",
      `INSERT INTO deliveries(id,idempotency_key,destination,text,created_at,delivered_at,provenance,source_cron_id) SELECT ${id("delivery")},'perf-delivery-'||g,json_build_object('type','web','target',s.thread),'QM performance delivered fixture',${stamp},${stamp}+1000,json_build_object('sourceSessionId',s.id,'sourceThreadRef',s.thread),'perf-cron-'||(g%${Math.max(1, target("crons"))}) ${genericJoin}`,
    );
    await write(
      "file_artifacts",
      plan.resourceOwners.file_artifacts
        ? `INSERT INTO file_artifacts(id,owner_scope_id,path,name,mimetype,size_bytes,direction,created_by,created_in_scope,created_at,updated_at,enabled) SELECT ${id("file")},o.scope_id,'fixture/'||g||'.txt','QM performance file '||g,'text/plain',0,'out',${principal},o.scope_id,${stamp},${stamp},g-o.first_row<o.enabled_rows FROM generate_series($1::bigint,$2::bigint) g JOIN perf_resource_owners o ON o.table_name='file_artifacts' AND g BETWEEN o.first_row AND o.last_row`
        : `INSERT INTO file_artifacts(id,owner_scope_id,path,name,mimetype,size_bytes,direction,created_by,created_in_scope,created_at,updated_at) SELECT ${id("file")},${browserResourceScope},'fixture/'||g||'.txt','QM performance file '||g,'text/plain',0,'out',${principal},${browserResourceScope},${stamp},${stamp} ${genericJoin}`,
    );
    await write(
      "acl_grants",
      `INSERT INTO acl_grants(owner_scope_id,path,grantee_scope_id,permission,granted_by) SELECT COALESCE(o.scope_id,${browserResourceScope}),'fixture/'||g||'.txt','org:perf','read',${principal} ${genericJoin} LEFT JOIN perf_resource_owners o ON o.table_name='file_artifacts' AND g BETWEEN o.first_row AND o.last_row`,
    );
    await write(
      "run_activity",
      `INSERT INTO run_activity(run_id,seq,parent_seq,type,payload,created_at) SELECT ${id("run", `((g-1)%${Math.max(1, target("runs"))})+1`)},g,g-1,'text','{"text":"QM performance activity"}',${at}-(g%60000) ${genericJoin}`,
    );
    await write(
      "channel_messages",
      `INSERT INTO channel_messages(org_id,container,ts,author_id,author_name,text,created_at,handled,sub,bot,self,deleted,edited_at,deleted_at,mentions) ${activityChannelSql(plan)}`,
    );
    if (target("channel_files") && !target("channel_messages"))
      throw new Error("Channel files require cached messages");
    await write(
      "channel_files",
      `INSERT INTO channel_files(org_id,container,ts,file_id,name,mimetype,created_at,title,size)
      SELECT m.org_id,m.container,m.ts,'perf-file-'||g,'QM performance Slack file '||g||'.txt','text/plain',m.created_at,'QM performance Slack attachment',1024
      FROM generate_series($1::bigint,$2::bigint) g JOIN channel_messages m ON m.org_id='perf' AND m.ts=(((g-1)%${Math.max(1, target("channel_messages"))})+1)::text`,
    );
    await write(
      "session_pins",
      `INSERT INTO session_pins(id,session_id,text,entry_seq,added_by,created_at)
      SELECT ${id("pin")},s.id,'QM performance pinned context '||g,0,${principal},${stamp}
      FROM generate_series($1::bigint,$2::bigint) g JOIN (
        SELECT s.id,row_number() OVER(ORDER BY s.at DESC,s.id) AS n FROM perf_sessions s JOIN participants p ON p.session_id=s.id WHERE p.principal_id=${principal}
      ) s ON s.n=((g-1)%${plan.cohorts.max!.sessionCount})+1`,
    );
    await write(
      "ambient_judgments",
      `INSERT INTO ambient_judgments(org_id,surface,container,decision,reason,model,latency_ms,created_at) SELECT 'perf','slack','perf-'||(1+g%100),'ignore','QM performance decision','mock',120,${stamp} ${genericJoin}`,
    );
    await write(
      "ack_emoji_picks",
      `INSERT INTO ack_emoji_picks(org_id,surface,channel,ts,outcome,picked,message,model,latency_ms,created_at) SELECT 'perf','slack','perf-'||(1+g%100),g::text,'picked','white_check_mark','QM performance reaction','mock',120,${stamp} ${genericJoin}`,
    );
    await write(
      "job_common",
      `INSERT INTO pgboss.job(id,name,state,data,created_on,started_on,completed_on,keep_until) SELECT md5('perf-job-'||g)::uuid,'cron-fire','completed',json_build_object('cronId','perf-cron-'||(g%${Math.max(1, target("crons"))}),'scheduledAt',${stamp}),to_timestamp((${stamp})/1000.0),to_timestamp((${stamp})/1000.0),to_timestamp((${stamp}+1000)/1000.0),to_timestamp(${at}/1000.0)+interval '365 days' ${genericJoin}`,
    );
    for (const table of MAPS) {
      let value = `jsonb_build_object('id',${id(table)},'value','QM performance fixture','createdAt',${stamp})`;
      if (table === "session_mailbox")
        value = `jsonb_build_object('id',${id(table)},'recipientId',s.id,'senderId',s.id,'actor',jsonb_build_object('id',${principal},'type','internal'),'text','QM performance consumed message','createdAt',${stamp},'consumed',true,'audience','[]'::jsonb)`;
      await write(table, `INSERT INTO ${table}(id,json) SELECT ${id(table)},${value} ${genericJoin}`);
    }
    for (const row of [...uiRows(plan), ...resourceRows(plan)])
      await client.query(`INSERT INTO ${row.table}(id,json) VALUES($1,$2)`, [row.id, JSON.stringify(row.json)]);
    await seedResourceRelations(client, plan);
    const members = Math.max(plan.principals.length + target("deactivated_principals"), target("directory_members"));
    for (let i = 1; i <= members; i++)
      await client.query(
        "INSERT INTO directory_members(org_id,principal_id,display_name,display_name_lc,type) VALUES('perf',$1,$2,$3,'internal')",
        [principalId(i), `Performance user ${i}`, `performance user ${i}`],
      );
    const adminPrincipals = [admin, ...plan.principals.map((p) => p.principalId).filter((p) => p !== admin)];
    assert.ok(target("admin_grants") <= adminPrincipals.length, "Admin grants exceed synthetic principal population");
    for (const owner of adminPrincipals.slice(0, target("admin_grants")))
      await client.query(
        "INSERT INTO admin_grants(principal_id,scope_id,role,granted_by,created_at) VALUES($1,'org:perf','org_admin',$2,$3)",
        [owner, admin, at],
      );
    for (let i = 1; i <= target("directory_channels"); i++)
      await client.query(
        "INSERT INTO directory_channels(org_id,channel_id,name,name_lc,roster_known) VALUES('perf',$1,$2,$2,true)",
        [`perf-${i}`, `performance-channel-${i}`],
      );
    const groupIds = Array.from({ length: target("directory_groups") }, (_, i) => fixtureGroupId(i + 1));
    for (const groupId of groupIds)
      await client.query("INSERT INTO directory_groups(org_id,group_id,roster_known) VALUES('perf',$1,true)", [
        groupId,
      ]);
    await client.query(
      `INSERT INTO directory_channel_members SELECT 'perf','perf-'||(1+(g-1)%${Math.max(1, target("directory_channels"))}),CASE WHEN g<=${Math.max(1, target("directory_channels"))} THEN ${principal} ELSE 'perf-'||lpad((1+((g-1)/${Math.max(1, target("directory_channels"))})%${members})::text,5,'0')||'@example.invalid' END FROM generate_series(1,$1::bigint) g`,
      [target("directory_channel_members")],
    );
    await client.query(
      `INSERT INTO directory_group_members SELECT 'perf',($2::text[])[(1+(g-1)%${Math.max(1, target("directory_groups"))})::int],'perf-'||lpad((1+((g-1)/${Math.max(1, target("directory_groups"))})%${members})::text,5,'0')||'@example.invalid' FROM generate_series(1,$1::bigint) g`,
      [target("directory_group_members"), groupIds],
    );
    if (target("directory_meta"))
      await client.query(
        "INSERT INTO directory_meta(org_id,workspace_url,updated_at) VALUES('perf','https://fixture.example.invalid',$1)",
        [at],
      );
    if (target("directory_sync"))
      await client.query(
        "INSERT INTO directory_sync(org_id,updated_at,channel_members_synced) VALUES('perf',$1,true)",
        [at],
      );
    await seedChannelStates(client, plan);
    await client.query(
      `INSERT INTO session_spend_days(day,rows,updated_at) SELECT day,jsonb_agg(jsonb_build_object('day',day,'model',model,'scope_id',scope_id,'origin',origin,'calls',calls,'cost_usd',calls*0.01,'input',calls*1000,'output',calls*200,'cache_read',calls*100,'cache_write',0)),$1 FROM
      (SELECT floor(r.created_at::numeric/86400000)::bigint AS day,r.model,s.scope_id,s.origin,count(*) AS calls FROM session_llm_requests r JOIN sessions s ON s.id=r.session_id GROUP BY day,r.model,s.scope_id,s.origin) totals GROUP BY day`,
      [at],
    );
    await client.query("DELETE FROM session_spend_dirty");
    await client.query("INSERT INTO session_spend_dirty(session_id) SELECT id FROM sessions ORDER BY id LIMIT $1", [
      target("session_spend_dirty"),
    ]);
    await client.query("ANALYZE");
    const entryTypes = (
      await client.query("SELECT type,count(*)::bigint AS rows FROM session_entries GROUP BY type ORDER BY type")
    ).rows;
    const entryTypeMismatches = Object.entries(plan.entryTypes)
      .filter(([type, count]) => Number(entryTypes.find((row) => row.type === type)?.rows ?? 0) !== count)
      .map(([type, expected]) => ({
        type,
        expected,
        actual: Number(entryTypes.find((row) => row.type === type)?.rows ?? 0),
      }));
    const entrySearchTypes = (
      await client.query("SELECT type,count(*)::bigint AS rows FROM session_entry_search GROUP BY type ORDER BY type")
    ).rows;
    if (plan.entrySearchTargets)
      assert.deepEqual(
        Object.fromEntries(entrySearchTypes.map((row) => [String(row.type), Number(row.rows)])),
        plan.entrySearchTargets,
        "Exact searchable entry counts differ from profile",
      );
    const participantHistories = (
      await client.query(
        "SELECT principal_id,count(*)::int AS sessions FROM participants GROUP BY principal_id ORDER BY principal_id",
      )
    ).rows;
    const scopeHistories = (
      await client.query(
        "SELECT scope_id,count(*)::int AS sessions,count(*) FILTER(WHERE origin='conversation')::int AS conversations FROM sessions GROUP BY scope_id ORDER BY scope_id",
      )
    ).rows;
    const sessionDistributions = (
      await client.query(
        "SELECT surface,origin,count(*)::bigint AS sessions,sum(messages)::bigint AS messages,sum(turns)::bigint AS turns,percentile_cont(ARRAY[0.5,0.9,0.95,0.99]) WITHIN GROUP(ORDER BY messages) AS message_quantiles,max(messages) AS max_messages,percentile_cont(ARRAY[0.5,0.9,0.95,0.99]) WITHIN GROUP(ORDER BY turns) AS turn_quantiles,max(turns) AS max_turns,percentile_cont(ARRAY[0.5,0.9,0.95,0.99]) WITHIN GROUP(ORDER BY messages::numeric/greatest(1,turns)) AS messages_per_turn,max(messages::numeric/greatest(1,turns)) AS max_messages_per_turn FROM sessions GROUP BY surface,origin",
      )
    ).rows;
    const payloadDistributions = (
      await client.query(
        "SELECT type,count(*) AS sampled_rows,avg(octet_length(payload)) AS avg_payload_bytes,avg(pg_column_size(payload)) AS avg_stored_bytes,avg(length(entry_search_text(payload))) AS avg_text_chars,count(*) FILTER(WHERE COALESCE(btrim(entry_search_text(payload)),'')<>'') AS nonempty_text_rows FROM session_entries TABLESAMPLE SYSTEM (1) REPEATABLE (17) GROUP BY type",
      )
    ).rows;
    const caseVerification: Record<string, unknown> = {};
    for (const [name, fixtureCase] of Object.entries(plan.cases)) {
      const row = (
        await client.query(
          "SELECT count(*)::int AS messages,count(*) FILTER(WHERE type='user')::int AS turns,bool_or(position($2 in payload)>0) AS has_tail,bool_or(position($3 in payload)>0) AS has_earlier FROM session_entries WHERE session_id=$1",
          [
            fixtureCase.sessionId,
            fixtureCase.expectedVisibleText,
            fixtureCase.earlierVisibleText || "unseeded-earlier-sentinel",
          ],
        )
      ).rows[0];
      caseVerification[name] = row;
      if (
        row.messages !== fixtureCase.messageCount ||
        !row.has_tail ||
        (fixtureCase.earlierVisibleText && !row.has_earlier)
      )
        throw new Error(`Fixture case ${name} failed transcript verification`);
    }
    const tapeKinds = (await client.query("SELECT kind,count(*)::bigint AS rows FROM session_tape GROUP BY kind")).rows;
    assert.deepEqual(
      Object.fromEntries(tapeKinds.map((row) => [String(row.kind), Number(row.rows)])),
      Object.fromEntries(Object.entries(plan.tapeKinds).filter(([, count]) => count > 0)),
    );
    const canonicalTapeRows = Number(
      (
        await client.query(
          "SELECT count(*) AS n FROM session_tape WHERE kind='annotation' AND safe_json(payload)->>'event'='transcript_entry'",
        )
      ).rows[0].n,
    );
    assert.equal(canonicalTapeRows, plan.canonicalTapeRows);
    const readStore = createPostgresSessionStore(url);
    const transcript = createTranscriptSource(readStore);
    const readerCases = Object.entries(plan.cases).map(([name, row]) => ({
      name,
      sessionId: row.sessionId,
      principalId: row.principalId,
    }));
    const transcriptVerification = [];
    for (const row of readerCases) {
      const expected = await readStore.getEntries(row.sessionId, { limit: 50 });
      const rendered = await transcript.forRender(row.sessionId, { limit: 50 });
      assert.deepEqual(rendered.entries, expected, `forRender mismatch: ${row.name}`);
      const visible = await readStore.visibleEntries(row.sessionId, row.principalId);
      assert.ok(visible.length > 0, `Fixture viewer has no visible entries: ${row.name}`);
      const viewer = await transcript.forViewer(row.sessionId, row.principalId, { limit: 50 });
      assert.deepEqual(
        viewer.entries,
        viewer.entries.length ? visible.slice(-viewer.entries.length) : [],
        `forViewer mismatch: ${row.name}`,
      );
      assert.equal(viewer.entries.length >= Math.min(50, visible.length), true, `Incomplete forViewer: ${row.name}`);
      assert.deepEqual((await transcript.forViewer(row.sessionId, "unrelated@example.invalid")).entries, []);
      const boundary = plan.cases[row.name]?.transcriptBoundarySeq;
      let boundaryVerification;
      if (boundary !== undefined) {
        const opts = { beforeSeq: boundary + 25, limit: 50 };
        const expectedBoundary = await readStore.getEntries(row.sessionId, opts);
        assert.ok(expectedBoundary.some((entry) => entry.seq < boundary));
        assert.ok(expectedBoundary.some((entry) => entry.seq >= boundary));
        assert.deepEqual((await transcript.forRender(row.sessionId, opts)).entries, expectedBoundary);
        const viewerBoundary = await transcript.forViewer(row.sessionId, row.principalId, opts);
        assert.ok(viewerBoundary.entries.some((entry) => entry.seq < boundary));
        assert.ok(viewerBoundary.entries.some((entry) => entry.seq >= boundary));
        assert.deepEqual(
          viewerBoundary.entries,
          visible.filter((entry) => entry.seq < opts.beforeSeq).slice(-viewerBoundary.entries.length),
        );
        boundaryVerification = {
          boundarySeq: boundary,
          beforeSeq: opts.beforeSeq,
          canonicalEntries: viewerBoundary.entries.filter((entry) => entry.seq < boundary).length,
          legacyEntries: viewerBoundary.entries.filter((entry) => entry.seq >= boundary).length,
        };
      }
      transcriptVerification.push({
        name: row.name,
        sessionId: row.sessionId,
        rendered: rendered.entries.length,
        viewer: viewer.entries.length,
        visible: visible.length,
        ...(boundaryVerification ? { boundaryVerification } : {}),
      });
    }
    for (const [name, cohort] of Object.entries(plan.cohorts)) {
      const actual = Number(participantHistories.find((row) => row.principal_id === cohort.principalId)?.sessions ?? 0);
      if (actual !== cohort.sessionCount) throw new Error(`Fixture cohort ${name} failed membership verification`);
    }
    const storageBytes: Record<string, number> = {};
    const unsupportedTables: string[] = [];
    for (const [table, count] of Object.entries(plan.targets)) {
      const qualified = table === "job_common" ? "pgboss.job_common" : `public.${table}`;
      const exists = (await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [qualified])).rows[0].present;
      if (!exists) {
        if (count) unsupportedTables.push(table);
        else verifiedCounts[table] = 0;
        continue;
      }
      verifiedCounts[table] = Number((await client.query(`SELECT count(*) AS n FROM ${qualified}`)).rows[0].n);
      storageBytes[table] = Number(
        (await client.query("SELECT pg_total_relation_size($1::regclass) AS n", [qualified])).rows[0].n,
      );
    }
    const mismatches = Object.entries(plan.targets)
      .filter(([table, count]) => verifiedCounts[table] !== count)
      .map(([table, requested]) => ({ table, requested, actual: verifiedCounts[table] ?? null }));
    const inventory = plan.inventory.map((row) => {
      if (row.status !== "planned") return row;
      const actual = verifiedCounts[row.table] ?? null;
      const requested = plan.targets[row.table]!;
      return {
        ...row,
        requested,
        actual,
        status: actual === requested ? "seeded" : "unclassified",
        reason:
          actual === requested ? row.reason : "Requested fixture relation is missing or its verified count differs",
      };
    });
    const unclassifiedInventory = inventory.filter((row) => row.sourceRows > 0 && row.status === "unclassified");
    const resourceOwnership: Record<string, unknown[]> = {};
    for (const [table, owners] of Object.entries(plan.resourceOwners)) {
      const rows =
        table === "file_artifacts"
          ? (
              await client.query(
                "SELECT owner_scope_id AS scope_id,count(*)::int AS rows,count(*) FILTER(WHERE enabled)::int AS enabled_rows FROM file_artifacts GROUP BY owner_scope_id",
              )
            ).rows
          : (
              await client.query(
                "SELECT s.scope_id,s.rows,octet_length(h.body)::int AS latest_body_bytes,length(h.body)-length(replace(h.body,chr(10),'')) AS latest_newlines,(SELECT count(*)::int FROM regexp_split_to_table(h.body,chr(10)) AS line WHERE line ~ '^\\s*[-*]\\s+.*\\S\\s*$') AS latest_facts FROM (SELECT scope_id,count(*)::int AS rows FROM memory_revisions GROUP BY scope_id) s JOIN LATERAL (SELECT body FROM memory_revisions WHERE scope_id=s.scope_id ORDER BY seq DESC LIMIT 1) h ON true",
              )
            ).rows;
      assert.equal(rows.length, owners.length, `Resource owner count mismatch: ${table}`);
      for (const owner of owners) {
        const actual = rows.find((row) => row.scope_id === owner.scopeId);
        assert.equal(actual?.rows, owner.rows, `Owned row count mismatch: ${table}/${owner.scopeId}`);
        if (owner.enabledRows !== undefined) assert.equal(actual?.enabled_rows, owner.enabledRows);
        if (owner.latestBodyBytes !== undefined) assert.equal(actual?.latest_body_bytes, owner.latestBodyBytes);
        if (owner.latestFacts !== undefined) assert.equal(actual?.latest_facts, owner.latestFacts);
        if (owner.latestNewlines !== undefined) assert.equal(actual?.latest_newlines, owner.latestNewlines);
      }
      resourceOwnership[table] = rows;
    }
    const { sessions: _sessions, aggregates: _aggregates, memberships: _memberships, targets, ...summary } = plan;
    const manifest = {
      ...summary,
      databaseName,
      status: "ready",
      qualified: false,
      cardinalityMatched:
        plan.scale === 1 &&
        mismatches.length === 0 &&
        entryTypeMismatches.length === 0 &&
        unclassifiedInventory.length === 0,
      requestedCounts: targets,
      verifiedCounts,
      storageBytes,
      databaseBytes: Number((await client.query("SELECT pg_database_size(current_database()) AS n")).rows[0].n),
      unsupportedTables,
      inventory,
      unclassifiedInventory,
      mismatches,
      entryTypeMismatches,
      verifiedDistributions: {
        sessionDistributions,
        scopeHistories,
        participantHistories,
        entryTypes,
        entrySearchTypes,
        tapeKinds,
        canonicalTapeRows,
        payloadDistributions,
        resourceOwnership,
      },
      caseVerification,
      transcriptVerification,
      payloadShapeDiagnostics,
      featureFlagScopes: resourceRows(plan)
        .filter((row) => row.table === "feature_flags")
        .map((row) => row.json),
      browser: { adminPrincipalId: admin, orgScopeId: "org:perf" },
      adminPrincipalId: admin,
      orgScopeId: "org:perf",
      views: {
        scopes: { expectedText: ["QM PERF"] },
        ...Object.fromEntries(
          Object.entries(plan.adminHistoryCohorts).map(([name, cohort]) => [
            `history.${name}`,
            { expectedText: [cohort.rootCase.title] },
          ]),
        ),
        "history.next": { expectedText: ["QM performance conversation"] },
        audit: { expectedText: ["QM performance audit"] },
        errors: { expectedText: ["QM performance error"] },
        egress: { expectedText: ["fixture.example.invalid"] },
        files: { expectedText: ["QM performance file"] },
        crons: { expectedText: ["QM performance cron"] },
        skills: { expectedText: ["QM performance skill"] },
        deployments: { expectedText: ["QM performance deployment"] },
        keychain: { expectedText: ["QM performance credential"] },
        monitors: { expectedText: ["QM performance monitor"] },
        loops: { expectedText: ["QM performance loop"] },
        approvals: { expectedText: ["QM performance approval"] },
        "web.search": { expectedText: ["QM performance"] },
        "web.browse": { expectedText: ["QM performance"] },
        "slack-mirror": { expectedText: ["performance-channel"] },
      },
      limitations: [
        "File sharing grants target the synthetic organization; viewer visibility can exceed the maximum owner population. This is conservative query load with an unmeasured sharing correlation.",
        "Assistant visible complexity is conservatively reweighted to retain observed quantiles under the exact searchable fraction; serialized payload sizes may increase slightly.",
        "Targets come from input aggregate estimates, not exact production counts",
        "Synthetic storage and compression must be compared with production before environment qualification",
        "Native activity payloads use source-conditioned marginal aggregates when supplied; run source frequencies still follow the seeded session mapping, not sampled source proportions",
        "Run attachments and context-field correlations, channel vocabulary across documents and retained index churn require separate parity verification",
        "Generic activity timestamps preserve UTC days and recent-window counts; canonical session/transcript timestamps remain unchanged",
        "Files contain metadata only; opening/downloading files is unsupported",
        "Agent runs, crons, deliveries, jobs and processes are inert; workload replay is separate",
        "Any missing table or count mismatch prevents fixture qualification",
        "Qualification remains false until distribution, storage, environment and concurrent-workload parity are independently attested",
        "Marginal aggregate samples do not prove joint correlations; verify their material impact before qualification",
        "Synthetic credentials are fixture-key ciphertext and revoked grants; credential use and deployment execution are unsupported",
      ],
    };
    await client.query("UPDATE qm_performance_fixture SET status='ready',manifest=$2 WHERE fixture_id=$1", [
      plan.fixtureId,
      JSON.stringify(manifest),
    ]);
    return manifest;
  } finally {
    await client.end();
  }
}
