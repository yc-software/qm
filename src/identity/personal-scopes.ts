import type { PoolClient } from "pg";
import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { fold } from "./user-tenancy.ts";

const MACHINE_TABLES = [
  "sprites_initialization",
  "smolmachines_sandbox_bodies",
  "e2b_sandbox_bodies",
  "modal_sandbox_bodies",
  "aws_sandbox_bodies",
  "render_sandbox_bodies",
  "render_scratch_bodies",
  "render_sandbox_cleanup",
  "render_sandbox_namespace",
  "do_managed_agents_sandbox_bodies",
  "superserve_sandbox_bodies",
  "sandbox_routing",
  "sandbox_loads",
];

const ref = (expr: string): string => fold(`substr(${expr}, 10)`);

const SCOPE_COLUMNS = `
  SELECT c.table_name::text AS tbl, c.column_name::text AS col,
         EXISTS (SELECT 1 FROM information_schema.columns k
                  WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
                    AND k.column_name = 'tenant_id') AS tenanted
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' AND c.data_type = 'text'
     AND (c.column_name LIKE '%scope_id' OR c.column_name = 'created_in_scope'
          OR (c.column_name = 'id' AND EXISTS (SELECT 1 FROM information_schema.columns j
                                                WHERE j.table_schema = c.table_schema AND j.table_name = c.table_name
                                                  AND j.column_name = 'json' AND j.data_type = 'jsonb')))
     AND c.table_name::text <> ALL (ARRAY['${MACHINE_TABLES.join("', '")}'])`;

const ARRAY_COLUMNS = `
  SELECT c.table_name::text AS tbl, c.column_name::text AS col,
         EXISTS (SELECT 1 FROM information_schema.columns k
                  WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
                    AND k.column_name = 'tenant_id') AS tenanted
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' AND c.udt_name = '_text'
     AND c.table_name::text <> ALL (ARRAY['${MACHINE_TABLES.join("', '")}'])`;

const JSON_TABLES = `
  SELECT c.table_name::text AS tbl,
         EXISTS (SELECT 1 FROM information_schema.columns k
                  WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
                    AND k.column_name = 'tenant_id') AS tenanted
    FROM information_schema.columns c
    JOIN information_schema.columns i ON i.table_schema = c.table_schema AND i.table_name = c.table_name
                                     AND i.column_name = 'id' AND i.data_type = 'text'
   WHERE c.table_schema = current_schema() AND c.column_name = 'json' AND c.data_type = 'jsonb'
     AND c.table_name::text <> ALL (ARRAY['${MACHINE_TABLES.join("', '")}'])`;

const PERSONAL_STRINGS = `'strict $.** ? (@.type() == "string" && @ starts with "personal:")'`;

const tenantOf = (alias: string): string => `CASE WHEN target.tenanted THEN '${alias}.tenant_id' ELSE 'NULL::uuid' END`;
const sameTenant = `CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END`;
const quoted = (sql: string): string => sql.replaceAll("'", "''");
const match = (e: string): string => quoted(`${e} = 'personal:' || m.alias %3$s`);

const MOVE_FUNCTION = `CREATE OR REPLACE FUNCTION qm_move_exact_personal_scopes()
  RETURNS TABLE(scope_table text, scope_tenant uuid, moved_rows bigint, dropped_rows bigint) LANGUAGE plpgsql AS $qm_move$
DECLARE
  target record;
  hit record;
  swap record;
  body text;
  rewritten jsonb;
  found boolean;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS personal_scope_tally(tbl text, tenant_id uuid, moved bigint, dropped bigint) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS personal_scope_dropped(tbl text, tenant_id uuid, row_data jsonb) ON COMMIT DROP;
  FOR target IN ${SCOPE_COLUMNS} LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %1$I t JOIN personal_scope_moves m ON ${match("t.%2$I")})',
      target.tbl, target.col, ${sameTenant}) INTO found;
    CONTINUE WHEN NOT found;
    BEGIN
      EXECUTE format(
        'WITH moved AS (UPDATE %1$I t SET %2$I = m.to_scope FROM personal_scope_moves m WHERE ${match("t.%2$I")} RETURNING %4$s AS tenant)
         INSERT INTO personal_scope_tally SELECT %1$L, tenant, count(*), 0 FROM moved GROUP BY 2',
        target.tbl, target.col, ${sameTenant}, ${tenantOf("t")});
    EXCEPTION WHEN unique_violation THEN
      FOR hit IN EXECUTE format(
        'SELECT t.ctid AS row_id, m.to_scope, %4$s AS tenant FROM %1$I t JOIN personal_scope_moves m ON ${match("t.%2$I")}',
        target.tbl, target.col, ${sameTenant}, ${tenantOf("t")})
      LOOP
        BEGIN
          EXECUTE format('UPDATE %I SET %I = $1 WHERE ctid = $2', target.tbl, target.col) USING hit.to_scope, hit.row_id;
          INSERT INTO personal_scope_tally VALUES (target.tbl, hit.tenant, 1, 0);
        EXCEPTION WHEN unique_violation THEN
          EXECUTE format('INSERT INTO personal_scope_dropped SELECT %1$L, $2, to_jsonb(t) FROM %1$I t WHERE ctid = $1',
            target.tbl) USING hit.row_id, hit.tenant;
          EXECUTE format('DELETE FROM %I WHERE ctid = $1', target.tbl) USING hit.row_id;
          INSERT INTO personal_scope_tally VALUES (target.tbl, hit.tenant, 0, 1);
        END;
      END LOOP;
    END;
  END LOOP;
  FOR target IN ${ARRAY_COLUMNS} LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %1$I t CROSS JOIN LATERAL unnest(t.%2$I) u(e)
                      JOIN personal_scope_moves m ON ${match("u.e")})', target.tbl, target.col, ${sameTenant}) INTO found;
    CONTINUE WHEN NOT found;
    EXECUTE format(
      'WITH moved AS (UPDATE %1$I t SET %2$I = ARRAY(
           SELECT coalesce((SELECT m.to_scope FROM personal_scope_moves m WHERE ${match("u.e")} LIMIT 1), u.e)
             FROM unnest(t.%2$I) WITH ORDINALITY u(e, n) ORDER BY u.n)
         WHERE EXISTS (SELECT 1 FROM unnest(t.%2$I) u(e) JOIN personal_scope_moves m ON ${match("u.e")})
         RETURNING %4$s AS tenant)
       INSERT INTO personal_scope_tally SELECT %1$L, tenant, count(*), 0 FROM moved GROUP BY 2',
      target.tbl, target.col, ${sameTenant}, ${tenantOf("t")});
  END LOOP;
  FOR target IN ${JSON_TABLES} LOOP
    FOR hit IN EXECUTE format(
      'SELECT t.ctid AS row_id, %2$s AS tenant, t.json FROM %1$I t WHERE t.json::text LIKE ''%%"personal:%%''',
      target.tbl, ${tenantOf("t")})
    LOOP
      body := hit.json::text;
      FOR swap IN SELECT DISTINCT v.s, mv.to_scope
                 FROM (SELECT x #>> '{}' AS s FROM jsonb_path_query(hit.json, ${PERSONAL_STRINGS}) x) v
                 JOIN personal_scope_moves mv ON mv.alias = ${ref("v.s")} AND (hit.tenant IS NULL OR mv.tenant_id = hit.tenant)
      LOOP
        body := replace(body, to_jsonb(swap.s)::text, to_jsonb(swap.to_scope)::text);
      END LOOP;
      CONTINUE WHEN body = hit.json::text;
      rewritten := body::jsonb;
      IF hit.json ? 'backingScopeId' THEN rewritten := jsonb_set(rewritten, '{backingScopeId}', hit.json -> 'backingScopeId'); END IF;
      EXECUTE format('UPDATE %I SET json = $1 WHERE ctid = $2', target.tbl) USING rewritten, hit.row_id;
      INSERT INTO personal_scope_tally VALUES (target.tbl || '.json', hit.tenant, 1, 0);
    END LOOP;
  END LOOP;
  RETURN QUERY SELECT t.tbl, t.tenant_id, sum(t.moved)::bigint, sum(t.dropped)::bigint
                 FROM personal_scope_tally t GROUP BY 1, 2;
  DELETE FROM personal_scope_tally;
END $qm_move$`;

const REKEYED = "users/v2/0007-personal-scopes-by-user-id";

export const PERSONAL_SCOPE_MIGRATIONS: PgMigrationDefinition[] = [
  {
    id: "users/v2/0008-scope-alias",
    statements: [
      MOVE_FUNCTION,
      `DROP FUNCTION IF EXISTS qm_move_personal_scopes()`,
      `DO $scopes_back_under_aliases$
       BEGIN
         IF NOT EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = '${REKEYED}') THEN RETURN; END IF;
         CREATE TEMP TABLE personal_scope_moves(tenant_id uuid, alias text, to_scope text) ON COMMIT DROP;
         INSERT INTO personal_scope_moves SELECT tenant_id, id::text, 'personal:' || primary_alias FROM users;
         PERFORM qm_move_exact_personal_scopes();
       END $scopes_back_under_aliases$`,
      `ALTER TABLE users ADD COLUMN scope_alias TEXT`,
      `UPDATE users SET scope_alias = primary_alias`,
      `ALTER TABLE users ALTER COLUMN scope_alias SET NOT NULL`,
      `ALTER TABLE users ADD CONSTRAINT users_scope_alias_link FOREIGN KEY (tenant_id, id, scope_alias)
         REFERENCES user_links(tenant_id, user_id, alias_id) DEFERRABLE INITIALLY DEFERRED`,
      `CREATE FUNCTION users_scope_alias() RETURNS trigger LANGUAGE plpgsql AS $users_scope_alias$
       BEGIN
         NEW.scope_alias := coalesce(NEW.scope_alias, NEW.primary_alias);
         RETURN NEW;
       END $users_scope_alias$`,
      `CREATE TRIGGER users_scope_alias BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION users_scope_alias()`,
    ],
  },
];

export async function movePersonalScope(client: PoolClient, fromAlias: string, toUserId: string): Promise<void> {
  await client.query(
    `CREATE TEMP TABLE IF NOT EXISTS personal_scope_moves(tenant_id uuid, alias text, to_scope text) ON COMMIT DROP`,
  );
  await client.query(
    `INSERT INTO personal_scope_moves SELECT tenant_id, $1, 'personal:' || scope_alias FROM users WHERE id = $2`,
    [fromAlias, toUserId],
  );
  await client.query(`SELECT FROM qm_move_exact_personal_scopes()`);
  await client.query(`DELETE FROM personal_scope_moves`);
}
