import { RETIRED_ORIGIN_KEYS } from "./origin-migration.ts";
import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

const OLD_DESTINATION_KEYS = "array['slackAccountId', 'slackTeamId', 'slackPolicyNamespace']";
const HELPERS = [
  `CREATE OR REPLACE FUNCTION pg_temp.qm_surface_account(d jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
      SELECT CASE
        WHEN jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT d ?| ${OLD_DESTINATION_KEYS} THEN d
        ELSE (d - 'slackAccountId' - 'slackTeamId' - 'slackPolicyNamespace') || CASE
          WHEN d ? 'account' THEN '{}'::jsonb
          ELSE jsonb_build_object('account', jsonb_strip_nulls(jsonb_build_object(
            'id', COALESCE(NULLIF(d ->> 'slackAccountId', ''), 'default'),
            'workspace', NULLIF(d ->> 'slackTeamId', ''),
            'policyNamespace', NULLIF(d ->> 'slackPolicyNamespace', ''))))
        END
      END $f$`,
  `CREATE OR REPLACE FUNCTION pg_temp.qm_surface_request(r jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $f$
      DECLARE
        s jsonb;
        e jsonb;
        src jsonb;
        out jsonb;
      BEGIN
        IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RETURN r; END IF;
        s := NULLIF(r -> 'slackSource', 'null'::jsonb);
        e := NULLIF(r -> 'externalSlack', 'null'::jsonb);
        src := COALESCE(s, e);
        out := r - 'slackSource' - 'externalSlack';
        IF jsonb_typeof(src) = 'object' AND NOT out ? 'surfaceOrigin' THEN
          out := out || jsonb_build_object('surfaceOrigin', jsonb_strip_nulls(jsonb_build_object(
            'author', jsonb_build_object('surface', 'slack', 'account', src -> 'accountId', 'id', src -> 'userId'),
            'workspace', src -> 'teamId',
            'policyNamespace', NULLIF(s ->> 'externalPolicyNamespace', ''),
            'replyThread', NULLIF(s ->> 'replyThreadTs', ''),
            'audience', CASE WHEN jsonb_typeof(e) = 'object' THEN 'external' ELSE 'internal' END,
            'access', CASE WHEN jsonb_typeof(e) = 'object' THEN jsonb_build_object(
              'companyDomains', e -> 'companyDomains',
              'companyTeamIds', e -> 'companyTeamIds',
              'serviceCredentials', e -> 'serviceCredentials') END)));
        END IF;
        IF jsonb_typeof(out -> 'triggerDestination') = 'object' THEN
          out := jsonb_set(out, '{triggerDestination}', pg_temp.qm_surface_account(out -> 'triggerDestination'));
        END IF;
        IF jsonb_typeof(out #> '{origin,destination}') = 'object' THEN
          out := jsonb_set(out, '{origin,destination}', pg_temp.qm_surface_account(out #> '{origin,destination}'));
        END IF;
        RETURN out;
      END $f$`,
  `CREATE OR REPLACE FUNCTION pg_temp.qm_jsonb_or_null(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $f$
      BEGIN
        RETURN t::jsonb;
      EXCEPTION WHEN invalid_text_representation OR untranslatable_character THEN
        RETURN NULL;
      END $f$`,
  `CREATE OR REPLACE FUNCTION pg_temp.qm_surface_request_text(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
      SELECT COALESCE(pg_temp.qm_surface_request(pg_temp.qm_jsonb_or_null(t))::text, t)
    $f$`,
];
const DROPS = [
  "DROP FUNCTION pg_temp.qm_surface_request_text(text)",
  "DROP FUNCTION pg_temp.qm_jsonb_or_null(text)",
  "DROP FUNCTION pg_temp.qm_surface_request(jsonb)",
  "DROP FUNCTION pg_temp.qm_surface_account(jsonb)",
];

const ORIGIN_HELPERS = [
  `CREATE OR REPLACE FUNCTION pg_temp.qm_truthy(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$
      SELECT v IS NOT NULL AND v NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
    $f$`,
  `CREATE OR REPLACE FUNCTION pg_temp.qm_ts(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
      SELECT CASE WHEN jsonb_typeof(v) = 'string' AND v #>> '{}' <> '' THEN v END
    $f$`,
  `CREATE OR REPLACE FUNCTION pg_temp.qm_origin_rank(o jsonb) RETURNS int LANGUAGE sql IMMUTABLE AS $f$
      SELECT CASE o ->> 'kind' WHEN 'direct' THEN 0 WHEN 'human' THEN 1 WHEN 'ambient' THEN 2 WHEN 'automation' THEN 3 END
    $f$`,
  `CREATE OR REPLACE FUNCTION pg_temp.qm_turn_origin_request(r jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $f$
      DECLARE
        typed jsonb;
        legacy jsonb;
        o jsonb;
        sd jsonb;
        v jsonb;
      BEGIN
        IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RETURN r; END IF;
        IF r -> 'triggered' = 'true' THEN
          legacy := jsonb_strip_nulls(jsonb_build_object(
            'kind', 'automation',
            'destination', CASE WHEN pg_temp.qm_truthy(r -> 'triggerDestination') THEN r -> 'triggerDestination' END,
            'useOwnerKeychain', CASE WHEN r -> 'ownerKeychainUnion' = 'true' THEN true END))
            || CASE WHEN r ? 'securityScreenData' THEN jsonb_build_object('screenData', r -> 'securityScreenData') ELSE '{}'::jsonb END;
        ELSIF r -> 'unprompted' = 'true' THEN
          legacy := jsonb_strip_nulls(jsonb_build_object(
            'kind', 'ambient',
            'entryTs', pg_temp.qm_ts(r -> 'entryTs'),
            'live', CASE WHEN r -> 'liveActor' = 'true' THEN true END));
        ELSIF r -> 'liveActor' = 'true' THEN
          legacy := jsonb_strip_nulls(jsonb_build_object(
            'kind', 'human',
            'messageTs', pg_temp.qm_ts(r -> 'triggerTs'),
            'entryTs', pg_temp.qm_ts(r -> 'entryTs')));
        ELSE
          legacy := '{"kind": "direct"}'::jsonb;
        END IF;
        typed := CASE WHEN jsonb_typeof(r -> 'origin') = 'object' THEN r -> 'origin' END;
        IF typed IS NULL THEN
          o := legacy;
        ELSIF legacy ->> 'kind' = 'direct' THEN
          o := typed;
        ELSIF pg_temp.qm_origin_rank(typed) IS DISTINCT FROM pg_temp.qm_origin_rank(legacy) THEN
          o := CASE WHEN pg_temp.qm_origin_rank(typed) > pg_temp.qm_origin_rank(legacy) THEN typed ELSE legacy END;
        ELSIF typed ->> 'kind' = 'automation' THEN
          sd := CASE WHEN typed ? 'screenData' THEN typed -> 'screenData' END;
          IF NOT typed ? 'screenData' THEN
            sd := legacy -> 'screenData';
          ELSIF legacy ? 'screenData' AND sd <> legacy -> 'screenData' THEN
            sd := to_jsonb(format(E'Typed automation data:\n%s\n\nLegacy automation data:\n%s',
              CASE WHEN jsonb_typeof(sd) = 'string' THEN sd #>> '{}' ELSE sd::text END,
              CASE WHEN jsonb_typeof(legacy -> 'screenData') = 'string' THEN legacy #>> '{screenData}' ELSE (legacy -> 'screenData')::text END));
          END IF;
          v := COALESCE(NULLIF(typed -> 'destination', 'null'), legacy -> 'destination');
          o := jsonb_build_object('kind', 'automation')
            || CASE WHEN typed ? 'screenData' OR legacy ? 'screenData' THEN jsonb_build_object('screenData', sd) ELSE '{}'::jsonb END
            || CASE WHEN pg_temp.qm_truthy(v) THEN jsonb_build_object('destination', v) ELSE '{}'::jsonb END
            || CASE WHEN pg_temp.qm_truthy(typed -> 'useOwnerKeychain') OR pg_temp.qm_truthy(legacy -> 'useOwnerKeychain')
                 THEN '{"useOwnerKeychain": true}'::jsonb ELSE '{}'::jsonb END;
        ELSIF typed ->> 'kind' = 'human' THEN
          v := COALESCE(NULLIF(typed -> 'messageTs', 'null'), legacy -> 'messageTs');
          o := jsonb_build_object('kind', 'human')
            || CASE WHEN pg_temp.qm_truthy(v) THEN jsonb_build_object('messageTs', v) ELSE '{}'::jsonb END;
          v := COALESCE(NULLIF(typed -> 'entryTs', 'null'), legacy -> 'entryTs');
          o := o || CASE WHEN pg_temp.qm_truthy(v) THEN jsonb_build_object('entryTs', v) ELSE '{}'::jsonb END;
        ELSIF typed ->> 'kind' = 'ambient' THEN
          v := COALESCE(NULLIF(typed -> 'entryTs', 'null'), legacy -> 'entryTs');
          o := jsonb_build_object('kind', 'ambient')
            || CASE WHEN pg_temp.qm_truthy(v) THEN jsonb_build_object('entryTs', v) ELSE '{}'::jsonb END
            || CASE WHEN typed -> 'live' = 'true' OR legacy -> 'live' = 'true' THEN '{"live": true}'::jsonb ELSE '{}'::jsonb END;
        ELSE
          o := typed;
        END IF;
        IF typed IS NULL THEN RETURN r || jsonb_build_object('origin', o); END IF;
        IF o = typed THEN RETURN r; END IF;
        RETURN (r - ${RETIRED_ORIGIN_KEYS.map((key) => `'${key}'`).join(" - ")}) || jsonb_build_object('origin', o);
      END $f$`,
  `CREATE OR REPLACE FUNCTION pg_temp.qm_turn_origin_request_text(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
      SELECT COALESCE(pg_temp.qm_turn_origin_request(pg_temp.qm_jsonb_or_null(t))::text, t)
    $f$`,
];
const ORIGIN_DROPS = [
  "DROP FUNCTION pg_temp.qm_turn_origin_request_text(text)",
  "DROP FUNCTION pg_temp.qm_turn_origin_request(jsonb)",
  "DROP FUNCTION pg_temp.qm_origin_rank(jsonb)",
  "DROP FUNCTION pg_temp.qm_ts(jsonb)",
  "DROP FUNCTION pg_temp.qm_truthy(jsonb)",
];

const requestTables: [string, string, string][] = [
  ["runs", "request", "text"],
  ["run_signals", "payload", "signals"],
  ["approvals", "json", "approval"],
];

const requestRewrite = (column: string) => `pg_temp.qm_turn_origin_request(pg_temp.qm_surface_request(${column}))`;
const requestUpdates = requestTables.map(([table, column, kind]) => {
  const json = kind === "text" ? `pg_temp.qm_jsonb_or_null(${column})` : column;
  let updated: string;
  if (kind === "text") updated = `${requestRewrite(json)}::text`;
  else if (kind === "approval")
    updated = `jsonb_set(${column}, '{request}', ${requestRewrite(`${column} -> 'request'`)})`;
  else
    updated = `${column}
      || CASE WHEN jsonb_typeof(${column} -> 'request') = 'object' THEN jsonb_build_object('request', ${requestRewrite(`${column} -> 'request'`)}) ELSE '{}'::jsonb END
      || CASE WHEN jsonb_typeof(${column} -> 'sessionRequest') = 'object' THEN jsonb_build_object('sessionRequest', ${requestRewrite(`${column} -> 'sessionRequest'`)}) ELSE '{}'::jsonb END`;
  const eligible =
    kind === "approval" ? `jsonb_typeof(${column} -> 'request') = 'object'` : `jsonb_typeof(${json}) = 'object'`;
  const idType = table === "run_signals" ? "bigint" : "text";
  return `DO $upgrade$ DECLARE after_id ${idType}; batch_ids ${idType}[]; BEGIN
    IF to_regclass('${table}') IS NULL THEN RETURN; END IF;
    LOOP
      SELECT array_agg(id ORDER BY id) INTO batch_ids FROM
        (SELECT id FROM ${table} WHERE after_id IS NULL OR id > after_id ORDER BY id LIMIT 1000) page;
      EXIT WHEN batch_ids IS NULL;
      UPDATE ${table} SET ${column} = ${updated}
        WHERE id = ANY(batch_ids) AND ${eligible} AND ${updated} IS DISTINCT FROM ${column};
      after_id := batch_ids[cardinality(batch_ids)];
      COMMIT;
    END LOOP;
  END $upgrade$`;
});

const oldKeysIn = (text: string) =>
  `(${["slackSource", "externalSlack", "slackAccountId", "slackTeamId", "slackPolicyNamespace"].map((key) => `${text} LIKE '%"${key}"%'`).join(" OR ")})`;
const SESSION_PAGE = 2000;
const oldBinding = "(jsonb_typeof(s.slack_binding) = 'object' AND s.slack_binding ? 'teamId')";
const bindingAsSource = `CASE
  WHEN ${oldBinding} THEN s.slack_binding
  WHEN jsonb_typeof(s.slack_binding -> 'author') = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
    'accountId', s.slack_binding -> 'author' -> 'account', 'teamId', s.slack_binding -> 'workspace',
    'userId', s.slack_binding -> 'author' -> 'id', 'externalPolicyNamespace', s.slack_binding -> 'policyNamespace',
    'replyThreadTs', s.slack_binding -> 'replyThread'))
END`;
const SESSION_ORIGIN_UPGRADE = `DO $upgrade$ DECLARE after_id text := ''; BEGIN
 LOOP
WITH page AS (
     SELECT s.id FROM sessions s WHERE s.id > after_id AND (${oldKeysIn("s.spawn_meta")} OR ${oldBinding})
     ORDER BY s.id LIMIT ${SESSION_PAGE}
   ), rewritten AS (
     UPDATE sessions s SET
       spawn_meta = CASE WHEN ${oldKeysIn("s.spawn_meta")} AND jsonb_typeof(pg_temp.qm_jsonb_or_null(s.spawn_meta)) = 'object'
         THEN pg_temp.qm_surface_request(pg_temp.qm_jsonb_or_null(s.spawn_meta) || CASE
           WHEN s.spawn_meta LIKE '%"externalSlack"%' AND s.spawn_meta NOT LIKE '%"slackSource"%' AND ${bindingAsSource} IS NOT NULL
           THEN jsonb_build_object('slackSource', ${bindingAsSource}) ELSE '{}'::jsonb END)::text
         ELSE s.spawn_meta END,
       slack_binding = CASE WHEN ${oldBinding}
         THEN pg_temp.qm_surface_request(jsonb_build_object('slackSource', s.slack_binding)) -> 'surfaceOrigin'
         ELSE s.slack_binding END
     FROM page WHERE s.id = page.id
   )
   SELECT max(id) INTO after_id FROM page;
 COMMIT;
 EXIT WHEN after_id IS NULL;
 END LOOP;
END $upgrade$`;

const destinationFields: [string, string][] = [
  ["deliveries", "destination"],
  ["crons", "json"],
  ["loops", "json"],
  ["webhooks", "json"],
  ["monitors", "json"],
  ["secret_drops", "json"],
  ["keychain_asks", "json"],
];

export const PUBLISHED_ORIGIN_UPGRADE: PgMigrationDefinition = {
  id: "surfaces/0003-published-release-upgrade",
  upgradeFrom: "sessions/store/0033-client-tools",
  autocommit: true,
  statements: [
    ...HELPERS,
    ...ORIGIN_HELPERS,
    ...requestUpdates,
    SESSION_ORIGIN_UPGRADE,
    ...destinationFields.map(([table, column]) => {
      const field = table === "keychain_asks" ? "requesterDestination" : "destination";
      const value = column === "json" ? `${column} -> '${field}'` : column;
      const updated =
        column === "json"
          ? `jsonb_set(${column}, '{${field}}', pg_temp.qm_surface_account(${value}))`
          : `pg_temp.qm_surface_account(${value})`;
      return `DO $upgrade$ BEGIN
        IF to_regclass('${table}') IS NOT NULL THEN
          UPDATE ${table} SET ${column} = ${updated} WHERE jsonb_typeof(${value}) = 'object' AND (${value}) ?| ${OLD_DESTINATION_KEYS};
        END IF;
      END $upgrade$`;
    }),
    `UPDATE sessions SET slack_binding = pg_temp.qm_surface_request(jsonb_build_object('slackSource', slack_binding)) -> 'surfaceOrigin'
      WHERE jsonb_typeof(slack_binding) = 'object' AND slack_binding ? 'teamId'`,
    `DO $$ BEGIN IF to_regclass('surface_origin_settled_candidates') IS NOT NULL THEN DELETE FROM surface_origin_settled_candidates; END IF; END $$`,
    ...ORIGIN_DROPS,
    ...DROPS,
  ],
};

export const PUBLISHED_ORIGIN_COMPLETE: PgMigrationDefinition = {
  id: "surfaces/0004-settled-runs-rewrite",
  upgradeFrom: "sessions/store/0033-client-tools",
  statements: [
    "SELECT pg_advisory_xact_lock(hashtext('qm:surface-origin-rewrite'))",
    "DO $$ BEGIN IF to_regclass('surface_origin_settled_candidates') IS NOT NULL THEN IF EXISTS (SELECT 1 FROM surface_origin_settled_candidates) THEN RAISE EXCEPTION 'settled run candidates remain'; END IF; END IF; END $$",
    "DROP TABLE IF EXISTS surface_origin_settled_candidates",
    "DROP TABLE IF EXISTS surface_origin_settled_collected",
  ],
  expectedChecksum: "7c872adade650af67e840f2ce8c6655dcdb766d7857969cda344d76d03e8c838",
};
