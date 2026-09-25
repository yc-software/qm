import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const legacyCronGrantsMigration: PgMigrationDefinition = {
  id: "keychain/legacy-cron-grants/0001",
  statements: [
    "LOCK TABLE durable_map_versions, keychain_grants, keychain_asks IN SHARE ROW EXCLUSIVE MODE",
    `WITH identities AS (
      SELECT json ->> 'owner' AS id FROM crons
      UNION SELECT substring(json ->> 'ownerScopeId' FROM 10) FROM crons
      UNION SELECT json ->> 'ownerId' FROM keychain_credentials
      UNION SELECT substring(json ->> 'audienceScopeId' FROM 10) FROM keychain_grants
      UNION SELECT substring(json ->> 'requesterScopeId' FROM 10) FROM keychain_asks
      UNION SELECT json ->> 'principalId' FROM deactivated_principals
      UNION SELECT json ->> 'email' FROM external_members
      UNION SELECT unnest($1::text[])
    ), canonical AS (
      SELECT identities.id, coalesce(link.json ->> 'canonicalId', identities.id) AS principal
      FROM identities LEFT JOIN principal_links link ON link.id =
        CASE WHEN position('@' IN identities.id) > 0 THEN lower(btrim(identities.id)) ELSE btrim(identities.id) END
      WHERE btrim(identities.id) <> ''
    ), people AS (
      SELECT id, principal,
        CASE WHEN position('@' IN principal) > 0 THEN lower(btrim(principal)) ELSE btrim(principal) END AS person
      FROM canonical
    ), external_people AS (
      SELECT DISTINCT ON (member.person) member.person, external.json
      FROM external_members external JOIN people member ON member.id = external.json ->> 'email'
      ORDER BY member.person, external.id DESC
    ), inactive_people AS (
      SELECT DISTINCT ON (member.person) member.person, inactive.json ->> 'source' AS source
      FROM deactivated_principals inactive JOIN people member ON member.id = inactive.json ->> 'principalId'
      ORDER BY member.person, CASE WHEN inactive.json ->> 'source' = 'manual' THEN 1 ELSE 0 END DESC, inactive.id DESC
    ), owners AS (
      SELECT DISTINCT owner.principal, owner.person
      FROM crons cron
      JOIN people owner ON owner.id = cron.json ->> 'owner'
      JOIN people home ON home.id = substring(cron.json ->> 'ownerScopeId' FROM 10)
      LEFT JOIN external_people external ON external.person = owner.person
      LEFT JOIN inactive_people inactive ON inactive.person = owner.person
      WHERE cron.json ->> 'ownerScopeId' LIKE 'personal:%'
        AND home.person = owner.person
        AND coalesce(cron.json ->> 'runAs', 'owner') = 'owner'
        AND (cron.json ->> 'createdAt')::numeric < 1790142489000
        AND coalesce((cron.json ->> 'archived')::boolean, false) = false
        AND (cron.json ->> 'enabled' = 'true' OR cron.json #>> '{schedule,everyMs}' IS NOT NULL
          OR cron.json #>> '{schedule,cron}' IS NOT NULL OR cron.json ->> 'lastFiredAt' IS NULL)
        AND cron.json ->> 'message' IS NULL
        AND btrim(cron.json ->> 'action') <> ''
        AND (
          EXISTS (
            SELECT 1 FROM internal_member_overrides overrides WHERE overrides.id = $2
              AND coalesce(overrides.json -> 'members', '[]'::jsonb) ? lower(btrim(owner.id))
          ) OR (
            inactive.source IS DISTINCT FROM 'manual'
            AND (
              inactive.source IS DISTINCT FROM 'directory-sync' OR external.person IS NOT NULL
              OR EXISTS (SELECT 1 FROM people protected WHERE protected.id = ANY($1::text[]) AND protected.person = owner.person)
            )
            AND (external.person IS NULL OR (
              (external.json ->> 'kind' = 'teammate' AND external.json ->> 'expiresAt' IS NULL)
              OR (external.json ->> 'expiresAt')::numeric > extract(epoch FROM now()) * 1000
            ) IS TRUE)
          )
        )
    ), available AS (
      SELECT DISTINCT credential.id AS credential_id, credential.json, 'personal:' || owner.principal AS scope,
        owner.person, slot.priority
      FROM owners owner
      JOIN people holder ON holder.person = owner.person
      JOIN keychain_credentials credential ON credential.json ->> 'ownerId' = holder.id
      LEFT JOIN LATERAL (
        SELECT priority FROM (VALUES ('personal', 0), ('', 1), ('company', 2)) accounts(name, priority)
        WHERE credential.id = left(encode(sha256(
          convert_to(owner.principal, 'UTF8') || decode('00', 'hex') ||
          convert_to(credential.json ->> 'host', 'UTF8') || decode('00', 'hex') ||
          convert_to('oauth:' || accounts.name, 'UTF8')
        ), 'hex'), 16)
      ) slot ON true
      WHERE credential.json ->> 'kind' = 'env'
        AND (credential.json ->> 'createdAt')::numeric < 1790142489000
        AND coalesce(credential.json ->> 'envKey', '') <> 'COMPOSIO_API_KEY'
        AND NOT coalesce(credential.json -> 'fields', '[]'::jsonb) @> '[{"envKey":"COMPOSIO_API_KEY"}]'::jsonb
        AND (
          credential.json ->> 'managed' IS NULL
          OR (credential.json ->> 'managed' = 'connector' AND holder.id = owner.principal
            AND slot.priority IS NOT NULL
            AND credential.json ->> 'host' IN (
            'gmail.googleapis.com', 'www.googleapis.com', 'sheets.googleapis.com', 'docs.googleapis.com',
            'slides.googleapis.com', 'slack.com', 'api.notion.com', 'api.linear.app', 'api.dropboxapi.com',
            'content.dropboxapi.com', 'api.github.com', 'api.x.com'
          ))
        )
        AND (
          credential.json ->> 'expiresAt' IS NULL
          OR (credential.json ->> 'expiresAt')::numeric > extract(epoch FROM now()) * 1000
            + CASE WHEN credential.json ->> 'managed' = 'connector' THEN 60000 ELSE 0 END
          OR (credential.json ->> 'managed' = 'connector' AND coalesce(credential.json #>> '{refresh,refreshTokenEnc}', '') <> '')
        )
    ), preferred AS (
      SELECT *, row_number() OVER (
        PARTITION BY scope, CASE WHEN json ->> 'managed' = 'connector' THEN json ->> 'host' ELSE credential_id END
        ORDER BY priority NULLS LAST, credential_id
      ) AS preference FROM available
    ), candidates AS (
      SELECT credential_id, json, scope FROM preferred
      WHERE preference = 1
        AND NOT EXISTS (
          SELECT 1 FROM keychain_grants grant_row
          JOIN people audience ON audience.id = substring(grant_row.json ->> 'audienceScopeId' FROM 10)
          WHERE grant_row.json ->> 'credentialId' = preferred.credential_id
            AND grant_row.json ->> 'audienceScopeId' LIKE 'personal:%' AND audience.person = preferred.person
        )
        AND NOT EXISTS (
          SELECT 1 FROM keychain_asks ask
          JOIN people audience ON audience.id = substring(ask.json ->> 'requesterScopeId' FROM 10)
          WHERE ask.json ->> 'credentialId' = preferred.credential_id AND ask.json ->> 'status' = 'declined'
            AND ask.json ->> 'requesterScopeId' LIKE 'personal:%' AND audience.person = preferred.person
        )
    ), inserted AS (
      INSERT INTO keychain_grants(id, json)
      SELECT md5('legacy-cron-grants:' || jsonb_build_array(credential_id, scope)::text), jsonb_strip_nulls(jsonb_build_object(
        'id', md5('legacy-cron-grants:' || jsonb_build_array(credential_id, scope)::text),
        'credentialId', credential_id, 'ownerId', json ->> 'ownerId', 'orgId', json ->> 'orgId',
        'audienceScopeId', scope, 'mode', 'standing', 'status', 'active',
        'purpose', 'Preserve legacy personal cron access to existing owner credentials',
        'createdAt', floor(extract(epoch FROM now()) * 1000)
      )) FROM candidates ON CONFLICT (id) DO NOTHING RETURNING id
    )
    INSERT INTO durable_map_versions(tbl, v)
    SELECT 'keychain_grants', 1 WHERE EXISTS (SELECT 1 FROM inserted)
    ON CONFLICT (tbl) DO UPDATE SET v = durable_map_versions.v + 1`,
  ],
};
