import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { DURABLE_RETRY_OPTIONS_SQL } from "../durable/schema.ts";

export const SWARM_WORKFLOW_MIGRATION: PgMigrationDefinition = {
  id: "swarms/workflow/0001",
  statements: [
    `SELECT absurd.create_queue('qm_handoffs')`,
    `CREATE OR REPLACE FUNCTION qm_schedule_swarm_workflow() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.json->>'pending'='true' THEN
          PERFORM absurd.spawn_task('qm_handoffs','swarm.reconcile',jsonb_build_object('swarmId',NEW.id),
            jsonb_build_object('idempotency_key','swarm:'||NEW.id||':'||md5(NEW.json::text))||${DURABLE_RETRY_OPTIONS_SQL});
        END IF;
        RETURN NEW;
      END
    $$`,
    `CREATE TRIGGER qm_schedule_swarm_workflow AFTER INSERT OR UPDATE OF json ON swarms
      FOR EACH ROW EXECUTE FUNCTION qm_schedule_swarm_workflow()`,
    `SELECT absurd.spawn_task('qm_handoffs','swarm.reconcile',jsonb_build_object('swarmId',id),
      jsonb_build_object('idempotency_key','swarm:'||id||':'||md5(json::text))||${DURABLE_RETRY_OPTIONS_SQL}) FROM swarms WHERE json->>'pending'='true'`,
  ],
};
