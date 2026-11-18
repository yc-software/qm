import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const DOCUMENT_BINDING_KEYS_MIGRATION: PgMigrationDefinition = {
  id: "sessions/store/0066-document-binding-keys",
  statements: [
    `DELETE FROM document_conversations a
      WHERE a.json->>'kind' = 'session'
        AND NOT EXISTS (
          SELECT 1 FROM sessions s WHERE s.tenant_id = a.tenant_id
            AND a.id = encode(sha256(convert_to('["session",' || to_json(s.id)::text || ']', 'UTF8')), 'hex')
        )`,
    `WITH known AS (
       SELECT a.tenant_id, a.json - 'bindingKey' AS association, b.id AS binding_key
         FROM document_conversations a
         JOIN sessions s ON s.tenant_id = a.tenant_id
          AND a.id = encode(sha256(convert_to('["session",' || to_json(s.id)::text || ']', 'UTF8')), 'hex')
         JOIN document_conversations b ON b.tenant_id = a.tenant_id
          AND b.json->>'kind' = 'conversation'
          AND b.json->>'scopeId' = a.json->>'scopeId'
          AND b.json->>'threadRef' = s.thread_ref
        WHERE a.json->>'kind' = 'session'
       UNION
       SELECT a.tenant_id, a.json - 'bindingKey', b.id
         FROM document_conversations a
         JOIN document_conversations b ON b.tenant_id = a.tenant_id
          AND b.id = a.json->>'bindingKey' AND b.json->>'kind' = 'conversation'
          AND b.json->>'scopeId' = a.json->>'scopeId'
        WHERE a.json->>'kind' = 'session'
     ), unique_bindings AS (
       SELECT tenant_id, association, min(binding_key) AS binding_key
         FROM known GROUP BY tenant_id, association HAVING count(DISTINCT binding_key) = 1
     )
     UPDATE document_conversations a SET json = jsonb_set(a.json, '{bindingKey}', to_jsonb(b.binding_key))
       FROM unique_bindings b
      WHERE a.tenant_id = b.tenant_id AND a.json->>'kind' = 'session'
        AND a.json - 'bindingKey' = b.association AND a.json->>'bindingKey' IS NULL`,
    `ALTER TABLE document_conversations ADD CONSTRAINT document_conversations_session_binding_key
       CHECK (json->>'kind' IS DISTINCT FROM 'session' OR
         COALESCE(jsonb_typeof(json->'bindingKey') = 'string' AND length(json->>'bindingKey') = 64, false))`,
    `UPDATE durable_map_versions SET v = v + 1 WHERE tbl = 'document_conversations'`,
  ],
};
