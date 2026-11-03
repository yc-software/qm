import { withPgTransaction, type PgPool } from "../persistence/pg-pool.ts";
import { errMessage } from "../util/errors.ts";

const DESTINATION_FIELDS: [table: string, field: string][] = [
  ["crons", "destination"],
  ["loops", "destination"],
  ["webhooks", "destination"],
  ["monitors", "destination"],
  ["secret_drops", "destination"],
  ["keychain_asks", "requesterDestination"],
];
const OLD_DESTINATION_KEYS = "array['slackAccountId', 'slackTeamId', 'slackPolicyNamespace']";
const RECENTLY_FINISHED_MS = 24 * 60 * 60_000;
const oldKeysIn = (text: string) =>
  `(${["slackSource", "externalSlack", "slackAccountId", "slackTeamId", "slackPolicyNamespace"]
    .map((key) => `${text} LIKE '%"${key}"%'`)
    .join(" OR ")})`;
const ifTable = (table: string, statement: string) =>
  `DO $$ BEGIN IF to_regclass('${table}') IS NOT NULL THEN ${statement}; END IF; END $$`;
const newerRun = (extra = "") =>
  `NOT EXISTS (SELECT 1 FROM runs n WHERE n.session_id = r.session_id AND (n.created_at, n.seq) > (r.created_at, r.seq)${extra})`;

const HELPERS = [
  `CREATE FUNCTION pg_temp.qm_surface_account(d jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
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
  `CREATE FUNCTION pg_temp.qm_surface_request(r jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $f$
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
  `CREATE FUNCTION pg_temp.qm_jsonb_or_null(t text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $f$
      BEGIN
        RETURN t::jsonb;
      EXCEPTION WHEN invalid_text_representation OR untranslatable_character THEN
        RETURN NULL;
      END $f$`,
  `CREATE FUNCTION pg_temp.qm_surface_request_text(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
      SELECT COALESCE(pg_temp.qm_surface_request(pg_temp.qm_jsonb_or_null(t))::text, t)
    $f$`,
];
const DROPS = [
  "DROP FUNCTION pg_temp.qm_surface_request_text(text)",
  "DROP FUNCTION pg_temp.qm_jsonb_or_null(text)",
  "DROP FUNCTION pg_temp.qm_surface_request(jsonb)",
  "DROP FUNCTION pg_temp.qm_surface_account(jsonb)",
];

const migration = (id: string, statements: string[]) => ({
  id,
  statements: [`SET LOCAL lock_timeout = '3s'`, ...HELPERS, ...statements, ...DROPS],
});

export const LEGACY_ORIGIN_KEYS = [
  "triggered",
  "unprompted",
  "liveActor",
  "triggerTs",
  "entryTs",
  "securityScreenData",
  "triggerDestination",
  "ownerKeychainUnion",
] as const;
const ORIGIN_HELPERS = [
  `CREATE FUNCTION pg_temp.qm_truthy(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$
      SELECT v IS NOT NULL AND v NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb)
    $f$`,
  `CREATE FUNCTION pg_temp.qm_ts(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
      SELECT CASE WHEN jsonb_typeof(v) = 'string' AND v #>> '{}' <> '' THEN v END
    $f$`,
  `CREATE FUNCTION pg_temp.qm_origin_rank(o jsonb) RETURNS int LANGUAGE sql IMMUTABLE AS $f$
      SELECT CASE o ->> 'kind' WHEN 'direct' THEN 0 WHEN 'human' THEN 1 WHEN 'ambient' THEN 2 WHEN 'automation' THEN 3 END
    $f$`,
  `CREATE FUNCTION pg_temp.qm_turn_origin_request(r jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $f$
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
        RETURN (r - ${LEGACY_ORIGIN_KEYS.map((key) => `'${key}'`).join(" - ")}) || jsonb_build_object('origin', o);
      END $f$`,
  `CREATE FUNCTION pg_temp.qm_turn_origin_request_text(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
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
const originChanges = (json: string) => `pg_temp.qm_turn_origin_request(${json}) IS DISTINCT FROM ${json}`;
const runOriginChanges = (alias: string) => originChanges(`pg_temp.qm_jsonb_or_null(${alias}.request)`);
const originMigration = (id: string, statements: string[]) => ({
  id,
  statements: [
    `SET LOCAL lock_timeout = '3s'`,
    ...HELPERS,
    ...ORIGIN_HELPERS,
    ...statements,
    ...ORIGIN_DROPS,
    ...DROPS,
  ],
});

const LIVE_ORIGIN_REWRITES = [
  migration("surface-origin-rewrite/live-runs-and-destinations", [
    ifTable(
      "runs",
      `UPDATE runs r SET request = pg_temp.qm_surface_request_text(r.request)
       WHERE r.status IN ('pending', 'running') AND ${oldKeysIn("r.request")}`,
    ),
    ifTable(
      "runs",
      `UPDATE runs r SET request = pg_temp.qm_surface_request_text(r.request)
       WHERE r.status IN ('done', 'failed')
         AND r.finished_at >= (extract(epoch FROM clock_timestamp()) * 1000)::bigint - ${RECENTLY_FINISHED_MS}
         AND ${oldKeysIn("r.request")}`,
    ),
    ifTable(
      "run_signals",
      `UPDATE run_signals SET payload = payload
         || CASE WHEN payload ? 'request' THEN jsonb_build_object('request', pg_temp.qm_surface_request(payload -> 'request')) ELSE '{}'::jsonb END
         || CASE WHEN payload ? 'sessionRequest' THEN jsonb_build_object('sessionRequest', pg_temp.qm_surface_request(payload -> 'sessionRequest')) ELSE '{}'::jsonb END
       WHERE consumed_at IS NULL AND jsonb_typeof(payload) = 'object' AND ${oldKeysIn("payload::text")}`,
    ),
    ifTable(
      "deliveries",
      `UPDATE deliveries SET destination = pg_temp.qm_surface_account(destination)
       WHERE delivered_at IS NULL AND expired_at IS NULL AND jsonb_typeof(destination) = 'object' AND destination ?| ${OLD_DESTINATION_KEYS}`,
    ),
    ifTable(
      "approvals",
      `UPDATE approvals SET json = jsonb_set(json, '{request}', pg_temp.qm_surface_request(json -> 'request'))
       WHERE jsonb_typeof(json -> 'request') = 'object' AND ${oldKeysIn("(json -> 'request')::text")}`,
    ),
    ...DESTINATION_FIELDS.map(([table, field]) =>
      ifTable(
        table,
        `UPDATE ${table} SET json = jsonb_set(json, '{${field}}', pg_temp.qm_surface_account(json -> '${field}'))
         WHERE jsonb_typeof(json -> '${field}') = 'object' AND (json -> '${field}') ?| ${OLD_DESTINATION_KEYS}`,
      ),
    ),
  ]),
  migration("surface-origin-rewrite/spawn-meta", [
    ifTable(
      "sessions",
      `UPDATE sessions SET spawn_meta = pg_temp.qm_surface_request_text(spawn_meta) WHERE ${oldKeysIn("spawn_meta")}`,
    ),
  ]),
];

const SETTLED_CANDIDATES = "surface_origin_settled_candidates";
const SETTLED_COLLECTED = "surface_origin_settled_collected";

export const SETTLED_CANDIDATES_MIGRATION = migration("surfaces/0003-settled-run-candidates", [
  `CREATE TABLE IF NOT EXISTS ${SETTLED_CANDIDATES} (id TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS ${SETTLED_COLLECTED} (collected_at BIGINT NOT NULL)`,
  `INSERT INTO ${SETTLED_COLLECTED} (collected_at)
     SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint
     WHERE NOT EXISTS (SELECT 1 FROM ${SETTLED_COLLECTED})`,
  ifTable(
    "runs",
    `INSERT INTO ${SETTLED_CANDIDATES} (id) SELECT r.id FROM runs r
       WHERE r.status IN ('done', 'failed')
         AND ${oldKeysIn("r.request")}
         AND (r.request LIKE '%"externalSlack"%'
           OR ${newerRun()}
           OR ${newerRun(` AND (n.request NOT LIKE '%"privateSessionMessage"%' OR COALESCE(pg_temp.qm_jsonb_or_null(n.request) ->> 'privateSessionMessage', 'false') <> 'true')`)})
       ON CONFLICT DO NOTHING`,
  ),
]);

export const SETTLED_ORIGIN_MIGRATION = {
  ...migration("surfaces/0004-settled-runs-rewrite", [
    `SET LOCAL enable_seqscan = off`,
    ifTable(
      SETTLED_COLLECTED,
      `INSERT INTO ${SETTLED_CANDIDATES} (id) SELECT r.id FROM runs r
         WHERE r.status IN ('done', 'failed')
           AND r.finished_at >= (SELECT min(collected_at) FROM ${SETTLED_COLLECTED})
           AND ${oldKeysIn("r.request")}
         ON CONFLICT DO NOTHING`,
    ),
    ifTable(
      SETTLED_CANDIDATES,
      `UPDATE runs r SET request = pg_temp.qm_surface_request_text(r.request)
         WHERE r.id = ANY (ARRAY(SELECT id FROM ${SETTLED_CANDIDATES})) AND ${oldKeysIn("r.request")}`,
    ),
    `DROP TABLE IF EXISTS ${SETTLED_CANDIDATES}`,
    `DROP TABLE IF EXISTS ${SETTLED_COLLECTED}`,
  ]),
  expectedChecksum: "869952729700ecff8669586f8144812079290f6f0609397b5a3d1ad7674d56d0",
};

const rewriteRuns = (rows: string) =>
  ifTable(
    "runs",
    `UPDATE runs r SET request = pg_temp.qm_turn_origin_request_text(r.request) WHERE ${rows} AND ${runOriginChanges("r")}`,
  );
const LIVE_RUNS = "(r.status IN ('pending', 'running') OR r.finished_at >= (extract(epoch FROM now()) * 1000)::bigint)";
const REPLAYABLE_ORIGIN_REWRITES = [
  ifTable(
    "run_signals",
    `UPDATE run_signals SET payload = payload
       || CASE WHEN jsonb_typeof(payload -> 'request') = 'object' THEN jsonb_build_object('request', pg_temp.qm_turn_origin_request(payload -> 'request')) ELSE '{}'::jsonb END
       || CASE WHEN jsonb_typeof(payload -> 'sessionRequest') = 'object' THEN jsonb_build_object('sessionRequest', pg_temp.qm_turn_origin_request(payload -> 'sessionRequest')) ELSE '{}'::jsonb END
     WHERE consumed_at IS NULL AND jsonb_typeof(payload) = 'object'
       AND (${originChanges("payload -> 'request'")} OR ${originChanges("payload -> 'sessionRequest'")})`,
  ),
  ifTable(
    "approvals",
    `UPDATE approvals SET json = jsonb_set(json, '{request}', pg_temp.qm_turn_origin_request(json -> 'request'))
     WHERE jsonb_typeof(json -> 'request') = 'object' AND ${originChanges("json -> 'request'")}`,
  ),
];

export const TURN_ORIGIN_MIGRATION = originMigration("surfaces/0005-turn-origin-backfill", [
  rewriteRuns("r.status NOT IN ('pending', 'running')"),
  rewriteRuns(LIVE_RUNS),
  ...REPLAYABLE_ORIGIN_REWRITES,
]);

const OVERLAP_TURN_ORIGIN_REWRITE = originMigration("surface-origin-rewrite/overlap-turn-origins", [
  rewriteRuns(LIVE_RUNS),
  ...REPLAYABLE_ORIGIN_REWRITES,
]);

export async function rewriteSurfaceOrigins(pg: PgPool): Promise<void> {
  const pool = await pg.pool();
  for (const migration of [OVERLAP_TURN_ORIGIN_REWRITE, ...LIVE_ORIGIN_REWRITES])
    await withPgTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('qm:surface-origin-rewrite'))");
      for (const statement of migration.statements) await client.query(statement);
    }).catch((error: unknown) => {
      throw new Error(`surface origin rewrite ${migration.id} failed: ${errMessage(error)}`, { cause: error });
    });
  await pg.migrate(SETTLED_ORIGIN_MIGRATION).catch((error: unknown) => {
    throw new Error(`surface origin rewrite ${SETTLED_ORIGIN_MIGRATION.id} failed: ${errMessage(error)}`, {
      cause: error,
    });
  });
}
