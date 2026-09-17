export const transcriptPayloadMigration = {
  id: "sessions/store/0017-transcript-payload-json",
  statements: [
    `SET LOCAL lock_timeout = '3s'`,
    `CREATE OR REPLACE VIEW session_transcript_entries AS
     SELECT DISTINCT ON (session_id, entry_seq)
       session_id, entry_seq AS seq,
       (safe_json(payload)->'entry'->>'parentSeq')::int AS parent_seq,
       safe_json(payload)->'entry'->>'type' AS type,
       COALESCE(safe_json(payload)->'entry'->>'payloadJson', (safe_json(payload)->'entry'->'payload')::text) AS payload,
       scope_label,
       (safe_json(payload)->'entry'->>'at')::bigint AS created_at,
       COALESCE(safe_json(payload)->'entry'->'attributes', safe_json(payload)->'entry'->'payload')::jsonb AS attributes,
       safe_json(payload)->'entry'->'payloadJson' IS NOT NULL AS encoded_payload
     FROM session_tape t
     WHERE kind='annotation' AND safe_json(payload)->>'event'='transcript_entry'
     ORDER BY t.session_id, t.entry_seq DESC, t.seq DESC`,
  ],
};
