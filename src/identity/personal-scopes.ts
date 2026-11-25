import type { PoolClient } from "pg";
import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { msOf } from "../sessions/items.ts";
import { fold } from "./user-tenancy.ts";
import { USER_ID_NAMESPACE } from "../directory/person-refs.ts";

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

const FOUNDING_ID = (alias: string): string => `(SELECT (substr(h, 1, 12) || '8' || substr(h, 14, 3)
     || to_hex((('x' || substr(h, 17, 1))::bit(4)::int & 3) | 8) || substr(h, 18, 15))::uuid
   FROM (SELECT encode(sha256(decode('${USER_ID_NAMESPACE.replaceAll("-", "")}', 'hex') || convert_to(${alias}, 'UTF8')), 'hex') AS h) f)`;

const PERSONAL_STRINGS = `'strict $.** ? (@.type() == "string" && @ starts with "personal:")'`;

const tenantOf = (alias: string): string => `CASE WHEN target.tenanted THEN '${alias}.tenant_id' ELSE 'NULL::uuid' END`;
const sameTenant = `CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END`;
const quoted = (sql: string): string => sql.replaceAll("'", "''");
const foldedMatch = (e: string): string => quoted(`${e} LIKE 'personal:%%' AND m.alias = ${ref(e)} %3$s`);
const exactMatch = (e: string): string => quoted(`${e} = 'personal:' || m.alias %3$s`);

const moveFunction = (name: string, match: (e: string) => string): string => `CREATE OR REPLACE FUNCTION ${name}()
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

const UNMATCHED = `
  FOR target IN ${SCOPE_COLUMNS} LOOP
    EXECUTE format(
      'INSERT INTO personal_scope_unmatched SELECT DISTINCT %3$s, %1$L, t.%2$I FROM %1$I t
        WHERE t.%2$I LIKE ''personal:%%'' AND NOT pg_input_is_valid(substr(t.%2$I, 10), ''uuid'')',
      target.tbl, target.col, ${tenantOf("t")});
  END LOOP;
  FOR target IN ${ARRAY_COLUMNS} LOOP
    EXECUTE format(
      'INSERT INTO personal_scope_unmatched SELECT DISTINCT %3$s, %1$L, u.e FROM %1$I t CROSS JOIN LATERAL unnest(t.%2$I) u(e)
        WHERE u.e LIKE ''personal:%%'' AND NOT pg_input_is_valid(substr(u.e, 10), ''uuid'')',
      target.tbl, target.col, ${tenantOf("t")});
  END LOOP;
  FOR target IN ${JSON_TABLES} LOOP
    EXECUTE format(
      'INSERT INTO personal_scope_unmatched SELECT DISTINCT %2$s, %1$L || ''.json'', v.s FROM %1$I t
        CROSS JOIN LATERAL (SELECT x #>> ''{}'' AS s FROM jsonb_path_query(t.json, ${quoted(PERSONAL_STRINGS)}) x) v
        WHERE t.json::text LIKE ''%%"personal:%%'' AND NOT pg_input_is_valid(substr(v.s, 10), ''uuid'')',
      target.tbl, ${tenantOf("t")});
  END LOOP;`;

export const PERSONAL_SCOPE_MIGRATIONS: PgMigrationDefinition[] = [
  {
    id: "users/v2/0007-personal-scopes-by-user-id",
    statements: [
      moveFunction("qm_move_personal_scopes", foldedMatch),
      moveFunction("qm_move_exact_personal_scopes", exactMatch),
      `DO $personal_scopes_by_user_id$
       DECLARE
         target record;
         tenant uuid;
       BEGIN
         CREATE TEMP TABLE personal_scope_moves(tenant_id uuid, alias text, to_scope text) ON COMMIT DROP;
         CREATE TEMP TABLE IF NOT EXISTS personal_scope_dropped(tbl text, tenant_id uuid, row_data jsonb) ON COMMIT DROP;
         CREATE TEMP TABLE personal_scope_report(scope_table text, scope_tenant uuid, moved_rows bigint, dropped_rows bigint)
           ON COMMIT DROP;
         CREATE TEMP TABLE personal_scope_unmatched(tenant_id uuid, tbl text, scope text) ON COMMIT DROP;
         ${UNMATCHED}
         DELETE FROM personal_scope_unmatched u USING user_links l
          WHERE l.alias_id = ${ref("u.scope")} AND (u.tenant_id IS NULL OR l.tenant_id = u.tenant_id);
         FOR tenant IN SELECT id FROM tenants LOOP
           PERFORM set_config('qm.tenant_id', tenant::text, true);
           INSERT INTO users(id, primary_alias)
             SELECT DISTINCT ${FOUNDING_ID("a.alias")}, a.alias
               FROM (SELECT ${ref("u.scope")} AS alias FROM personal_scope_unmatched u
                      WHERE u.tenant_id = tenant OR u.tenant_id IS NULL) a
              WHERE a.alias <> '' AND NOT EXISTS (SELECT 1 FROM user_links l WHERE l.tenant_id = tenant AND l.alias_id = a.alias)
             ON CONFLICT DO NOTHING;
           INSERT INTO user_links(alias_id, user_id, evidence, created_at)
             SELECT u.primary_alias, u.id, 'primary', now() FROM users u
              WHERE u.tenant_id = tenant
                AND NOT EXISTS (SELECT 1 FROM user_links l WHERE l.tenant_id = tenant AND l.alias_id = u.primary_alias)
             ON CONFLICT DO NOTHING;
           DELETE FROM personal_scope_moves;
           INSERT INTO personal_scope_moves
             SELECT l.tenant_id, l.alias_id, 'personal:' || l.user_id FROM user_links l WHERE l.tenant_id = tenant;
           INSERT INTO personal_scope_report SELECT * FROM qm_move_personal_scopes();
         END LOOP;
         RAISE NOTICE 'personal scopes keyed by user id: % rows moved, % duplicate rows dropped, % scopes matched no user',
           (SELECT coalesce(sum(moved_rows), 0) FROM personal_scope_report),
           (SELECT coalesce(sum(dropped_rows), 0) FROM personal_scope_report),
           (SELECT count(DISTINCT (tenant_id, scope)) FROM personal_scope_unmatched);
         IF to_regclass('audit_log') IS NULL THEN RETURN; END IF;
         INSERT INTO audit_log(tenant_id, at, principal_id, action, resource, scope_label, detail)
         SELECT t.tenant_id, ${msOf("now()")}, 'system:migration', 'personal_scopes_by_user_id', 'personal scopes', 'users',
                jsonb_build_object(
                  'moved', (SELECT coalesce(jsonb_object_agg(r.tbl, r.n), '{}') FROM (SELECT scope_table AS tbl, sum(moved_rows) AS n
                             FROM personal_scope_report WHERE scope_tenant = t.tenant_id GROUP BY scope_table) r WHERE r.n > 0),
                  'dropped', (SELECT coalesce(jsonb_object_agg(r.tbl, r.n), '{}') FROM (SELECT scope_table AS tbl, sum(dropped_rows) AS n
                               FROM personal_scope_report WHERE scope_tenant = t.tenant_id GROUP BY scope_table) r WHERE r.n > 0),
                  'droppedRows', (SELECT coalesce(jsonb_agg(jsonb_build_object('table', d.tbl, 'row', d.row_data)), '[]')
                                    FROM personal_scope_dropped d WHERE d.tenant_id = t.tenant_id),
                  'unmatched', (SELECT coalesce(jsonb_agg(jsonb_build_object('scope', u.scope, 'tables', u.tables)
                                                          ORDER BY u.scope), '[]')
                                  FROM (SELECT scope, jsonb_agg(DISTINCT tbl) AS tables FROM personal_scope_unmatched
                                         WHERE tenant_id = t.tenant_id GROUP BY scope) u))::text
           FROM (SELECT scope_tenant AS tenant_id FROM personal_scope_report UNION SELECT tenant_id FROM personal_scope_unmatched) t
          WHERE t.tenant_id IS NOT NULL;
       END $personal_scopes_by_user_id$`,
    ],
  },
];

export async function movePersonalScope(client: PoolClient, fromUserId: string, toScope: string): Promise<void> {
  await client.query(
    `CREATE TEMP TABLE IF NOT EXISTS personal_scope_moves(tenant_id uuid, alias text, to_scope text) ON COMMIT DROP`,
  );
  await client.query(`INSERT INTO personal_scope_moves VALUES (qm_bound_tenant(), $1, $2)`, [fromUserId, toScope]);
  await client.query(`SELECT FROM qm_move_exact_personal_scopes()`);
  await client.query(`DELETE FROM personal_scope_moves`);
}
