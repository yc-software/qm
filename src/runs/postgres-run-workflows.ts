import type { PgMigrationDefinition } from "../persistence/pg-pool.ts";
import { DURABLE_RETRY_OPTIONS_SQL } from "../durable/schema.ts";

export const RUN_WORKFLOW_MIGRATION: PgMigrationDefinition = {
  id: "runs/store/0005-absurd",
  statements: [
    `SELECT absurd.create_queue('qm_runs')`,
    `SELECT absurd.create_queue('qm_handoffs')`,
    `ALTER TABLE runs ADD COLUMN IF NOT EXISTS workflow_task_id UUID`,
    `ALTER TABLE runs ADD COLUMN IF NOT EXISTS workflow_attempt_base INT NOT NULL DEFAULT 0`,
    `CREATE UNIQUE INDEX IF NOT EXISTS runs_workflow_task ON runs(workflow_task_id) WHERE workflow_task_id IS NOT NULL`,
    `CREATE OR REPLACE FUNCTION qm_run_workflow_changed() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        item runs%ROWTYPE;
        payload jsonb;
        terminal_result jsonb;
        terminal_status text;
      BEGIN
        IF NEW.state NOT IN ('pending','sleeping','completed','failed','cancelled') THEN RETURN NEW; END IF;
        SELECT * INTO item FROM runs WHERE workflow_task_id=NEW.task_id
          AND (NEW.state IN ('completed','failed','cancelled') OR status='running') FOR UPDATE;
        IF NOT FOUND OR item.status IN ('done','failed') THEN RETURN NEW; END IF;
        IF item.lease_token IS NOT NULL THEN
          DELETE FROM session_leases WHERE run_id=item.id AND run_lease_token=item.lease_token;
        END IF;
        IF NEW.state IN ('pending','sleeping') THEN
          UPDATE runs SET status='pending',lease_token=NULL,lease_expires_at=NULL,worker_id=NULL WHERE id=item.id;
          PERFORM pg_notify('qm_run_available','null');
          RETURN NEW;
        END IF;
        payload := NEW.completed_payload;
        terminal_status := CASE WHEN NEW.state='completed' THEN COALESCE(payload->>'status','done') ELSE 'failed' END;
        terminal_result := CASE WHEN NEW.state='completed' THEN payload->'result'
          ELSE jsonb_build_object('status','failed','sessionId',item.session_id,'reason',
            CASE WHEN NEW.state='cancelled' THEN 'run exceeded its execution lifetime'
            ELSE 'run exhausted its execution attempts' END) END;
        UPDATE runs SET status=terminal_status,result=terminal_result::text,lease_token=NULL,lease_expires_at=NULL,
          finished_at=(extract(epoch FROM absurd.current_time())*1000)::bigint,
          idempotency_key=CASE WHEN terminal_result->>'refusalKind'='session_busy' THEN NULL ELSE idempotency_key END
          WHERE id=item.id;
        PERFORM absurd.emit_event('qm_runs','run-terminal:'||item.id,'null'::jsonb);
        PERFORM absurd.emit_event('qm_handoffs','run-terminal:'||item.id,'null'::jsonb);
        PERFORM absurd.spawn_task('qm_handoffs','run.terminal',jsonb_build_object('runId',item.id),
          jsonb_build_object('idempotency_key','run:terminal:'||item.id)||${DURABLE_RETRY_OPTIONS_SQL});
        PERFORM pg_notify('qm_run_available','null');
        PERFORM pg_notify('qm_run_terminal',item.id);
        RETURN NEW;
      END
    $$`,
    `DROP TRIGGER IF EXISTS qm_run_workflow_changed ON absurd.t_qm_runs`,
    `CREATE TRIGGER qm_run_workflow_changed AFTER UPDATE OF state ON absurd.t_qm_runs
      FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION qm_run_workflow_changed()`,
    `CREATE OR REPLACE FUNCTION qm_require_run_workflow_owner() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.workflow_task_id IS NOT NULL AND NEW.status='running' AND NOT EXISTS (
          SELECT 1 FROM absurd.r_qm_runs WHERE task_id=NEW.workflow_task_id AND run_id::text=NEW.lease_token AND state='running'
        ) THEN RAISE EXCEPTION 'run ownership requires its active durable workflow attempt'; END IF;
        RETURN NEW;
      END
    $$`,
    `DROP TRIGGER IF EXISTS qm_require_run_workflow_owner ON runs`,
    `CREATE TRIGGER qm_require_run_workflow_owner BEFORE UPDATE OF status,lease_token ON runs
      FOR EACH ROW EXECUTE FUNCTION qm_require_run_workflow_owner()`,
    `DO $$
      DECLARE item runs%ROWTYPE; spawned record;
      BEGIN
        FOR item IN SELECT * FROM runs WHERE status IN ('pending','running') AND workflow_task_id IS NULL ORDER BY created_at,seq FOR UPDATE LOOP
          SELECT * INTO spawned FROM absurd.spawn_task('qm_runs','run.execute',jsonb_build_object('runId',item.id),
            jsonb_build_object('idempotency_key','run:'||item.id,'max_attempts',GREATEST(1,8-item.attempts),
              'retry_strategy',jsonb_build_object('kind','exponential','base_seconds',15,'factor',2,'max_seconds',60),
              'cancellation',jsonb_build_object('max_duration',86400)));
          IF item.status='running' AND to_regclass('sessions') IS NOT NULL THEN
            DELETE FROM session_leases lease USING sessions session
              WHERE lease.session_id=session.id AND session.thread_ref=item.session_id AND lease.holder='turn'
                AND (lease.run_id IS NULL OR lease.run_id=item.id);
          END IF;
          UPDATE runs SET workflow_task_id=spawned.task_id,workflow_attempt_base=item.attempts,
            status='pending',lease_token=NULL,lease_expires_at=NULL,worker_id=NULL WHERE id=item.id;
        END LOOP;
      END
    $$`,
    `SELECT absurd.spawn_task('qm_handoffs','run.terminal',jsonb_build_object('runId',id),
      jsonb_build_object('idempotency_key','run:terminal:'||id)||${DURABLE_RETRY_OPTIONS_SQL}) FROM runs
      WHERE status IN ('done','failed') AND returned_at IS NULL AND session_id LIKE 'agent:main:subagent:%'`,
  ],
};

const workflowChanged = RUN_WORKFLOW_MIGRATION.statements.find((statement) =>
  statement.startsWith("CREATE OR REPLACE FUNCTION qm_run_workflow_changed()"),
)!;

export const RUN_HANDOFF_WORKFLOW_MIGRATION: PgMigrationDefinition = {
  id: "runs/store/0007-worker-handoffs",
  statements: [
    workflowChanged.replace(
      "UPDATE runs SET status='pending',",
      "UPDATE runs SET handoffs=handoffs+CASE WHEN NEW.last_attempt_run IS DISTINCT FROM OLD.last_attempt_run AND NEW.attempts=OLD.attempts THEN 1 ELSE 0 END,status='pending',",
    ),
  ],
};
