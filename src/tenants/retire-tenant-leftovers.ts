import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { ACL_GRANTS_BUMP } from "../acl/postgres-grant-store.ts";
import { SPEND_INVALIDATION } from "../sessions/spend-invalidation.ts";

export const RETIRE_TENANT_LEFTOVERS: PgMigrationDefinition = {
  id: "0000-tenancy/retire-tenant-leftovers",
  statements: [
    `DO $retire_tenant_leftovers$
DECLARE
  k record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc
     WHERE pronamespace = current_schema()::regnamespace
       AND proname IN ('invalidate_request_spend', 'invalidate_session_spend')
       AND position('tenant_id' IN prosrc) > 0
  ) THEN
    DROP TRIGGER session_llm_requests_spend_dirty ON session_llm_requests;
    DROP TRIGGER sessions_spend_dirty ON sessions;
    DROP FUNCTION invalidate_request_spend(), invalidate_session_spend();
${SPEND_INVALIDATION}
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'acl_grants_truncate' AND tgrelid = to_regclass('acl_grants')) THEN
    DROP TRIGGER acl_grants_truncate ON acl_grants;
    ${ACL_GRANTS_BUMP.join(";\n    ")};
  END IF;
  IF to_regclass('tenants') IS NOT NULL THEN
    DROP POLICY IF EXISTS tenant_isolation ON tenants;
  END IF;
  FOR k IN
    SELECT i.indrelid::regclass AS tbl, c.relname AS name
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname IN ('sessions_thread_ref_key', 'runs_idempotency_key_key',
                         'deliveries_idempotency_key_key', 'session_spend_dirty_day_writer_key')
       AND c.relnamespace = current_schema()::regnamespace
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = i.indexrelid)
  LOOP
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE USING INDEX %I', k.tbl, k.name, k.name);
  END LOOP;
END $retire_tenant_leftovers$`,
  ],
};
