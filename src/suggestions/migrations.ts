import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";

export const SUGGESTION_PROFILE_MIGRATIONS: readonly PgMigrationDefinition[] = [
  {
    id: "durable-map/suggested_activity_profiles/0001-nightly-on-use",
    statements: [
      "CREATE TABLE IF NOT EXISTS crons (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
      "CREATE TABLE IF NOT EXISTS suggested_activity_profiles (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
      `UPDATE crons c SET json = jsonb_set(c.json, '{schedule,cron}', to_jsonb(get_byte(sha256(convert_to(p.id, 'UTF8')), 0) % 60 || ' 2 * * *')) FROM suggested_activity_profiles p WHERE p.json ->> 'cronId' = c.id AND c.json -> 'schedule' = p.json -> 'managedSchedule'`,
      `UPDATE crons c SET json = jsonb_set(c.json, '{enabled}', 'true') FROM suggested_activity_profiles p WHERE p.json ->> 'cronId' = c.id AND (p.json ->> 'autoPaused')::boolean`,
    ],
  },
  {
    id: "durable-map/suggested_activity_profiles/0011-strip-retired-fields",
    statements: [
      "UPDATE suggested_activity_profiles SET json = json - ARRAY['dismissed', 'managedAction', 'dismissalRefreshAt', 'managedSchedule', 'autoPaused']",
      "UPDATE durable_map_versions SET v = v + 1 WHERE tbl = 'suggested_activity_profiles'",
    ],
  },
];
