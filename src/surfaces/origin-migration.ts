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

export const RETIRED_ORIGIN_SWEEP_MIGRATION = {
  id: "surfaces/0005-retired-origin-sweep",
  statements: [
    `SET LOCAL lock_timeout = '3s'`,
    `DO $$ BEGIN
       IF to_regclass('runs') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM qm_schema_migrations WHERE id = '${TYPED_ORIGIN_RELEASE}')
         AND EXISTS (SELECT 1 FROM runs)
       THEN
         RAISE EXCEPTION 'this database has not stored typed turn origins yet: run a release that records ${TYPED_ORIGIN_RELEASE} first';
       END IF;
     END $$`,
    `DROP TABLE IF EXISTS surface_origin_settled_candidates, surface_origin_settled_collected`,
    `DO $$ BEGIN
       IF to_regclass('approvals') IS NOT NULL THEN
         DELETE FROM approvals
         WHERE jsonb_typeof(json -> 'request') = 'object'
           AND NOT (json -> 'request') ? 'origin'
           AND (json -> 'request') ?| array[${RETIRED_ORIGIN_KEYS.map((key) => `'${key}'`).join(", ")}];
       END IF;
     END $$`,
  ],
};
