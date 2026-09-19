import { definePgMigration } from "../persistence/pg-pool.ts";
import schema from "./vendor/absurd-0.5.0.json" with { type: "json" };

export const DURABLE_RETRY_STRATEGY = { kind: "exponential", base_seconds: 1, factor: 2, max_seconds: 300 };
export const DURABLE_RETRY_OPTIONS_SQL = `'${JSON.stringify({ retry_strategy: DURABLE_RETRY_STRATEGY })}'::jsonb`;

export const ABSURD_MIGRATION = definePgMigration("absurd/0001-schema-0.5.0", schema.statements);

export const ABSURD_HANDOFF_MIGRATION = definePgMigration("absurd/0003-handoff", [
  `CREATE FUNCTION qm_handoff_run(p_queue_name text, p_run_id uuid, p_worker_id text)
   RETURNS uuid LANGUAGE plpgsql AS $$
   DECLARE
     v_run record;
     v_task record;
     v_next_run uuid;
     v_now timestamptz;
   BEGIN
     PERFORM absurd.validate_queue_name(p_queue_name);
     EXECUTE format('SELECT * FROM absurd.%I WHERE run_id=$1 FOR UPDATE', 'r_' || p_queue_name)
       INTO v_run USING p_run_id;
     IF v_run.run_id IS NULL THEN RETURN NULL; END IF;
     EXECUTE format('SELECT * FROM absurd.%I WHERE task_id=$1 FOR UPDATE', 't_' || p_queue_name)
       INTO v_task USING v_run.task_id;
     v_now := absurd.current_time();
     IF v_run.state <> 'running' OR v_run.claimed_by IS DISTINCT FROM p_worker_id
        OR v_run.claim_expires_at IS NULL OR v_run.claim_expires_at <= v_now
        OR v_task.state <> 'running' OR v_task.last_attempt_run IS DISTINCT FROM p_run_id THEN
       RETURN NULL;
     END IF;
     v_next_run := absurd.portable_uuidv7();
     EXECUTE format('UPDATE absurd.%I SET state=''failed'', failed_at=$2,
       failure_reason=jsonb_build_object(''type'',''DeploymentHandoff'',''successor_run_id'',$3::text),
       claim_expires_at=NULL, wake_event=NULL WHERE run_id=$1', 'r_' || p_queue_name)
       USING p_run_id, v_now, v_next_run;
     EXECUTE format('INSERT INTO absurd.%I(run_id,task_id,attempt,state,available_at,wake_event,event_payload)
       VALUES($1,$2,$3,''pending'',$4,$5,$6)', 'r_' || p_queue_name)
       USING v_next_run, v_run.task_id, v_run.attempt, v_now, v_run.wake_event, v_run.event_payload;
     EXECUTE format('UPDATE absurd.%I SET state=''pending'',last_attempt_run=$2 WHERE task_id=$1',
       't_' || p_queue_name) USING v_run.task_id, v_next_run;
     EXECUTE format('DELETE FROM absurd.%I WHERE run_id=$1', 'w_' || p_queue_name) USING p_run_id;
     RETURN v_next_run;
   END $$`,
]);

const nativeCheckpointStatement = schema.statements.find((statement) =>
  statement.startsWith("create function absurd.set_task_checkpoint_state ("),
);
if (!nativeCheckpointStatement?.includes("where r.run_id = $1',"))
  throw new Error("Pinned Absurd checkpoint definition does not match the fencing migration");

export const ABSURD_CHECKPOINT_FENCING_MIGRATION = definePgMigration("absurd/0004-checkpoint-fencing", [
  nativeCheckpointStatement
    .replace("create function", "create or replace function")
    .replace("where r.run_id = $1',", "where r.run_id = $1 for update of r',"),
]);

export const ABSURD_WORKER_FENCING_MIGRATION = definePgMigration("absurd/0005-worker-fencing", [
  `CREATE TABLE qm_durable_workers (
     queue_name text NOT NULL,
     worker_id text NOT NULL,
     stopped boolean NOT NULL DEFAULT false,
     PRIMARY KEY(queue_name, worker_id)
   )`,
  `CREATE FUNCTION qm_claim_tasks(p_queue_name text, p_worker_id text, p_claim_timeout integer, p_qty integer)
   RETURNS TABLE(run_id uuid,task_id uuid,attempt integer,task_name text,params jsonb,retry_strategy jsonb,
     max_attempts integer,headers jsonb,wake_event text,event_payload jsonb)
   LANGUAGE plpgsql AS $$
   DECLARE v_stopped boolean;
   BEGIN
     INSERT INTO qm_durable_workers(queue_name,worker_id) VALUES(p_queue_name,p_worker_id) ON CONFLICT DO NOTHING;
     SELECT stopped INTO v_stopped FROM qm_durable_workers
       WHERE queue_name=p_queue_name AND worker_id=p_worker_id FOR UPDATE;
     IF v_stopped THEN RETURN; END IF;
     RETURN QUERY SELECT * FROM absurd.claim_task(p_queue_name,p_worker_id,p_claim_timeout,p_qty);
   END $$`,
  `CREATE FUNCTION qm_handoff_worker(p_queue_name text, p_worker_id text)
   RETURNS void LANGUAGE plpgsql AS $$
   DECLARE v_run record;
   BEGIN
     PERFORM absurd.validate_queue_name(p_queue_name);
     INSERT INTO qm_durable_workers(queue_name,worker_id,stopped) VALUES(p_queue_name,p_worker_id,true)
       ON CONFLICT(queue_name,worker_id) DO UPDATE SET stopped=true;
     FOR v_run IN EXECUTE format('SELECT run_id FROM absurd.%I
       WHERE claimed_by=$1 AND state=''running'' ORDER BY run_id', 'r_' || p_queue_name) USING p_worker_id
     LOOP
       PERFORM qm_handoff_run(p_queue_name,v_run.run_id,p_worker_id);
     END LOOP;
   END $$`,
]);

export const ABSURD_WORKER_CLAIM_HANDOFF_MIGRATION = definePgMigration("absurd/0006-worker-claim-handoff", [
  `CREATE FUNCTION qm_handoff_worker(p_queue_name text, p_worker_id text, p_keep_runs uuid[])
   RETURNS void LANGUAGE plpgsql AS $$
   DECLARE v_run record;
   BEGIN
     PERFORM absurd.validate_queue_name(p_queue_name);
     INSERT INTO qm_durable_workers(queue_name,worker_id,stopped) VALUES(p_queue_name,p_worker_id,true)
       ON CONFLICT(queue_name,worker_id) DO UPDATE SET stopped=true;
     FOR v_run IN EXECUTE format('SELECT run_id FROM absurd.%I
       WHERE claimed_by=$1 AND state=''running'' AND run_id <> ALL($2) ORDER BY run_id', 'r_' || p_queue_name)
       USING p_worker_id,p_keep_runs
     LOOP
       PERFORM qm_handoff_run(p_queue_name,v_run.run_id,p_worker_id);
     END LOOP;
   END $$`,
  `CREATE OR REPLACE FUNCTION qm_handoff_worker(p_queue_name text, p_worker_id text)
   RETURNS void LANGUAGE plpgsql AS $$
   BEGIN
     PERFORM qm_handoff_worker(p_queue_name,p_worker_id,ARRAY[]::uuid[]);
   END $$`,
]);

export const ABSURD_EXPIRED_HANDOFF_MIGRATION = definePgMigration("absurd/0007-expired-handoff", [
  ABSURD_HANDOFF_MIGRATION.statements[0]!.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION").replace(
    " OR v_run.claim_expires_at <= v_now",
    "",
  ),
]);

export function absurdQueueMigration(queue: string) {
  if (!/^[a-z][a-z0-9_]{0,56}$/.test(queue)) throw new Error(`Invalid workflow queue: ${queue}`);
  return definePgMigration(`absurd/0002-queue-${queue}`, [`SELECT absurd.create_queue('${queue}')`]);
}
