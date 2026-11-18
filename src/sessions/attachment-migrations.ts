import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

const trimCharacters =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export const ATTACHMENT_STAGING_MIGRATION: PgMigrationDefinition = {
  id: "sessions/store/0067-attachment-staging",
  statements: [
    `WITH candidates AS (
       SELECT i.tenant_id,i.session_id,i.turn_id
         FROM items i JOIN runs r ON r.tenant_id=i.tenant_id AND r.id=i.turn_id::text
         JOIN sessions s ON s.tenant_id=i.tenant_id AND s.id=i.session_id
        WHERE r.status IN ('pending','running') AND r.session_id IN (s.id,s.thread_ref)
          AND i.kind='ToolResult' AND i.tool='attach' AND i.body->>'ok'='true' AND i.is_error IS NOT TRUE
          AND NOT EXISTS (SELECT 1 FROM items d WHERE d.tenant_id=i.tenant_id AND d.session_id=i.session_id
            AND d.turn_id=i.turn_id AND d.kind='AgentMessage' AND d.variant='files_delivered')
        GROUP BY i.tenant_id,i.session_id,i.turn_id
       HAVING bool_and(jsonb_typeof(i.body->'stagedFiles') IS DISTINCT FROM 'array')
     ), results AS (
       SELECT i.tenant_id,i.session_id,i.turn_id,i.seq,c.seq AS call_seq,c.body AS args,
              CASE WHEN jsonb_typeof(i.body->'files')='array' THEN i.body->'files' ELSE '[]'::jsonb END AS files,
              dense_rank() OVER (PARTITION BY i.tenant_id,i.session_id,i.turn_id ORDER BY i.seq) AS revision
         FROM candidates t JOIN items i USING(tenant_id,session_id,turn_id)
         LEFT JOIN items c ON c.tenant_id=i.tenant_id AND c.session_id=i.session_id AND c.turn_id=i.turn_id
          AND c.kind='ToolCall' AND c.tool='attach' AND md5(c.call_id)=md5(i.call_id) AND c.call_id=i.call_id AND c.seq<i.seq
        WHERE i.kind='ToolResult' AND i.tool='attach' AND i.body->>'ok'='true' AND i.is_error IS NOT TRUE
     ), keys AS (
       SELECT r.tenant_id,r.session_id,r.turn_id,r.seq,
              CASE WHEN jsonb_typeof(a.value)='string' THEN
                jsonb_build_array('path',r.args->'sandbox_id',btrim(a.value #>> '{}','${trimCharacters}'))
              WHEN jsonb_typeof(a.value)='object' AND jsonb_typeof(a.value->'file_id')='string' THEN
                jsonb_build_array('file',btrim(a.value->>'file_id','${trimCharacters}')) END AS key,
              a.ordinality
         FROM results r CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(r.args->'files')='array' THEN r.args->'files' ELSE '[]'::jsonb END
         ) WITH ORDINALITY a
     ), deduped AS (
       SELECT tenant_id,session_id,turn_id,seq,key,min(ordinality) AS ordinal
         FROM keys WHERE key IS NOT NULL GROUP BY tenant_id,session_id,turn_id,seq,key
     ), positioned AS (
       SELECT *,row_number() OVER (PARTITION BY tenant_id,session_id,turn_id,seq ORDER BY ordinal) AS position
         FROM deduped
     ), entries AS (
       SELECT k.*,r.call_seq,r.revision,r.files->(k.position::int-1) AS file
         FROM positioned k JOIN results r USING(tenant_id,session_id,turn_id,seq)
     ), valid_results AS (
       SELECT r.tenant_id,r.session_id,r.turn_id,r.seq,
              count(e.key)=jsonb_array_length(r.files) AND count(e.key)>0 AND
              bool_and(COALESCE(jsonb_typeof(e.file)='object' AND jsonb_typeof(e.file->'artifactId')='string'
                AND length(e.file->>'artifactId')>0 AND jsonb_typeof(e.file->'name')='string'
                AND jsonb_typeof(e.file->'mimetype')='string' AND jsonb_typeof(e.file->'sizeBytes')='number',false)) AS valid
         FROM results r LEFT JOIN entries e USING(tenant_id,session_id,turn_id,seq)
        GROUP BY r.tenant_id,r.session_id,r.turn_id,r.seq,r.files
     ), valid_turns AS (
       SELECT v.tenant_id,v.session_id,v.turn_id FROM valid_results v
        GROUP BY v.tenant_id,v.session_id,v.turn_id HAVING bool_and(v.valid) AND NOT EXISTS (
          SELECT 1 FROM results a JOIN results b USING(tenant_id,session_id,turn_id)
           WHERE a.tenant_id=v.tenant_id AND a.session_id=v.session_id AND a.turn_id=v.turn_id
             AND a.call_seq<b.call_seq AND b.call_seq<a.seq
        )
     ), ordered AS (
       SELECT e.*,first_value(seq) OVER w AS first_seq,first_value(ordinal) OVER w AS first_ordinal
         FROM entries e JOIN valid_turns v USING(tenant_id,session_id,turn_id)
       WINDOW w AS (PARTITION BY tenant_id,session_id,turn_id,key ORDER BY seq,ordinal)
     ), snapshots AS (
       SELECT *,jsonb_object_agg(key::text,file || jsonb_build_object('key',key,'created',false,
                    'position',jsonb_build_array(first_seq,first_ordinal))) OVER (
                PARTITION BY tenant_id,session_id,turn_id ORDER BY seq,ordinal ROWS UNBOUNDED PRECEDING
              ) AS staged,
              row_number() OVER (PARTITION BY tenant_id,session_id,turn_id,seq ORDER BY ordinal DESC) AS last_file
         FROM ordered
     ) UPDATE items i SET body=i.body || jsonb_build_object('stagedRevision',s.revision,'stagedFiles',(
          SELECT jsonb_agg(value-'position' ORDER BY (value->'position'->>0)::bigint,(value->'position'->>1)::bigint)
            FROM jsonb_each(s.staged)
        )) FROM snapshots s
        WHERE s.last_file=1 AND i.tenant_id=s.tenant_id AND i.session_id=s.session_id AND i.seq=s.seq`,
    `UPDATE items i SET body=i.body || '{"stagingRecoveryError":true}'::jsonb
       FROM runs r,sessions s
      WHERE r.tenant_id=i.tenant_id AND r.id=i.turn_id::text AND r.status IN ('pending','running')
        AND s.tenant_id=i.tenant_id AND s.id=i.session_id AND r.session_id IN (s.id,s.thread_ref)
        AND i.kind='ToolResult' AND i.tool='attach' AND i.body->>'ok'='true' AND i.is_error IS NOT TRUE
        AND jsonb_typeof(i.body->'stagedFiles') IS DISTINCT FROM 'array'
        AND NOT EXISTS (SELECT 1 FROM items d WHERE d.tenant_id=i.tenant_id AND d.session_id=i.session_id
          AND d.turn_id=i.turn_id AND d.kind='AgentMessage' AND d.variant='files_delivered')`,
  ],
};

export const ATTACHMENT_RECEIPTS_MIGRATION: PgMigrationDefinition = {
  id: "sessions/store/0068-attachment-receipts",
  statements: [
    `WITH receipts AS (
       SELECT i.tenant_id,i.session_id,i.turn_id,i.seq,
              row_number() OVER (PARTITION BY i.tenant_id,i.session_id,i.turn_id ORDER BY i.seq) +
              COALESCE((SELECT max((d.body->>'stagedRevision')::bigint) FROM items d
                WHERE d.tenant_id=i.tenant_id AND d.session_id=i.session_id AND d.turn_id=i.turn_id
                  AND jsonb_typeof(d.body->'stagedRevision')='number'),0) AS revision
         FROM items i JOIN runs r ON r.tenant_id=i.tenant_id AND r.id=i.turn_id::text
         JOIN sessions s ON s.tenant_id=i.tenant_id AND s.id=i.session_id
        WHERE r.status IN ('pending','running') AND r.session_id IN (s.id,s.thread_ref)
          AND i.kind='AgentMessage' AND i.variant='files_delivered'
          AND jsonb_typeof(i.body->'files')='array'
          AND jsonb_typeof(i.body->'stagedFiles') IS DISTINCT FROM 'array'
     ) UPDATE items i SET body=i.body || jsonb_build_object('stagedRevision',r.revision,'stagedFiles',COALESCE((
         SELECT jsonb_agg(f.file || jsonb_build_object('key',jsonb_build_array('file',f.file->>'artifactId'),'created',false)
                         ORDER BY f.seq,f.ordinality)
           FROM (
             SELECT DISTINCT ON (a.value->>'artifactId') a.value AS file,d.seq,a.ordinality
               FROM items d CROSS JOIN LATERAL jsonb_array_elements(d.body->'files') WITH ORDINALITY a
              WHERE d.tenant_id=r.tenant_id AND d.session_id=r.session_id AND d.turn_id=r.turn_id AND d.seq<=r.seq
                AND d.kind='AgentMessage' AND d.variant='files_delivered'
              ORDER BY a.value->>'artifactId',d.seq,a.ordinality
           ) f
       ),'[]'::jsonb)) FROM receipts r
      WHERE i.tenant_id=r.tenant_id AND i.session_id=r.session_id AND i.seq=r.seq
        AND jsonb_typeof(i.body->'stagedFiles') IS DISTINCT FROM 'array'`,
  ],
};
