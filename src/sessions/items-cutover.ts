import { msOf, SEARCHABLE_ITEM, searchTypeExpr, USER_KINDS } from "./items.ts";
import { ITEM_INDEXES, itemIndexSql } from "./items-schema.ts";

export const ITEMS_CUTOVER_SQL: readonly string[] = [
  `SET LOCAL lock_timeout = '60s'`,
  `DO $index_guard$
   DECLARE unready text;
   BEGIN
     SELECT string_agg(name, ', ') INTO unready
       FROM unnest(ARRAY[${ITEM_INDEXES.map((index) => `'${index.name}'`).join(", ")}]) AS name
      WHERE NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                         WHERE c.relname = name AND c.relnamespace = current_schema()::regnamespace AND i.indisvalid);
     IF unready IS NOT NULL AND EXISTS (SELECT 1 FROM items) THEN
       RAISE EXCEPTION 'items cutover: build the items indexes with scripts/ops/items-copy.ts first; missing or invalid: %', unready;
     END IF;
   END $index_guard$`,
  ...ITEM_INDEXES.map((index) => itemIndexSql(index)),
  `CREATE OR REPLACE FUNCTION qm_tenant_id() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
     AS $qm_tenant_id$ SELECT id FROM qm_tenant $qm_tenant_id$`,
  `CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $forbid_mutation$
   BEGIN
     RAISE EXCEPTION '% on % is forbidden', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
   END $forbid_mutation$`,
  `CREATE OR REPLACE FUNCTION forbid_direct_delete() RETURNS trigger LANGUAGE plpgsql AS $forbid_direct_delete$
   BEGIN
     IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
     RAISE EXCEPTION 'DELETE on % is only allowed through its session', TG_TABLE_NAME
       USING ERRCODE = 'integrity_constraint_violation';
   END $forbid_direct_delete$`,
  `CREATE TRIGGER items_append_only BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
  `CREATE TRIGGER items_no_truncate BEFORE TRUNCATE ON items FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
  `CREATE TRIGGER items_delete_through_session BEFORE DELETE ON items
   FOR EACH ROW EXECUTE FUNCTION forbid_direct_delete()`,
  `CREATE TRIGGER blobs_immutable BEFORE UPDATE OR DELETE ON blobs FOR EACH ROW EXECUTE FUNCTION forbid_mutation()`,
  `CREATE TRIGGER blobs_no_truncate BEFORE TRUNCATE ON blobs FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation()`,
  `CREATE OR REPLACE FUNCTION sync_item_search() RETURNS trigger
   LANGUAGE plpgsql AS $sync_item_search$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       DELETE FROM session_entry_search WHERE session_id = OLD.session_id AND seq = OLD.seq;
       RETURN OLD;
     END IF;
     IF ${SEARCHABLE_ITEM("NEW")} AND btrim(NEW.text) <> '' THEN
       INSERT INTO session_entry_search(session_id, seq, type, author, text, created_at)
       VALUES (NEW.session_id, NEW.seq, ${searchTypeExpr("NEW")},
               CASE WHEN NEW.kind IN ${USER_KINDS} AND jsonb_typeof(NEW.body -> 'name') = 'string'
                    THEN NEW.body ->> 'name' END,
               NEW.text, ${msOf("NEW.created_at")})
       ON CONFLICT (session_id, seq) DO NOTHING;
     END IF;
     RETURN NEW;
   END $sync_item_search$`,
  `CREATE TRIGGER session_entry_search AFTER INSERT OR DELETE ON items
   FOR EACH ROW EXECUTE FUNCTION sync_item_search()`,
  `DROP TRIGGER IF EXISTS session_entries_search_write_through ON session_entries`,
  `DROP FUNCTION IF EXISTS sync_session_entry_search()`,
  `DROP TRIGGER IF EXISTS participant_activity_boundary_insert_v3 ON participants`,
  `DROP TRIGGER IF EXISTS participant_activity_reopen_v3 ON participants`,
  `DROP TRIGGER IF EXISTS participant_activity_entry_v3 ON session_entries`,
  `DROP TRIGGER IF EXISTS session_entry_boundary_v1 ON session_entries`,
  `DROP FUNCTION IF EXISTS participant_activity_on_insert_v3(), participant_activity_on_reopen_v3(),
     participant_activity_on_entry_v3(), session_entry_boundary_v1()`,
  `ALTER TABLE session_entries RENAME TO legacy_session_entries`,
];
