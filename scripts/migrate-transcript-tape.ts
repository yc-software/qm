import { parseArgs } from "node:util";
import pg from "pg";
import { migrateTranscriptPage } from "./lib/transcript-tape-migration.ts";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    after: { type: "string", default: "" },
    "through-created-at": { type: "string", default: String(Date.now()) },
    "page-size": { type: "string", default: "250" },
    "max-sessions": { type: "string" },
  },
});
const pageSize = Number(values["page-size"]);
const through = Number(values["through-created-at"]);
const maxSessions = values["max-sessions"] === undefined ? Infinity : Number(values["max-sessions"]);
if (
  !Number.isInteger(pageSize) ||
  pageSize < 1 ||
  pageSize > 1000 ||
  !Number.isSafeInteger(through) ||
  through < 0 ||
  (maxSessions !== Infinity && (!Number.isInteger(maxSessions) || maxSessions < 1))
)
  throw new Error("Invalid migration bounds");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  application_name: "qm-transcript-tape-migration",
  options: "-c statement_timeout=30000 -c lock_timeout=1000",
});
await client.connect();
let cursor = values.after!;
const summary = { sessions: 0, entries: 0, changed: 0, busy: 0 };
const report = (event: string) =>
  console.log(JSON.stringify({ event, apply: values.apply, cursor, throughCreatedAt: through, ...summary }));
report("start");
try {
  if (
    !(await client.query("SELECT 1 FROM qm_schema_migrations WHERE id='sessions/store/0017-transcript-payload-json'"))
      .rowCount
  )
    throw new Error("Prepare the transcript payload format before migrating histories");
  if (
    values.apply &&
    (await client.query("SELECT 1 FROM qm_schema_migrations WHERE id='sessions/store/0018-transcript-authority'"))
      .rowCount
  )
    throw new Error("Transcript authority is already established; legacy histories can no longer be applied");
  for (;;) {
    const batch = (
      await client.query("SELECT id FROM sessions WHERE id>$1 AND created_at<=$2 ORDER BY id LIMIT $3", [
        cursor,
        through,
        Math.min(100, maxSessions - summary.sessions),
      ])
    ).rows;
    if (!batch.length) break;
    for (const { id } of batch) {
      let afterSeq = -1;
      for (;;) {
        const page = await migrateTranscriptPage(client, id, { afterSeq, limit: pageSize, apply: values.apply! });
        if (page.busy) {
          summary.busy++;
          console.log(JSON.stringify({ event: "busy", sessionId: id, afterSeq }));
          break;
        }
        summary.entries += page.scanned;
        summary.changed += page.changed;
        afterSeq = page.afterSeq;
        if (page.scanned < pageSize) break;
      }
      summary.sessions++;
      cursor = id;
    }
    report("progress");
    if (summary.sessions >= maxSessions) break;
  }
  const partial = summary.sessions >= maxSessions || values.after !== "";
  report(partial ? "partial" : "complete");
  process.exitCode = partial ? 2 : 0;
  if (summary.busy || (!values.apply && summary.changed)) process.exitCode = 1;
} finally {
  await client.end();
}
