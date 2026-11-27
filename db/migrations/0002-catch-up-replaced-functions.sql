SET LOCAL check_function_bodies = false;


CREATE OR REPLACE FUNCTION public.qm_bound_external_org(issuer text) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
  SELECT o.org_id FROM tenant_external_orgs o
    WHERE o.issuer = $1 AND o.tenant = nullif(current_setting('qm.tenant_id', true), '')::uuid
  $_$;

CREATE OR REPLACE FUNCTION public.qm_tenant_for_external_org(issuer text, org text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
  SELECT o.tenant FROM tenant_external_orgs o
    WHERE o.issuer = $1 AND o.org_id = $2 AND o.tenant IN (SELECT qm_serving_tenants())
  $_$;

CREATE OR REPLACE FUNCTION public.qm_tenants_for_email(email text) RETURNS TABLE(tenant_id uuid)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ BEGIN
      RETURN QUERY
        SELECT m.tenant_id FROM directory_members m
         WHERE lower(m.principal_id) = lower(email) AND m.type = 'internal'
        UNION
        SELECT g.tenant_id FROM admin_grants g WHERE lower(g.principal_id) = lower(email)
        UNION
        SELECT l.tenant_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
            AND u.kind = 'person' AND u.offboarded_at IS NULL
            AND (u.source IS NOT NULL OR EXISTS (SELECT 1 FROM user_links s
              WHERE s.tenant_id = u.tenant_id AND s.user_id = u.id AND s.alias_id <> u.primary_alias)) WHERE l.alias_id = lower(btrim(email));
    END $$;

CREATE OR REPLACE FUNCTION public.qm_tenants_for_principal(principal text) RETURNS SETOF uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$ BEGIN
        RETURN QUERY
          SELECT l.tenant_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
            AND u.kind = 'person' AND u.offboarded_at IS NULL
            AND (u.source IS NOT NULL OR EXISTS (SELECT 1 FROM user_links s
              WHERE s.tenant_id = u.tenant_id AND s.user_id = u.id AND s.alias_id <> u.primary_alias)) WHERE l.alias_id = CASE WHEN position('@' IN btrim(principal)) > 0 THEN lower(btrim(principal)) ELSE btrim(principal) END
          UNION
          SELECT g.tenant_id FROM admin_grants g WHERE g.principal_id = principal
          UNION
          SELECT g.tenant_id FROM admin_grants g
            JOIN user_links o ON o.tenant_id = g.tenant_id AND o.alias_id = CASE WHEN position('@' IN btrim(g.principal_id)) > 0 THEN lower(btrim(g.principal_id)) ELSE btrim(g.principal_id) END
            JOIN user_links l ON l.tenant_id = o.tenant_id AND l.user_id = o.user_id
           WHERE l.alias_id = CASE WHEN position('@' IN btrim(principal)) > 0 THEN lower(btrim(principal)) ELSE btrim(principal) END;
      END $$;

CREATE OR REPLACE FUNCTION public.qm_move_personal_scopes() RETURNS TABLE(scope_table text, scope_tenant uuid, moved_rows bigint, dropped_rows bigint)
    LANGUAGE plpgsql
    AS $_$
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
  FOR target IN 
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
     AND c.table_name::text <> ALL (ARRAY['sprites_initialization', 'smolmachines_sandbox_bodies', 'e2b_sandbox_bodies', 'modal_sandbox_bodies', 'aws_sandbox_bodies', 'render_sandbox_bodies', 'render_scratch_bodies', 'render_sandbox_cleanup', 'render_sandbox_namespace', 'do_managed_agents_sandbox_bodies', 'superserve_sandbox_bodies', 'sandbox_routing', 'sandbox_loads']) LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %1$I t JOIN personal_scope_moves m ON t.%2$I LIKE ''personal:%%'' AND m.alias = CASE WHEN position(''@'' IN btrim(substr(t.%2$I, 10))) > 0 THEN lower(btrim(substr(t.%2$I, 10))) ELSE btrim(substr(t.%2$I, 10)) END %3$s)',
      target.tbl, target.col, CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END) INTO found;
    CONTINUE WHEN NOT found;
    BEGIN
      EXECUTE format(
        'WITH moved AS (UPDATE %1$I t SET %2$I = m.to_scope FROM personal_scope_moves m WHERE t.%2$I LIKE ''personal:%%'' AND m.alias = CASE WHEN position(''@'' IN btrim(substr(t.%2$I, 10))) > 0 THEN lower(btrim(substr(t.%2$I, 10))) ELSE btrim(substr(t.%2$I, 10)) END %3$s RETURNING %4$s AS tenant)
         INSERT INTO personal_scope_tally SELECT %1$L, tenant, count(*), 0 FROM moved GROUP BY 2',
        target.tbl, target.col, CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END, CASE WHEN target.tenanted THEN 't.tenant_id' ELSE 'NULL::uuid' END);
    EXCEPTION WHEN unique_violation THEN
      FOR hit IN EXECUTE format(
        'SELECT t.ctid AS row_id, m.to_scope, %4$s AS tenant FROM %1$I t JOIN personal_scope_moves m ON t.%2$I LIKE ''personal:%%'' AND m.alias = CASE WHEN position(''@'' IN btrim(substr(t.%2$I, 10))) > 0 THEN lower(btrim(substr(t.%2$I, 10))) ELSE btrim(substr(t.%2$I, 10)) END %3$s',
        target.tbl, target.col, CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END, CASE WHEN target.tenanted THEN 't.tenant_id' ELSE 'NULL::uuid' END)
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
  FOR target IN 
  SELECT c.table_name::text AS tbl, c.column_name::text AS col,
         EXISTS (SELECT 1 FROM information_schema.columns k
                  WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
                    AND k.column_name = 'tenant_id') AS tenanted
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' AND c.udt_name = '_text'
     AND c.table_name::text <> ALL (ARRAY['sprites_initialization', 'smolmachines_sandbox_bodies', 'e2b_sandbox_bodies', 'modal_sandbox_bodies', 'aws_sandbox_bodies', 'render_sandbox_bodies', 'render_scratch_bodies', 'render_sandbox_cleanup', 'render_sandbox_namespace', 'do_managed_agents_sandbox_bodies', 'superserve_sandbox_bodies', 'sandbox_routing', 'sandbox_loads']) LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %1$I t CROSS JOIN LATERAL unnest(t.%2$I) u(e)
                      JOIN personal_scope_moves m ON u.e LIKE ''personal:%%'' AND m.alias = CASE WHEN position(''@'' IN btrim(substr(u.e, 10))) > 0 THEN lower(btrim(substr(u.e, 10))) ELSE btrim(substr(u.e, 10)) END %3$s)', target.tbl, target.col, CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END) INTO found;
    CONTINUE WHEN NOT found;
    EXECUTE format(
      'WITH moved AS (UPDATE %1$I t SET %2$I = ARRAY(
           SELECT coalesce((SELECT m.to_scope FROM personal_scope_moves m WHERE u.e LIKE ''personal:%%'' AND m.alias = CASE WHEN position(''@'' IN btrim(substr(u.e, 10))) > 0 THEN lower(btrim(substr(u.e, 10))) ELSE btrim(substr(u.e, 10)) END %3$s LIMIT 1), u.e)
             FROM unnest(t.%2$I) WITH ORDINALITY u(e, n) ORDER BY u.n)
         WHERE EXISTS (SELECT 1 FROM unnest(t.%2$I) u(e) JOIN personal_scope_moves m ON u.e LIKE ''personal:%%'' AND m.alias = CASE WHEN position(''@'' IN btrim(substr(u.e, 10))) > 0 THEN lower(btrim(substr(u.e, 10))) ELSE btrim(substr(u.e, 10)) END %3$s)
         RETURNING %4$s AS tenant)
       INSERT INTO personal_scope_tally SELECT %1$L, tenant, count(*), 0 FROM moved GROUP BY 2',
      target.tbl, target.col, CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END, CASE WHEN target.tenanted THEN 't.tenant_id' ELSE 'NULL::uuid' END);
  END LOOP;
  FOR target IN 
  SELECT c.table_name::text AS tbl,
         EXISTS (SELECT 1 FROM information_schema.columns k
                  WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
                    AND k.column_name = 'tenant_id') AS tenanted
    FROM information_schema.columns c
    JOIN information_schema.columns i ON i.table_schema = c.table_schema AND i.table_name = c.table_name
                                     AND i.column_name = 'id' AND i.data_type = 'text'
   WHERE c.table_schema = current_schema() AND c.column_name = 'json' AND c.data_type = 'jsonb'
     AND c.table_name::text <> ALL (ARRAY['sprites_initialization', 'smolmachines_sandbox_bodies', 'e2b_sandbox_bodies', 'modal_sandbox_bodies', 'aws_sandbox_bodies', 'render_sandbox_bodies', 'render_scratch_bodies', 'render_sandbox_cleanup', 'render_sandbox_namespace', 'do_managed_agents_sandbox_bodies', 'superserve_sandbox_bodies', 'sandbox_routing', 'sandbox_loads']) LOOP
    FOR hit IN EXECUTE format(
      'SELECT t.ctid AS row_id, %2$s AS tenant, t.json FROM %1$I t WHERE t.json::text LIKE ''%%"personal:%%''',
      target.tbl, CASE WHEN target.tenanted THEN 't.tenant_id' ELSE 'NULL::uuid' END)
    LOOP
      body := hit.json::text;
      FOR swap IN SELECT DISTINCT v.s, mv.to_scope
                 FROM (SELECT x #>> '{}' AS s FROM jsonb_path_query(hit.json, 'strict $.** ? (@.type() == "string" && @ starts with "personal:")') x) v
                 JOIN personal_scope_moves mv ON mv.alias = CASE WHEN position('@' IN btrim(substr(v.s, 10))) > 0 THEN lower(btrim(substr(v.s, 10))) ELSE btrim(substr(v.s, 10)) END AND (hit.tenant IS NULL OR mv.tenant_id = hit.tenant)
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
END $_$;

CREATE OR REPLACE FUNCTION public.qm_move_exact_personal_scopes() RETURNS TABLE(scope_table text, scope_tenant uuid, moved_rows bigint, dropped_rows bigint)
    LANGUAGE plpgsql
    AS $_$
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
  FOR target IN 
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
     AND c.table_name::text <> ALL (ARRAY['sprites_initialization', 'smolmachines_sandbox_bodies', 'e2b_sandbox_bodies', 'modal_sandbox_bodies', 'aws_sandbox_bodies', 'render_sandbox_bodies', 'render_scratch_bodies', 'render_sandbox_cleanup', 'render_sandbox_namespace', 'do_managed_agents_sandbox_bodies', 'superserve_sandbox_bodies', 'sandbox_routing', 'sandbox_loads']) LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %1$I t JOIN personal_scope_moves m ON t.%2$I = ''personal:'' || m.alias %3$s)',
      target.tbl, target.col, CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END) INTO found;
    CONTINUE WHEN NOT found;
    BEGIN
      EXECUTE format(
        'WITH moved AS (UPDATE %1$I t SET %2$I = m.to_scope FROM personal_scope_moves m WHERE t.%2$I = ''personal:'' || m.alias %3$s RETURNING %4$s AS tenant)
         INSERT INTO personal_scope_tally SELECT %1$L, tenant, count(*), 0 FROM moved GROUP BY 2',
        target.tbl, target.col, CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END, CASE WHEN target.tenanted THEN 't.tenant_id' ELSE 'NULL::uuid' END);
    EXCEPTION WHEN unique_violation THEN
      FOR hit IN EXECUTE format(
        'SELECT t.ctid AS row_id, m.to_scope, %4$s AS tenant FROM %1$I t JOIN personal_scope_moves m ON t.%2$I = ''personal:'' || m.alias %3$s',
        target.tbl, target.col, CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END, CASE WHEN target.tenanted THEN 't.tenant_id' ELSE 'NULL::uuid' END)
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
  FOR target IN 
  SELECT c.table_name::text AS tbl, c.column_name::text AS col,
         EXISTS (SELECT 1 FROM information_schema.columns k
                  WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
                    AND k.column_name = 'tenant_id') AS tenanted
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
   WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' AND c.udt_name = '_text'
     AND c.table_name::text <> ALL (ARRAY['sprites_initialization', 'smolmachines_sandbox_bodies', 'e2b_sandbox_bodies', 'modal_sandbox_bodies', 'aws_sandbox_bodies', 'render_sandbox_bodies', 'render_scratch_bodies', 'render_sandbox_cleanup', 'render_sandbox_namespace', 'do_managed_agents_sandbox_bodies', 'superserve_sandbox_bodies', 'sandbox_routing', 'sandbox_loads']) LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %1$I t CROSS JOIN LATERAL unnest(t.%2$I) u(e)
                      JOIN personal_scope_moves m ON u.e = ''personal:'' || m.alias %3$s)', target.tbl, target.col, CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END) INTO found;
    CONTINUE WHEN NOT found;
    EXECUTE format(
      'WITH moved AS (UPDATE %1$I t SET %2$I = ARRAY(
           SELECT coalesce((SELECT m.to_scope FROM personal_scope_moves m WHERE u.e = ''personal:'' || m.alias %3$s LIMIT 1), u.e)
             FROM unnest(t.%2$I) WITH ORDINALITY u(e, n) ORDER BY u.n)
         WHERE EXISTS (SELECT 1 FROM unnest(t.%2$I) u(e) JOIN personal_scope_moves m ON u.e = ''personal:'' || m.alias %3$s)
         RETURNING %4$s AS tenant)
       INSERT INTO personal_scope_tally SELECT %1$L, tenant, count(*), 0 FROM moved GROUP BY 2',
      target.tbl, target.col, CASE WHEN target.tenanted THEN 'AND m.tenant_id = t.tenant_id' ELSE '' END, CASE WHEN target.tenanted THEN 't.tenant_id' ELSE 'NULL::uuid' END);
  END LOOP;
  FOR target IN 
  SELECT c.table_name::text AS tbl,
         EXISTS (SELECT 1 FROM information_schema.columns k
                  WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name
                    AND k.column_name = 'tenant_id') AS tenanted
    FROM information_schema.columns c
    JOIN information_schema.columns i ON i.table_schema = c.table_schema AND i.table_name = c.table_name
                                     AND i.column_name = 'id' AND i.data_type = 'text'
   WHERE c.table_schema = current_schema() AND c.column_name = 'json' AND c.data_type = 'jsonb'
     AND c.table_name::text <> ALL (ARRAY['sprites_initialization', 'smolmachines_sandbox_bodies', 'e2b_sandbox_bodies', 'modal_sandbox_bodies', 'aws_sandbox_bodies', 'render_sandbox_bodies', 'render_scratch_bodies', 'render_sandbox_cleanup', 'render_sandbox_namespace', 'do_managed_agents_sandbox_bodies', 'superserve_sandbox_bodies', 'sandbox_routing', 'sandbox_loads']) LOOP
    FOR hit IN EXECUTE format(
      'SELECT t.ctid AS row_id, %2$s AS tenant, t.json FROM %1$I t WHERE t.json::text LIKE ''%%"personal:%%''',
      target.tbl, CASE WHEN target.tenanted THEN 't.tenant_id' ELSE 'NULL::uuid' END)
    LOOP
      body := hit.json::text;
      FOR swap IN SELECT DISTINCT v.s, mv.to_scope
                 FROM (SELECT x #>> '{}' AS s FROM jsonb_path_query(hit.json, 'strict $.** ? (@.type() == "string" && @ starts with "personal:")') x) v
                 JOIN personal_scope_moves mv ON mv.alias = CASE WHEN position('@' IN btrim(substr(v.s, 10))) > 0 THEN lower(btrim(substr(v.s, 10))) ELSE btrim(substr(v.s, 10)) END AND (hit.tenant IS NULL OR mv.tenant_id = hit.tenant)
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
END $_$;
