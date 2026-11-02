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

export const SURFACE_ORIGIN_MIGRATIONS = [
  migration("surfaces/0001-neutral-origin-and-account", [
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
  migration("surfaces/0002-neutral-origin-spawn-meta", [
    ifTable(
      "sessions",
      `UPDATE sessions SET spawn_meta = pg_temp.qm_surface_request_text(spawn_meta) WHERE ${oldKeysIn("spawn_meta")}`,
    ),
  ]),
  migration("surfaces/0003-neutral-origin-settled-runs", [
    ifTable(
      "runs",
      `UPDATE runs r SET request = pg_temp.qm_surface_request_text(r.request)
       WHERE ${oldKeysIn("r.request")}
         AND (r.request LIKE '%"externalSlack"%'
           OR ${newerRun()}
           OR ${newerRun(` AND (n.request NOT LIKE '%"privateSessionMessage"%' OR COALESCE(pg_temp.qm_jsonb_or_null(n.request) ->> 'privateSessionMessage', 'false') <> 'true')`)})`,
    ),
  ]),
];
