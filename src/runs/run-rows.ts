import type { OrchestratorInput } from "../core/orchestrator.ts";
import type { TurnResult } from "../types.ts";
import type { Run, RunDeliveryState, RunPriority, RunStop } from "./run-store.ts";

export function rowToRun(r: Record<string, unknown>): Run {
  const request = JSON.parse(r.request as string) as OrchestratorInput;
  return {
    id: r.id as string,
    tenantId: String(r.tenant_id),
    sessionId: r.session_id as string,
    status: r.status as Run["status"],
    request,
    result: r.result != null ? (JSON.parse(r.result as string) as TurnResult) : null,
    deliveryState: r.delivery_state != null ? (JSON.parse(r.delivery_state as string) as RunDeliveryState) : null,
    turnUserSeq: r.turn_user_seq != null ? Number(r.turn_user_seq) : null,
    dedupKey: (r.idempotency_key as string | null) ?? null,
    attempts: Number(r.attempts),
    errorAttempts: Number(r.error_attempts),
    maxAttempts: Number(r.max_attempts),
    priority: Number(r.claim_priority) as RunPriority,
    preemptions: Number(r.preemptions),
    handbacks: Number(r.handbacks),
    leaseToken: (r.lease_token as string | null) ?? null,
    leaseExpiresAt: r.lease_expires_at === null ? null : Number(r.lease_expires_at),
    workerId: (r.worker_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null ? null : Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    lastStop: r.last_stop != null ? (JSON.parse(r.last_stop as string) as RunStop) : null,
  };
}

export const parked = (run: string) => `(${run}.claim_priority > 0 AND ${run}.last_stop::jsonb->>'kind' = 'parked')`;

export const turnOrder = (run: string) => `(CASE WHEN ${run}.claim_priority <> 0 THEN 1
    WHEN EXISTS (
      SELECT 1 FROM runs ahead WHERE ahead.tenant_id=${run}.tenant_id AND ahead.session_id=${run}.session_id AND ahead.status='pending'
        AND ahead.claim_priority > 0 AND ${parked("ahead")} IS NOT TRUE
        AND (ahead.created_at, ahead.seq) < (${run}.created_at, ${run}.seq)
    ) THEN 1 ELSE 0 END), ${run}.created_at, ${run}.seq`;
