import { createHash } from "node:crypto";
import type { OrchestratorInput } from "../../src/core/orchestrator/types.ts";
import type { TurnResult } from "../../src/types.ts";
import { PAYLOAD_BUCKETS, payloadLengths, payloadText, type SeedPlan } from "./seed.ts";

type Row = Record<string, unknown>;

export function activityTimestampSql(anchor: number, days: number, ordinal = "g"): string {
  if (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(days) || days < 1 || !/^[a-z_][a-z0-9_.]*$/.test(ordinal))
    throw new Error("Invalid fixture timestamp inputs");
  const windows = [3_600_000, 86_400_000, 604_800_000];
  const lower = windows.map((width) => `CASE WHEN base>=${anchor - width} THEN ${anchor - width} ELSE 0 END`);
  const upper = windows.map(
    (width) => `CASE WHEN base<${anchor - width} THEN ${anchor - width - 1} ELSE ${anchor} END`,
  );
  return `(SELECT lo+((${ordinal}::bigint/${days})*7919)%(hi-lo+1) FROM (VALUES(${anchor}-(${ordinal}::bigint%${days})*86400000)) date(base) CROSS JOIN LATERAL (SELECT greatest((base/86400000)*86400000,${lower.join(",")}) AS lo,least((base/86400000)*86400000+86399999,${anchor},${upper.join(",")}) AS hi) bounds)`;
}

function curve(row: Row, prefix: string, minimum = 0): number[] {
  const quantiles = row[`${prefix}_quantiles`];
  const average = Number(row[`${prefix}_mean`]);
  if (
    !Array.isArray(quantiles) ||
    quantiles.length !== 4 ||
    !quantiles.every((n) => Number.isFinite(n) && n >= 0) ||
    !Number.isFinite(average) ||
    average < 0
  )
    throw new Error(`Invalid activity payload calibration: ${prefix}`);
  if (quantiles.every((n) => n === average) && Number(row[`${prefix}_max`] ?? average) === average)
    return Array<number>(PAYLOAD_BUCKETS).fill(Math.max(minimum, Math.round(average)));
  return payloadLengths(
    { values: row[`${prefix}_quantiles`], max_bytes: row[`${prefix}_max`] },
    "values",
    Number(row[`${prefix}_mean`]),
    minimum,
  );
}

interface RunPayload {
  source: string;
  bucket: number;
  request: Partial<OrchestratorInput>;
  result: Omit<TurnResult, "sessionId">;
  idempotencyBytes: number;
}

export function runPayloads(plan: Pick<SeedPlan, "aggregates" | "anchorTime">): RunPayload[] {
  const widths = plan.aggregates.runs_native_payload_widths;
  if (!widths) return [];
  const fields = plan.aggregates.runs_native_field_widths;
  const statuses = plan.aggregates.runs_native_result_shape;
  if (!fields || !statuses) throw new Error("Run payload calibration requires native field and result aggregates");
  const output: RunPayload[] = [];
  for (const source of new Set(widths.filter((r) => r.source !== "all").map((r) => String(r.source)))) {
    const measured = widths.find((r) => r.source === source)!;
    const ratio = Math.min(1, Number(measured.request_stored_mean) / Number(measured.request_bytes_mean));
    const names = [
      "request.text",
      "request.conversationHeader",
      "request.detectContext",
      "request.detectOpener",
      "request.displayText",
      "request.gatewayContext",
      "request.priorTurns",
      "request.overheard",
      "request.inboundNotes",
      "result.reply",
      "result.reason",
    ];
    const sourceFields = fields.filter(
      (r) => r.source === source && names.includes(String(r.field)) && Number(r.present_rows) > 0,
    );
    const curves = new Map(
      sourceFields.map((r) => [
        String(r.field),
        {
          row: r,
          bytes: curve(r, r.text_bytes_mean === null ? "serialized_bytes" : "text_bytes"),
          items: r.array_items_mean === null ? undefined : curve(r, "array_items"),
        },
      ]),
    );
    const states = statuses.filter((r) => r.source === source);
    const keyCurves = new Map(
      states
        .filter((state) => Number(state.idempotency_rows) > 0)
        .map((state) => [
          state,
          curve(
            {
              key_mean: state.idempotency_bytes_mean,
              key_quantiles: state.idempotency_bytes,
              key_max: (state.idempotency_bytes as number[]).at(-1),
            },
            "key",
            16,
          ),
        ]),
    );
    const total = states.reduce((sum, r) => sum + Number(r.sampled_rows), 0);
    if (!total) throw new Error("Run source has no measured terminal result shape");
    for (let bucket = 0; bucket < PAYLOAD_BUCKETS; bucket++) {
      const seed = `${source}:${bucket}`;
      const rank = (bucket * 761) % PAYLOAD_BUCKETS;
      const field = (name: string, requiredRank?: number) => {
        const data = curves.get(name);
        if (!data) {
          if (requiredRank !== undefined) throw new Error(`Missing required activity field: ${source} ${name}`);
          return undefined;
        }
        const present = Math.round((PAYLOAD_BUCKETS * Number(data.row.present_rows)) / Number(data.row.sampled_rows));
        const fieldRank =
          requiredRank !== undefined
            ? requiredRank
            : (rank + createHash("sha256").update(name).digest().readUInt16BE(0)) % PAYLOAD_BUCKETS;
        if (requiredRank === undefined && fieldRank >= present) return undefined;
        const index =
          requiredRank !== undefined
            ? requiredRank
            : Math.min(PAYLOAD_BUCKETS - 1, Math.floor((fieldRank * PAYLOAD_BUCKETS) / present));
        return { bytes: data.bytes[index]!, items: Math.max(1, data.items?.[index] ?? 1) };
      };
      const text = (name: string, requiredRank?: number) => {
        const value = field(name, requiredRank);
        return value ? payloadText(`${seed}:${name}`, value.bytes, ratio) : undefined;
      };
      const request: Partial<OrchestratorInput> = {
        text: text("request.text", rank)!,
      };
      for (const key of ["conversationHeader", "detectContext", "detectOpener", "displayText"] as const) {
        const value = text(`request.${key}`);
        if (value !== undefined) request[key] = value;
      }
      const gateway = field("request.gatewayContext");
      if (gateway)
        request.gatewayContext = {
          instructions: payloadText(`${seed}:gateway`, Math.max(0, gateway.bytes - 19), ratio),
        };
      for (const key of ["priorTurns", "overheard", "inboundNotes"] as const) {
        const value = field(`request.${key}`);
        if (!value) continue;
        const items = Array.from({ length: value.items }, (_, i) => {
          if (key === "inboundNotes") return "";
          if (key === "priorTurns") return { role: i % 2 ? ("assistant" as const) : ("user" as const), text: "" };
          return { ts: `${Math.floor(plan.anchorTime / 1000) - i}.000000`, role: "user" as const, text: "" };
        });
        const bytes = Math.max(0, value.bytes - Buffer.byteLength(JSON.stringify(items)));
        const body = payloadText(`${seed}:${key}`, bytes, ratio);
        const filled = items.map((item, i) => {
          const part = body.slice(Math.floor((i * bytes) / items.length), Math.floor(((i + 1) * bytes) / items.length));
          return typeof item === "string" ? part : { ...item, text: part };
        });
        if (key === "inboundNotes") request.inboundNotes = filled as string[];
        else if (key === "priorTurns") request.priorTurns = filled as NonNullable<OrchestratorInput["priorTurns"]>;
        else request.overheard = filled as NonNullable<OrchestratorInput["overheard"]>;
      }
      let selected = states.at(-1)!;
      let cumulative = 0;
      let lower = 0;
      let upper = PAYLOAD_BUCKETS;
      for (const state of states) {
        lower = Math.ceil((cumulative * PAYLOAD_BUCKETS) / total);
        cumulative += Number(state.sampled_rows);
        upper = Math.ceil((cumulative * PAYLOAD_BUCKETS) / total);
        if (rank < upper) {
          selected = state;
          break;
        }
      }
      const status = String(selected.result_status);
      if (!["ok", "silent", "failed", "refused"].includes(status))
        throw new Error("Unsupported measured terminal result status");
      const result: RunPayload["result"] = { status: status as TurnResult["status"] };
      const conditionalRank = Math.min(
        PAYLOAD_BUCKETS - 1,
        Math.round(((rank - lower) * (PAYLOAD_BUCKETS - 1)) / Math.max(1, upper - lower - 1)),
      );
      if (status === "ok") result.reply = text("result.reply", conditionalRank)!;
      if (status === "refused" || status === "failed") result.reason = text("result.reason", conditionalRank)!;
      const idempotencyFraction = Number(selected.idempotency_rows) / Number(selected.sampled_rows);
      const keyRank = (rank - lower + Math.floor((upper - lower) / 2)) % (upper - lower);
      const keyCount = Math.round((upper - lower) * idempotencyFraction);
      const idempotencyBytes =
        keyRank < keyCount
          ? keyCurves.get(selected)![Math.round((keyRank * (PAYLOAD_BUCKETS - 1)) / Math.max(1, keyCount - 1))]!
          : 0;
      output.push({ source, bucket, request, result, idempotencyBytes });
    }
  }
  return output;
}

export function syntheticWords(seed: string, bytes: number, lexemes: number, wordBytes = 8, poolSize = 16_384): string {
  if (
    ![bytes, lexemes, wordBytes, poolSize].every(Number.isSafeInteger) ||
    bytes < 0 ||
    bytes > 10_000_000 ||
    lexemes < 0 ||
    wordBytes < 2 ||
    wordBytes > 1024 ||
    poolSize < 1 ||
    poolSize > 1_000_000
  )
    throw new Error("Invalid synthetic word shape");
  const count = Math.min(lexemes, Math.floor((bytes + 1) / 3), poolSize);
  if (!count) return " ".repeat(bytes);
  const width = Math.max(2, Math.min(wordBytes, Math.floor((bytes + 1) / count) - 1));
  const alphabet = "bcdfghjklmnpqrstvwxz";
  const pool = Math.min(poolSize, alphabet.length ** width);
  const codeWidth = Math.max(1, Math.ceil(Math.log(pool) / Math.log(alphabet.length)));
  const offset = createHash("sha256").update(seed).digest().readUInt32BE(0) % pool;
  const words = Array.from({ length: Math.min(count, pool) }, (_, i) => {
    let n = (offset + i) % pool;
    let code = "";
    for (let j = 0; j < codeWidth; j++) {
      code += alphabet[n % alphabet.length];
      n = Math.floor(n / alphabet.length);
    }
    let word = "";
    for (let block = 0; word.length < width - codeWidth; block++) {
      const digest = createHash("sha256").update(`qm-perf-word:${code}:${block}`).digest();
      word += Array.from(digest, (n) => alphabet[n % alphabet.length]).join("");
    }
    return word.slice(0, width - codeWidth) + code;
  });
  let body = words.join(" ");
  for (let i = 0; body.length + width + 1 <= bytes; i++) body += ` ${words[i % words.length]}`;
  return body.padEnd(bytes, " ");
}

interface ChannelPayload {
  bucket: number;
  text: string;
  threaded: boolean;
  bot: boolean;
  self: boolean;
  deleted: boolean;
  edited: boolean;
  mentions: boolean;
  handled: boolean;
}

export function channelPayloads(plan: Pick<SeedPlan, "aggregates" | "anchorTime">): ChannelPayload[] {
  const measured = plan.aggregates.channel_native_payload_widths?.[0];
  if (!measured) return [];
  const lengths = curve(measured, "text_bytes");
  const lexemes = curve(measured, "lexemes");
  return lengths.map((length, bucket) => {
    const text = syntheticWords(`channel:${bucket}`, length, lexemes[bucket]!);
    const flag = (field: string, offset: number) =>
      (bucket * 761 + offset) % PAYLOAD_BUCKETS <
      Math.round((PAYLOAD_BUCKETS * Number(measured[field])) / Number(measured.sampled_rows));
    return {
      bucket,
      text,
      threaded: flag("thread_rows", 0),
      bot: flag("bot_rows", 113),
      self: flag("self_rows", 113),
      deleted: flag("deleted_rows", 307),
      edited: flag("edited_rows", 401),
      mentions: flag("mentions_rows", 509),
      handled: flag("handled_rows", 601),
    };
  });
}

export async function prepareActivityPayloads(client: import("pg").Client, plan: SeedPlan): Promise<void> {
  await client.query(
    "CREATE TEMP TABLE perf_run_payloads(source text,bucket int,request jsonb,result jsonb,key_bytes int,PRIMARY KEY(source,bucket))",
  );
  const runs = runPayloads(plan);
  for (let first = 0; first < runs.length; first += 128)
    await client.query(
      'INSERT INTO perf_run_payloads SELECT source,bucket,request,result,"idempotencyBytes" FROM jsonb_to_recordset($1::jsonb) AS r(source text,bucket int,request jsonb,result jsonb,"idempotencyBytes" int)',
      [JSON.stringify(runs.slice(first, first + 128))],
    );
  await client.query(
    "CREATE TEMP TABLE perf_channel_payloads(bucket int PRIMARY KEY,text text,threaded boolean,bot boolean,self boolean,deleted boolean,edited boolean,mentions boolean,handled boolean)",
  );
  const channels = channelPayloads(plan);
  await client.query(
    "INSERT INTO perf_channel_payloads SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(bucket int,text text,threaded boolean,bot boolean,self boolean,deleted boolean,edited boolean,mentions boolean,handled boolean)",
    [JSON.stringify(channels)],
  );
}

export function activityRunSql(plan: SeedPlan): string {
  const principal = `'${plan.cohorts.max!.principalId.replaceAll("'", "''")}'`;
  const at = activityTimestampSql(plan.anchorTime, Math.max(1, plan.targets.session_spend_days || 108));
  return `SELECT md5('qm-perf-run-'||g)::uuid::text AS id,s.thread AS session_id,'done' AS status,
    (jsonb_build_object('text','QM performance completed fixture')||COALESCE(p.request,'{}'::jsonb)||jsonb_strip_nulls(jsonb_build_object('surface',s.surface,
      'actor',jsonb_build_object('id',${principal},'type','internal'),
      'conversation',jsonb_build_object('kind',CASE WHEN s.scope LIKE 'channel:%' THEN 'channel' WHEN s.scope LIKE 'group:%' THEN 'group' ELSE 'dm' END,'threadRef',s.thread,'audience',jsonb_build_array(jsonb_build_object('id',${principal},'type','internal'))),
      'origin',jsonb_build_object('kind',CASE WHEN s.origin='conversation' THEN 'human' ELSE 'automation' END))))::text AS request,
    (COALESCE(p.result,'{"status":"silent"}'::jsonb)||jsonb_build_object('sessionId',s.id))::text AS result,
    CASE WHEN p.key_bytes>0 THEN left(g::text||':'||repeat(md5('qm-perf-run-key-'||g),1+p.key_bytes/32),p.key_bytes) END AS idempotency_key,
    1 AS attempts,a.at AS created_at,a.at+10 AS started_at,
    a.at+1200 AS finished_at,a.at+1200 AS returned_at
    FROM generate_series($1::bigint,$2::bigint) g JOIN perf_sessions s ON s.n=((g-1)%${plan.sessions.length})+1
    LEFT JOIN perf_run_payloads p ON p.source=CASE WHEN EXISTS(SELECT 1 FROM perf_run_payloads p2 WHERE p2.source=s.surface) THEN s.surface ELSE 'other_or_null' END AND p.bucket=g%${PAYLOAD_BUCKETS}
    CROSS JOIN LATERAL(SELECT ${at} AS at) a`;
}

export function activityChannelSql(plan: SeedPlan): string {
  const principal = `'${plan.cohorts.max!.principalId.replaceAll("'", "''")}'`;
  const containers = Math.max(1, plan.scopes.filter((s) => s.startsWith("channel:")).length);
  const at = activityTimestampSql(plan.anchorTime, Math.max(1, plan.targets.session_spend_days || 108));
  return `SELECT 'perf' AS org_id,'perf-'||(1+g%${containers}) AS container,g::text AS ts,${principal} AS author_id,'Performance user' AS author_name,
    COALESCE(p.text,'QM performance Slack fixture '||g) AS text, a.at AS created_at,COALESCE(p.handled,true) AS handled,
    CASE WHEN p.threaded AND g>${containers} THEN (((g-1)%${containers})+1)::text END AS sub,
    COALESCE(p.bot,false) AS bot,COALESCE(p.self,false) AS self,COALESCE(p.deleted,false) AS deleted,
    CASE WHEN p.edited THEN least(${plan.anchorTime},a.at+1000) END AS edited_at,
    CASE WHEN p.deleted THEN least(${plan.anchorTime},a.at+2000) END AS deleted_at,
    CASE WHEN p.mentions THEN jsonb_build_object(${principal},'Performance user') END AS mentions
    FROM generate_series($1::bigint,$2::bigint) g LEFT JOIN perf_channel_payloads p ON p.bucket=g%${PAYLOAD_BUCKETS}
    CROSS JOIN LATERAL(SELECT ${at} AS at) a`;
}
