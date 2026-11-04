const TYPED_ORIGIN_RELEASE = "surfaces/0004-settled-runs-rewrite";
const RETIRED_ORIGIN_KEYS = [
  "triggered",
  "unprompted",
  "liveActor",
  "triggerTs",
  "entryTs",
  "securityScreenData",
  "triggerDestination",
  "ownerKeychainUnion",
];
const SLACK_REQUEST_KEYS = ["slackSource", "externalSlack"];
const SLACK_DESTINATION_KEYS = ["slackAccountId", "slackTeamId", "slackPolicyNamespace"];
const anyKey = (json: string, keys: string[]) => `(${json}) ?| array[${keys.map((key) => `'${key}'`).join(", ")}]`;
const requestText = (column: string) =>
  `(${SLACK_REQUEST_KEYS.map((key) => `${column} LIKE '%"${key}"%'`).join(" OR ")}) AND pg_input_is_valid(${column}, 'jsonb') AND jsonb_typeof(${column}::jsonb) = 'object' AND ${anyKey(`${column}::jsonb`, SLACK_REQUEST_KEYS)}`;
const legacyRequest = (json: string) =>
  `jsonb_typeof(${json}) = 'object' AND (${anyKey(json, SLACK_REQUEST_KEYS)} OR NOT (${json}) ? 'origin' AND ${anyKey(json, RETIRED_ORIGIN_KEYS)})`;

const PREVIOUS_RELEASE_ROWS: [table: string, where: string][] = [
  [
    "runs",
    `status IN ('pending', 'running') AND pg_input_is_valid(request, 'jsonb') AND ${legacyRequest("request::jsonb")}`,
  ],
  [
    "run_signals",
    `consumed_at IS NULL AND (${legacyRequest("payload -> 'request'")} OR ${legacyRequest("payload -> 'sessionRequest'")})`,
  ],
  ["approvals", legacyRequest("json -> 'request'")],
  ["deliveries", `delivered_at IS NULL AND expired_at IS NULL AND ${anyKey("destination", SLACK_DESTINATION_KEYS)}`],
  ["sessions", `slack_binding ? 'teamId' OR ${requestText("spawn_meta")}`],
  ...["crons", "loops", "webhooks", "monitors", "secret_drops"].map((table): [string, string] => [
    table,
    anyKey("json -> 'destination'", SLACK_DESTINATION_KEYS),
  ]),
  ["keychain_asks", anyKey("json -> 'requesterDestination'", SLACK_DESTINATION_KEYS)],
];

export const RETIRED_ORIGIN_SWEEP_MIGRATION = {
  id: "surfaces/0005-retired-origin-sweep",
  statements: [
    `DO $$ BEGIN
       IF to_regclass('runs') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = '${TYPED_ORIGIN_RELEASE}')
         AND EXISTS (SELECT 1 FROM runs)
       THEN
         RAISE EXCEPTION 'this database has not stored typed turn origins yet: run a release that records ${TYPED_ORIGIN_RELEASE} first';
       END IF;
       ${PREVIOUS_RELEASE_ROWS.map(
         ([table, where]) => `IF to_regclass('${table}') IS NOT NULL THEN
         IF EXISTS (SELECT 1 FROM ${table} WHERE ${where}) THEN
           RAISE EXCEPTION '${table} holds rows in the shape written before ${TYPED_ORIGIN_RELEASE}: boot a release that records it once more so its takeover converts them';
         END IF;
       END IF;`,
       ).join("\n       ")}
     END $$`,
    `DROP TABLE IF EXISTS surface_origin_settled_candidates, surface_origin_settled_collected`,
  ],
};
