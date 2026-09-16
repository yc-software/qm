import type { Client } from "pg";
import { rowToEntry } from "../../src/sessions/postgres-session-store.ts";
import { tapeTranscriptEntryRecord } from "../../src/sessions/session-store.ts";
import { canonicalJson } from "../../src/util/objects.ts";
import { jsonbSafeStringify } from "../../src/util/text.ts";

export async function migrateTranscriptPage(
  client: Client,
  sessionId: string,
  options: { afterSeq: number; limit: number; apply: boolean },
): Promise<{ busy: true } | { busy: false; scanned: number; changed: number; afterSeq: number }> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)
    throw new Error("Invalid page limit");
  await client.query(options.apply ? "BEGIN" : "BEGIN READ ONLY");
  try {
    const locked = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS held", [sessionId]);
    const lease = await client.query("SELECT 1 FROM session_leases WHERE session_id=$1 AND expires_at>$2", [
      sessionId,
      Date.now(),
    ]);
    if (!locked.rows[0]?.held || lease.rows.length) {
      await client.query("ROLLBACK");
      return { busy: true };
    }
    const source = (
      await client.query("SELECT * FROM session_entries WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", [
        sessionId,
        options.afterSeq,
        options.limit,
      ])
    ).rows.map(rowToEntry);
    if (source.some((entry, index) => entry.seq !== options.afterSeq + index + 1))
      throw new Error("Legacy history has a sequence gap");
    if (source.length < options.limit) {
      const tail = source.at(-1)?.seq ?? options.afterSeq;
      const extra = await client.query(
        "SELECT 1 FROM session_transcript_entries WHERE session_id=$1 AND (seq>$2 OR seq IS NULL OR seq<0) LIMIT 1",
        [sessionId, tail],
      );
      if (extra.rows.length) throw new Error("Canonical history has an extra entry");
    }
    if (!source.length) {
      await client.query("COMMIT");
      return { busy: false, scanned: 0, changed: 0, afterSeq: options.afterSeq };
    }
    const afterSeq = source.at(-1)!.seq;
    const readCanonical = async () =>
      (
        await client.query(
          "SELECT * FROM session_transcript_entries WHERE session_id=$1 AND seq>$2 AND seq<=$3 ORDER BY seq",
          [sessionId, options.afterSeq, afterSeq],
        )
      ).rows.map(rowToEntry);
    const before = await readCanonical();
    const bySeq = new Map(before.map((entry) => [entry.seq, entry]));
    const sourceSeqs = new Set(source.map((entry) => entry.seq));
    if (before.some((entry) => !sourceSeqs.has(entry.seq))) throw new Error("Canonical history has an extra entry");
    const missing = source.filter((entry) => canonicalJson(entry) !== canonicalJson(bySeq.get(entry.seq)));
    if (options.apply && missing.length) {
      const next = (
        await client.query("SELECT COALESCE(MAX(seq),-1)+1 AS seq FROM session_tape WHERE session_id=$1", [sessionId])
      ).rows[0].seq;
      const records = missing.map((entry, ordinal) => ({
        ordinal,
        payload: jsonbSafeStringify(tapeTranscriptEntryRecord(entry).payload),
        scope_label: entry.scopeLabel,
        entry_seq: entry.seq,
      }));
      await client.query(
        `INSERT INTO session_tape(session_id,seq,kind,payload,scope_label,entry_seq,created_at)
         SELECT $1,$2::int+r.ordinal,'annotation',r.payload,r.scope_label,r.entry_seq,$4
         FROM jsonb_to_recordset($3::jsonb) AS r(ordinal int,payload text,scope_label text,entry_seq int)`,
        [sessionId, Number(next), jsonbSafeStringify(records), Date.now()],
      );
      if (canonicalJson(await readCanonical()) !== canonicalJson(source))
        throw new Error("Canonical transcript verification failed");
    }
    await client.query("COMMIT");
    return { busy: false, scanned: source.length, changed: missing.length, afterSeq };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
