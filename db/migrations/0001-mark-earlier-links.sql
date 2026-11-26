DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = 'users/v2/0012-mark-earlier-links') THEN
    RETURN;
  END IF;
  IF to_regclass('users') IS NULL OR to_regclass('user_links') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('crons') IS NOT NULL THEN
    UPDATE crons t SET json = t.json || '{"botActor": true}'::jsonb
      FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
     WHERE u.kind = 'app' AND l.tenant_id = t.tenant_id
       AND u.id = ANY(ARRAY(
         SELECT l.user_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
          WHERE u.kind = 'app' AND l.alias_id <> u.primary_alias
       ))
       AND l.alias_id = CASE WHEN position('@' IN btrim(t.json ->> 'createdBy')) > 0 THEN lower(btrim(t.json ->> 'createdBy')) ELSE btrim(t.json ->> 'createdBy') END
       AND NOT t.json ? 'botActor'
       AND NOT EXISTS (
         SELECT 1 FROM directory_members m WHERE m.tenant_id = l.tenant_id AND m.is_bot IS FALSE
            AND CASE WHEN position('@' IN btrim(m.principal_id)) > 0 THEN lower(btrim(m.principal_id)) ELSE btrim(m.principal_id) END = l.alias_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM directory_members m WHERE m.tenant_id = l.tenant_id AND m.is_bot IS FALSE
            AND m.slack_id = l.alias_id
       );
    IF FOUND THEN
      UPDATE durable_map_versions SET v = v + 1
       WHERE tbl = 'crons' AND tenant_id IN (
         SELECT tenant_id FROM users WHERE id = ANY(ARRAY(
           SELECT l.user_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
            WHERE u.kind = 'app' AND l.alias_id <> u.primary_alias
         ))
       );
    END IF;
  END IF;
  IF to_regclass('loops') IS NOT NULL THEN
    UPDATE loops t SET json = t.json || '{"botActor": true}'::jsonb
      FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
     WHERE u.kind = 'app' AND l.tenant_id = t.tenant_id
       AND u.id = ANY(ARRAY(
         SELECT l.user_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
          WHERE u.kind = 'app' AND l.alias_id <> u.primary_alias
       ))
       AND l.alias_id = CASE WHEN position('@' IN btrim(t.json ->> 'createdBy')) > 0 THEN lower(btrim(t.json ->> 'createdBy')) ELSE btrim(t.json ->> 'createdBy') END
       AND NOT t.json ? 'botActor'
       AND NOT EXISTS (
         SELECT 1 FROM directory_members m WHERE m.tenant_id = l.tenant_id AND m.is_bot IS FALSE
            AND CASE WHEN position('@' IN btrim(m.principal_id)) > 0 THEN lower(btrim(m.principal_id)) ELSE btrim(m.principal_id) END = l.alias_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM directory_members m WHERE m.tenant_id = l.tenant_id AND m.is_bot IS FALSE
            AND m.slack_id = l.alias_id
       );
    IF FOUND THEN
      UPDATE durable_map_versions SET v = v + 1
       WHERE tbl = 'loops' AND tenant_id IN (
         SELECT tenant_id FROM users WHERE id = ANY(ARRAY(
           SELECT l.user_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
            WHERE u.kind = 'app' AND l.alias_id <> u.primary_alias
         ))
       );
    END IF;
  END IF;
  IF to_regclass('monitors') IS NOT NULL THEN
    UPDATE monitors t SET json = t.json || '{"botActor": true}'::jsonb
      FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
     WHERE u.kind = 'app' AND l.tenant_id = t.tenant_id
       AND u.id = ANY(ARRAY(
         SELECT l.user_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
          WHERE u.kind = 'app' AND l.alias_id <> u.primary_alias
       ))
       AND l.alias_id = CASE WHEN position('@' IN btrim(t.json ->> 'createdBy')) > 0 THEN lower(btrim(t.json ->> 'createdBy')) ELSE btrim(t.json ->> 'createdBy') END
       AND NOT t.json ? 'botActor'
       AND NOT EXISTS (
         SELECT 1 FROM directory_members m WHERE m.tenant_id = l.tenant_id AND m.is_bot IS FALSE
            AND CASE WHEN position('@' IN btrim(m.principal_id)) > 0 THEN lower(btrim(m.principal_id)) ELSE btrim(m.principal_id) END = l.alias_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM directory_members m WHERE m.tenant_id = l.tenant_id AND m.is_bot IS FALSE
            AND m.slack_id = l.alias_id
       );
    IF FOUND THEN
      UPDATE durable_map_versions SET v = v + 1
       WHERE tbl = 'monitors' AND tenant_id IN (
         SELECT tenant_id FROM users WHERE id = ANY(ARRAY(
           SELECT l.user_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
            WHERE u.kind = 'app' AND l.alias_id <> u.primary_alias
         ))
       );
    END IF;
  END IF;
  IF to_regclass('keychain_asks') IS NOT NULL THEN
    UPDATE keychain_asks t SET json = t.json || '{"botActor": true}'::jsonb
      FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
     WHERE u.kind = 'app' AND l.tenant_id = t.tenant_id
       AND u.id = ANY(ARRAY(
         SELECT l.user_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
          WHERE u.kind = 'app' AND l.alias_id <> u.primary_alias
       ))
       AND l.alias_id = CASE WHEN position('@' IN btrim(t.json ->> 'requesterId')) > 0 THEN lower(btrim(t.json ->> 'requesterId')) ELSE btrim(t.json ->> 'requesterId') END
       AND NOT t.json ? 'botActor'
       AND NOT EXISTS (
         SELECT 1 FROM directory_members m WHERE m.tenant_id = l.tenant_id AND m.is_bot IS FALSE
            AND CASE WHEN position('@' IN btrim(m.principal_id)) > 0 THEN lower(btrim(m.principal_id)) ELSE btrim(m.principal_id) END = l.alias_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM directory_members m WHERE m.tenant_id = l.tenant_id AND m.is_bot IS FALSE
            AND m.slack_id = l.alias_id
       );
    IF FOUND THEN
      UPDATE durable_map_versions SET v = v + 1
       WHERE tbl = 'keychain_asks' AND tenant_id IN (
         SELECT tenant_id FROM users WHERE id = ANY(ARRAY(
           SELECT l.user_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
            WHERE u.kind = 'app' AND l.alias_id <> u.primary_alias
         ))
       );
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = 'users/v2/0012-mark-earlier-links') THEN
    RETURN;
  END IF;
  IF to_regclass('users') IS NULL OR to_regclass('user_links') IS NULL OR to_regclass('loops') IS NULL
     OR to_regclass('loop_ship_grants') IS NULL OR to_regclass('audit_log') IS NULL THEN
    RETURN;
  END IF;
  WITH granted AS (
    SELECT g.tenant_id, g.id, l.json ->> 'ownerScopeId' AS scope, l.id AS loop_id
      FROM loop_ship_grants g
      JOIN loops l ON l.tenant_id = g.tenant_id AND l.id = g.json ->> 'loopId'
     WHERE NOT g.json ? 'revokedAt'
       AND EXISTS (
         SELECT 1 FROM user_links k JOIN users u ON u.tenant_id = k.tenant_id AND u.id = k.user_id
          WHERE u.kind = 'app' AND k.tenant_id = g.tenant_id
            AND k.alias_id = CASE WHEN position('@' IN btrim(g.json ->> 'actorId')) > 0 THEN lower(btrim(g.json ->> 'actorId')) ELSE btrim(g.json ->> 'actorId') END
            AND u.id = ANY(ARRAY(
              SELECT l.user_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
               WHERE u.kind = 'app' AND l.alias_id <> u.primary_alias
            ))
            AND NOT EXISTS (
              SELECT 1 FROM directory_members m WHERE m.tenant_id = k.tenant_id AND m.is_bot IS FALSE
                 AND CASE WHEN position('@' IN btrim(m.principal_id)) > 0 THEN lower(btrim(m.principal_id)) ELSE btrim(m.principal_id) END = k.alias_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM directory_members m WHERE m.tenant_id = k.tenant_id AND m.is_bot IS FALSE
                 AND m.slack_id = k.alias_id
            )
       )
  ), locked AS (
    SELECT l.tenant_id, l.id, l.json FROM loops l
     WHERE l.json @> '{"botActor": true}' AND l.json -> 'shipActions' @> '[{"gate": "auto"}]'
       AND EXISTS (
         SELECT 1 FROM user_links k
          WHERE k.tenant_id = l.tenant_id
            AND k.user_id = ANY(ARRAY(
              SELECT l.user_id FROM user_links l JOIN users u ON u.tenant_id = l.tenant_id AND u.id = l.user_id
               WHERE u.kind = 'app' AND l.alias_id <> u.primary_alias
            ))
            AND k.alias_id = CASE WHEN position('@' IN btrim(l.json ->> 'createdBy')) > 0 THEN lower(btrim(l.json ->> 'createdBy')) ELSE btrim(l.json ->> 'createdBy') END
            AND NOT EXISTS (
              SELECT 1 FROM directory_members m WHERE m.tenant_id = k.tenant_id AND m.is_bot IS FALSE
                 AND CASE WHEN position('@' IN btrim(m.principal_id)) > 0 THEN lower(btrim(m.principal_id)) ELSE btrim(m.principal_id) END = k.alias_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM directory_members m WHERE m.tenant_id = k.tenant_id AND m.is_bot IS FALSE
                 AND m.slack_id = k.alias_id
            )
       )
       FOR UPDATE
  ), gated AS (
    SELECT l.tenant_id, l.id, any_value(l.json ->> 'ownerScopeId') AS scope,
           jsonb_agg(p ->> 'action' ORDER BY n) FILTER (WHERE p ->> 'gate' = 'auto') AS actions,
           jsonb_agg(CASE WHEN p ->> 'gate' = 'auto' THEN p || '{"gate": "hold"}'::jsonb ELSE p END ORDER BY n)
             AS ship_actions
      FROM locked l
      CROSS JOIN LATERAL jsonb_array_elements(l.json -> 'shipActions') WITH ORDINALITY AS a(p, n)
     GROUP BY l.tenant_id, l.id
  ), held AS (
    UPDATE loops l SET json = l.json || jsonb_build_object('shipActions', g.ship_actions)
      FROM gated g WHERE l.tenant_id = g.tenant_id AND l.id = g.id
    RETURNING l.tenant_id
  ), revoked AS (
    UPDATE loop_ship_grants g
       SET json = g.json || jsonb_build_object('revokedAt', (EXTRACT(EPOCH FROM now()) * 1000)::bigint, 'revokedBy', 'system:migration')
      FROM granted x WHERE g.tenant_id = x.tenant_id AND g.id = x.id
    RETURNING g.tenant_id
  ), versions AS (
    UPDATE durable_map_versions SET v = v + 1
     WHERE tbl = 'loops' AND tenant_id IN (SELECT tenant_id FROM held)
        OR tbl = 'loop_ship_grants' AND tenant_id IN (SELECT tenant_id FROM revoked)
  )
  INSERT INTO audit_log (tenant_id, at, principal_id, action, resource, scope_label, detail)
  SELECT tenant_id, (EXTRACT(EPOCH FROM now()) * 1000)::bigint, 'system:migration', action, id, scope, detail::text
    FROM (
      SELECT tenant_id, 'loop_update' AS action, id, scope, jsonb_build_object('heldShipActions', actions) AS detail
        FROM gated
      UNION ALL
      SELECT tenant_id, 'ship_grant_revoke', id, scope, jsonb_build_object('loopId', loop_id) FROM granted
    ) entries;
END $$;
