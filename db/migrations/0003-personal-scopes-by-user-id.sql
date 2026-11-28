-- qm:batched

CREATE TABLE IF NOT EXISTS qm_personal_scope_rekey_work(
  seq integer PRIMARY KEY,
  kind text NOT NULL,
  tbl text NOT NULL,
  col text NOT NULL,
  tenanted boolean NOT NULL,
  next_block bigint NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS qm_personal_scope_rekey_unmatched(tenant_id uuid, tbl text, scope text);
CREATE TABLE IF NOT EXISTS qm_personal_scope_rekey_report(tbl text, tenant_id uuid, moved bigint, dropped bigint);
CREATE TABLE IF NOT EXISTS qm_personal_scope_rekey_dropped(tbl text, tenant_id uuid, row_data jsonb);

CREATE OR REPLACE FUNCTION pg_temp.qm_scope_alias(scope text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN position('@' IN btrim(substr(scope, 10))) > 0 THEN lower(btrim(substr(scope, 10)))
              ELSE btrim(substr(scope, 10)) END
$f$;

CREATE OR REPLACE FUNCTION pg_temp.qm_alias_scope(scope text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$
  SELECT scope LIKE 'personal:%' AND NOT pg_input_is_valid(substr(scope, 10), 'uuid')
$f$;

CREATE OR REPLACE FUNCTION pg_temp.qm_rekey_json(doc jsonb, tenant uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  body text := doc::text;
  swap record;
  rewritten jsonb;
BEGIN
  IF tenant IS NULL THEN
    FOR swap IN SELECT DISTINCT v.s, (SELECT m.to_scope FROM pg_temp.qm_personal_scope_any_tenant m
                                       WHERE m.alias = pg_temp.qm_scope_alias(v.s)) AS to_scope
                  FROM (SELECT x #>> '{}' AS s FROM jsonb_path_query(doc,
                          'strict $.** ? (@.type() == "string" && @ starts with "personal:")') x) v
                 WHERE pg_temp.qm_alias_scope(v.s)
    LOOP
      CONTINUE WHEN swap.to_scope IS NULL;
      body := replace(body, to_jsonb(swap.s)::text, to_jsonb(swap.to_scope)::text);
    END LOOP;
  ELSE
    FOR swap IN SELECT DISTINCT v.s, (SELECT 'personal:' || l.user_id FROM user_links l
                                       WHERE l.tenant_id = tenant AND l.alias_id = pg_temp.qm_scope_alias(v.s)) AS to_scope
                  FROM (SELECT x #>> '{}' AS s FROM jsonb_path_query(doc,
                          'strict $.** ? (@.type() == "string" && @ starts with "personal:")') x) v
                 WHERE pg_temp.qm_alias_scope(v.s)
    LOOP
      CONTINUE WHEN swap.to_scope IS NULL;
      body := replace(body, to_jsonb(swap.s)::text, to_jsonb(swap.to_scope)::text);
    END LOOP;
  END IF;
  IF body = doc::text THEN
    RETURN NULL;
  END IF;
  rewritten := body::jsonb;
  IF doc ? 'backingScopeId' THEN
    rewritten := jsonb_set(rewritten, '{backingScopeId}', doc -> 'backingScopeId');
  END IF;
  RETURN CASE WHEN rewritten = doc THEN NULL ELSE rewritten END;
END $f$;

CREATE OR REPLACE FUNCTION pg_temp.qm_personal_scope_rekey_step(slice_blocks integer) RETURNS boolean
  LANGUAGE plpgsql AS $step$
DECLARE
  w record;
  hit record;
  last_block bigint;
  upto bigint;
  slice text;
  tenant_of text;
  moves text;
  same_tenant text;
  bind boolean;
  bound uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM qm_personal_scope_rekey_work) THEN
    IF EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = 'users/v2/0007-personal-scopes-by-user-id') THEN
      DROP TABLE qm_personal_scope_rekey_work, qm_personal_scope_rekey_unmatched,
                 qm_personal_scope_rekey_report, qm_personal_scope_rekey_dropped;
      RETURN false;
    END IF;
    WITH tables AS (
      SELECT t.table_name::text AS tbl,
             EXISTS (SELECT 1 FROM information_schema.columns k
                      WHERE k.table_schema = t.table_schema AND k.table_name = t.table_name
                        AND k.column_name = 'tenant_id') AS tenanted,
             EXISTS (SELECT 1 FROM information_schema.columns j
                      WHERE j.table_schema = t.table_schema AND j.table_name = t.table_name
                        AND j.column_name = 'json' AND j.data_type = 'jsonb') AS has_json,
             EXISTS (SELECT 1 FROM information_schema.columns i
                      WHERE i.table_schema = t.table_schema AND i.table_name = t.table_name
                        AND i.column_name = 'id' AND i.data_type = 'text') AS has_text_id
        FROM information_schema.tables t
       WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
         AND t.table_name::text NOT LIKE 'qm_personal_scope_rekey_%'
         AND t.table_name::text <> ALL (ARRAY['sprites_initialization', 'smolmachines_sandbox_bodies',
               'e2b_sandbox_bodies', 'modal_sandbox_bodies', 'aws_sandbox_bodies', 'render_sandbox_bodies',
               'render_scratch_bodies', 'render_sandbox_cleanup', 'render_sandbox_namespace',
               'do_managed_agents_sandbox_bodies', 'superserve_sandbox_bodies', 'sandbox_routing', 'sandbox_loads'])
    ), targets AS (
      SELECT 'column' AS kind, c.table_name::text AS tbl, c.column_name::text AS col, t.tenanted
        FROM information_schema.columns c JOIN tables t ON t.tbl = c.table_name::text
       WHERE c.table_schema = current_schema() AND c.data_type = 'text'
         AND (c.column_name LIKE '%scope_id' OR c.column_name = 'created_in_scope'
              OR (c.column_name = 'id' AND t.has_json))
      UNION ALL
      SELECT 'array', c.table_name::text, c.column_name::text, t.tenanted
        FROM information_schema.columns c JOIN tables t ON t.tbl = c.table_name::text
       WHERE c.table_schema = current_schema() AND c.udt_name = '_text'
      UNION ALL
      SELECT 'json', t.tbl, 'json', t.tenanted FROM tables t WHERE t.has_json AND t.has_text_id
    )
    INSERT INTO qm_personal_scope_rekey_work(seq, kind, tbl, col, tenanted)
    SELECT row_number() OVER (ORDER BY tenanted, tbl, kind, col), kind, tbl, col, tenanted FROM targets;
    INSERT INTO user_links(tenant_id, alias_id, user_id, evidence, created_at)
    SELECT u.tenant_id, u.primary_alias, u.id, 'primary', now() FROM users u
     WHERE NOT EXISTS (SELECT 1 FROM user_links l WHERE l.tenant_id = u.tenant_id AND l.alias_id = u.primary_alias)
    ON CONFLICT DO NOTHING;
    RETURN true;
  END IF;

  SELECT * INTO w FROM qm_personal_scope_rekey_work WHERE NOT done ORDER BY seq LIMIT 1;

  IF NOT FOUND THEN
    RAISE NOTICE 'personal scopes keyed by user id: % rows moved, % duplicate rows dropped, % scopes matched no user',
      (SELECT coalesce(sum(moved), 0) FROM qm_personal_scope_rekey_report),
      (SELECT coalesce(sum(dropped), 0) FROM qm_personal_scope_rekey_report),
      (SELECT count(DISTINCT (tenant_id, scope)) FROM qm_personal_scope_rekey_unmatched);
    IF to_regclass('audit_log') IS NOT NULL THEN
      INSERT INTO audit_log(tenant_id, at, principal_id, action, resource, scope_label, detail)
      SELECT t.tenant_id, (EXTRACT(EPOCH FROM now()) * 1000)::bigint, 'system:migration',
             'personal_scopes_by_user_id', 'personal scopes', 'users',
             jsonb_build_object('moved', coalesce(c.moved, '{}'), 'dropped', coalesce(c.dropped, '{}'),
                                'droppedRows', coalesce(d.rows, '[]'), 'unmatched', coalesce(u.scopes, '[]'))::text
        FROM (SELECT tenant_id FROM qm_personal_scope_rekey_report
              UNION SELECT tenant_id FROM qm_personal_scope_rekey_unmatched) t
        LEFT JOIN (SELECT tenant_id, jsonb_object_agg(tbl, moved) FILTER (WHERE moved > 0) AS moved,
                          jsonb_object_agg(tbl, dropped) FILTER (WHERE dropped > 0) AS dropped
                     FROM (SELECT tenant_id, tbl, sum(moved) AS moved, sum(dropped) AS dropped
                             FROM qm_personal_scope_rekey_report GROUP BY 1, 2) r
                    GROUP BY tenant_id) c ON c.tenant_id = t.tenant_id
        LEFT JOIN (SELECT tenant_id, jsonb_agg(jsonb_build_object('table', tbl, 'row', row_data)) AS rows
                     FROM qm_personal_scope_rekey_dropped GROUP BY tenant_id) d ON d.tenant_id = t.tenant_id
        LEFT JOIN (SELECT tenant_id, jsonb_agg(jsonb_build_object('scope', scope, 'tables', tables) ORDER BY scope) AS scopes
                     FROM (SELECT tenant_id, scope, jsonb_agg(DISTINCT tbl) AS tables FROM qm_personal_scope_rekey_unmatched
                            GROUP BY 1, 2) s
                    GROUP BY tenant_id) u ON u.tenant_id = t.tenant_id
       WHERE t.tenant_id IS NOT NULL;
    END IF;
    DROP TABLE qm_personal_scope_rekey_work, qm_personal_scope_rekey_unmatched,
               qm_personal_scope_rekey_report, qm_personal_scope_rekey_dropped;
    RETURN false;
  END IF;

  IF to_regclass(quote_ident(w.tbl)) IS NULL THEN
    UPDATE qm_personal_scope_rekey_work SET done = true WHERE seq = w.seq;
    RETURN true;
  END IF;
  last_block := pg_relation_size(quote_ident(w.tbl)) / current_setting('block_size')::bigint;
  IF w.next_block >= last_block THEN
    UPDATE qm_personal_scope_rekey_work SET done = true WHERE seq = w.seq;
    RETURN true;
  END IF;
  upto := least(w.next_block + slice_blocks, last_block);
  slice := format('t.ctid >= ''(%s,0)''::tid AND t.ctid < ''(%s,0)''::tid', w.next_block, upto);
  tenant_of := CASE WHEN w.tenanted THEN 't.tenant_id' ELSE 'NULL::uuid' END;

  CREATE TEMP TABLE IF NOT EXISTS qm_personal_scope_found(tenant_id uuid, tbl text, scope text) ON COMMIT DROP;
  TRUNCATE qm_personal_scope_found;
  same_tenant := CASE WHEN w.tenanted THEN 'AND l.tenant_id = t.tenant_id' ELSE '' END;
  IF w.kind = 'column' THEN
    EXECUTE format(
      'INSERT INTO qm_personal_scope_found
       SELECT DISTINCT %3$s, %1$L, t.%2$I FROM %1$I t
        WHERE %4$s AND pg_temp.qm_alias_scope(t.%2$I)
          AND NOT EXISTS (SELECT 1 FROM user_links l WHERE l.alias_id = pg_temp.qm_scope_alias(t.%2$I) %5$s)',
      w.tbl, w.col, tenant_of, slice, same_tenant);
  ELSIF w.kind = 'array' THEN
    EXECUTE format(
      'INSERT INTO qm_personal_scope_found
       SELECT DISTINCT %3$s, %1$L, u.e FROM %1$I t CROSS JOIN LATERAL unnest(t.%2$I) u(e)
        WHERE %4$s AND pg_temp.qm_alias_scope(u.e)
          AND NOT EXISTS (SELECT 1 FROM user_links l WHERE l.alias_id = pg_temp.qm_scope_alias(u.e) %5$s)',
      w.tbl, w.col, tenant_of, slice, same_tenant);
  ELSE
    EXECUTE format(
      'INSERT INTO qm_personal_scope_found
       SELECT DISTINCT %2$s, %1$L || ''.json'', v.s FROM %1$I t
        CROSS JOIN LATERAL (SELECT x #>> ''{}'' AS s FROM jsonb_path_query(t.json,
          ''strict $.** ? (@.type() == "string" && @ starts with "personal:")'') x) v
        WHERE %3$s AND t.json::text LIKE ''%%"personal:%%'' AND pg_temp.qm_alias_scope(v.s)
          AND NOT EXISTS (SELECT 1 FROM user_links l WHERE l.alias_id = pg_temp.qm_scope_alias(v.s) %4$s)',
      w.tbl, tenant_of, slice, same_tenant);
  END IF;
  INSERT INTO qm_personal_scope_rekey_unmatched SELECT * FROM qm_personal_scope_found;
  WITH fresh AS (
    SELECT DISTINCT x.id AS tenant_id, a.alias,
           (SELECT (substr(h, 1, 12) || '8' || substr(h, 14, 3)
                    || to_hex((('x' || substr(h, 17, 1))::bit(4)::int & 3) | 8) || substr(h, 18, 15))::uuid
              FROM (SELECT encode(sha256(decode('8f0b6a523c1e5d7a9b4e2f6c1d8a7e30', 'hex')
                                         || convert_to(a.alias, 'UTF8')), 'hex') AS h) f) AS user_id
      FROM (SELECT DISTINCT tenant_id, pg_temp.qm_scope_alias(scope) AS alias FROM qm_personal_scope_found) a
      JOIN tenants x ON x.id = a.tenant_id OR a.tenant_id IS NULL
     WHERE a.alias <> ''
       AND NOT EXISTS (SELECT 1 FROM user_links l WHERE l.tenant_id = x.id AND l.alias_id = a.alias)
  ), made AS (
    INSERT INTO users(tenant_id, id, primary_alias) SELECT tenant_id, user_id, alias FROM fresh
    ON CONFLICT DO NOTHING
    RETURNING tenant_id, id, primary_alias
  )
  INSERT INTO user_links(tenant_id, alias_id, user_id, evidence, created_at)
  SELECT tenant_id, primary_alias, id, 'primary', now() FROM made
  ON CONFLICT DO NOTHING;

  IF w.tenanted THEN
    moves := '(SELECT tenant_id, alias_id AS alias, ''personal:'' || user_id AS to_scope FROM user_links)';
    same_tenant := 'AND m.tenant_id = t.tenant_id';
  ELSE
    CREATE TEMP TABLE IF NOT EXISTS qm_personal_scope_any_tenant(alias text PRIMARY KEY, to_scope text) ON COMMIT DROP;
    TRUNCATE qm_personal_scope_any_tenant;
    INSERT INTO qm_personal_scope_any_tenant
    SELECT DISTINCT ON (l.alias_id) l.alias_id, 'personal:' || l.user_id
      FROM user_links l JOIN tenants x ON x.id = l.tenant_id
     ORDER BY l.alias_id, x.created_at, x.id;
    moves := 'pg_temp.qm_personal_scope_any_tenant';
    same_tenant := '';
  END IF;

  bind := w.tenanted AND EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = to_regclass(quote_ident(w.tbl))
                                    AND NOT g.tgisinternal AND g.tgtype & 1 = 0);
  CREATE TEMP TABLE IF NOT EXISTS qm_personal_scope_slice(row_id tid, tenant uuid, grp uuid, to_scope text, to_array text[])
    ON COMMIT DROP;
  TRUNCATE qm_personal_scope_slice;
  IF w.kind = 'column' THEN
    EXECUTE format(
      'INSERT INTO qm_personal_scope_slice(row_id, tenant, to_scope)
       SELECT t.ctid, %6$s, m.to_scope FROM %1$I t JOIN %3$s m
           ON pg_temp.qm_alias_scope(t.%2$I) AND m.alias = pg_temp.qm_scope_alias(t.%2$I) %5$s
        WHERE %4$s',
      w.tbl, w.col, moves, slice, same_tenant, tenant_of);
  ELSIF w.kind = 'array' THEN
    EXECUTE format(
      'INSERT INTO qm_personal_scope_slice(row_id, tenant, to_array)
       SELECT t.ctid, %6$s, ARRAY(
                SELECT coalesce((SELECT m.to_scope FROM %3$s m
                                  WHERE pg_temp.qm_alias_scope(u.e) AND m.alias = pg_temp.qm_scope_alias(u.e) %5$s LIMIT 1), u.e)
                  FROM unnest(t.%2$I) WITH ORDINALITY u(e, n) ORDER BY u.n)
         FROM %1$I t
        WHERE %4$s AND EXISTS (SELECT 1 FROM unnest(t.%2$I) u(e) JOIN %3$s m
                                ON pg_temp.qm_alias_scope(u.e) AND m.alias = pg_temp.qm_scope_alias(u.e) %5$s)',
      w.tbl, w.col, moves, slice, same_tenant, tenant_of);
  ELSE
    EXECUTE format(
      'INSERT INTO qm_personal_scope_slice(row_id, tenant, to_scope)
       SELECT row_id, tenant, doc::text
         FROM (SELECT t.ctid AS row_id, %2$s AS tenant, pg_temp.qm_rekey_json(t.json, %2$s) AS doc FROM %1$I t
                WHERE %3$s AND t.json::text LIKE ''%%"personal:%%'') r
        WHERE doc IS NOT NULL',
      w.tbl, tenant_of, slice);
  END IF;
  IF bind THEN
    UPDATE qm_personal_scope_slice SET grp = tenant;
  END IF;

  FOR bound IN SELECT DISTINCT s.grp FROM qm_personal_scope_slice s LOOP
    IF bound IS NOT NULL THEN
      PERFORM set_config('qm.tenant_id', bound::text, true);
    END IF;
    BEGIN
      EXECUTE format(
        'WITH moved AS (UPDATE %1$I t SET %2$I = %3$s FROM qm_personal_scope_slice s
                         WHERE t.ctid = ANY(ARRAY(SELECT row_id FROM qm_personal_scope_slice WHERE grp IS NOT DISTINCT FROM $1))
                           AND s.row_id = t.ctid
                         RETURNING s.tenant)
         INSERT INTO qm_personal_scope_rekey_report SELECT %4$L, tenant, count(*), 0 FROM moved GROUP BY tenant',
        w.tbl, w.col,
        CASE w.kind WHEN 'json' THEN 's.to_scope::jsonb' WHEN 'array' THEN 's.to_array' ELSE 's.to_scope' END,
        w.tbl || CASE WHEN w.kind = 'json' THEN '.json' ELSE '' END) USING bound;
    EXCEPTION WHEN unique_violation THEN
      FOR hit IN SELECT s.row_id, s.tenant, s.to_scope FROM qm_personal_scope_slice s
                  WHERE s.grp IS NOT DISTINCT FROM bound ORDER BY s.row_id LOOP
        BEGIN
          EXECUTE format('UPDATE %I SET %I = $1 WHERE ctid = $2', w.tbl, w.col) USING hit.to_scope, hit.row_id;
          INSERT INTO qm_personal_scope_rekey_report VALUES (w.tbl, hit.tenant, 1, 0);
        EXCEPTION WHEN unique_violation THEN
          EXECUTE format('INSERT INTO qm_personal_scope_rekey_dropped SELECT %1$L, $2, to_jsonb(t) FROM %1$I t WHERE ctid = $1',
            w.tbl) USING hit.row_id, hit.tenant;
          EXECUTE format('DELETE FROM %I WHERE ctid = $1', w.tbl) USING hit.row_id;
          INSERT INTO qm_personal_scope_rekey_report VALUES (w.tbl, hit.tenant, 0, 1);
        END;
      END LOOP;
    END;
  END LOOP;
  UPDATE qm_personal_scope_rekey_work SET next_block = upto WHERE seq = w.seq;
  RETURN true;
END $step$;

SELECT pg_temp.qm_personal_scope_rekey_step(256) AS more;
