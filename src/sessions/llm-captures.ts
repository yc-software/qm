import { randomUUID } from "node:crypto";
import type { PgPool } from "../persistence/pg-pool.ts";
import { claimRows } from "../tenants/claim.ts";
import type { ScopeId } from "../types.ts";
import type { LlmRequestRecord, NewLlmRequest, SessionStore } from "./session-store.ts";
import { promptEnvelopeBody } from "./session-store.ts";

const LLM_CAPTURE_PURGE_BATCH = 100;
const ENVELOPE_TOUCH_MS = 24 * 60 * 60_000;

function rowToLlmRequest(r: Record<string, unknown>): LlmRequestRecord {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    turnSeq: r.turn_seq == null ? null : Number(r.turn_seq),
    step: Number(r.step),
    model: r.model as string,
    scopeLabel: r.scope_label as ScopeId,
    createdAt: Number(r.created_at),
    promptHash: r.prompt_hash == null ? null : (r.prompt_hash as string),
    ...(r.prompt_body != null ? { promptEnvelope: JSON.parse(r.prompt_body as string) } : {}),
    truncated: Boolean(r.truncated),
    usage: r.usage_json != null ? (JSON.parse(r.usage_json as string) as LlmRequestRecord["usage"]) : null,
    transport:
      r.transport_json != null ? (JSON.parse(r.transport_json as string) as LlmRequestRecord["transport"]) : null,
  };
}

export function createLlmCaptures(deps: {
  db: PgPool;
  now: () => number;
}): Pick<SessionStore, "recordLlmRequest" | "listLlmRequests" | "listLlmRequestsForTurns" | "purgeLlmCaptures"> {
  const { db, now } = deps;
  const { q } = db;
  async function readRequests(condition: string, args: unknown[], omitRequest = false): Promise<LlmRequestRecord[]> {
    const cols = omitRequest
      ? "r.id, r.session_id, r.turn_seq, r.step, r.model, r.scope_label, r.created_at, r.truncated, r.prompt_hash, r.usage_json, r.transport_json"
      : "r.*, e.body AS prompt_body";
    const from = omitRequest
      ? "session_llm_requests r"
      : "session_llm_requests r LEFT JOIN llm_prompt_envelopes e ON e.hash = r.prompt_hash";
    return (await q(`SELECT ${cols} FROM ${from} WHERE ${condition} ORDER BY r.created_at ASC, r.step ASC`, args)).map(
      rowToLlmRequest,
    );
  }
  return {
    async recordLlmRequest(sessionId, rec: NewLlmRequest): Promise<LlmRequestRecord> {
      const envelope = promptEnvelopeBody(rec.promptEnvelope);
      if (envelope) {
        await q(
          `INSERT INTO llm_prompt_envelopes(hash, body, created_at) VALUES ($1,$2,$3)
           ON CONFLICT (tenant_id, hash) DO UPDATE SET created_at = EXCLUDED.created_at
            WHERE llm_prompt_envelopes.created_at < EXCLUDED.created_at - ${ENVELOPE_TOUCH_MS}`,
          [envelope.hash, envelope.body, now()],
        );
      }
      const full: LlmRequestRecord = {
        id: randomUUID(),
        sessionId,
        turnSeq: rec.turnSeq,
        step: rec.step,
        model: rec.model,
        scopeLabel: rec.scopeLabel as ScopeId,
        createdAt: now(),
        promptHash: envelope?.hash ?? null,
        ...(rec.promptEnvelope !== undefined ? { promptEnvelope: rec.promptEnvelope } : {}),
        truncated: rec.truncated ?? false,
        usage: rec.usage ?? null,
        transport: rec.transport ?? null,
      };
      await q(
        "INSERT INTO session_llm_requests(id, session_id, turn_seq, step, model, scope_label, prompt_hash, truncated, created_at, usage_json, transport_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          full.id,
          full.sessionId,
          full.turnSeq,
          full.step,
          full.model,
          full.scopeLabel,
          full.promptHash,
          full.truncated,
          full.createdAt,
          full.usage ? JSON.stringify(full.usage) : null,
          full.transport ? JSON.stringify(full.transport) : null,
        ],
      );
      return full;
    },

    async listLlmRequests(sessionId, opts): Promise<LlmRequestRecord[]> {
      const conds = ["r.session_id = $1"];
      const args: unknown[] = [sessionId];
      const turnSeqs = opts?.turnSeqs;
      if (turnSeqs) {
        args.push(turnSeqs);
        conds.push(
          opts?.orphans
            ? `(r.turn_seq = ANY($${args.length}) OR r.turn_seq IS NULL)`
            : `r.turn_seq = ANY($${args.length})`,
        );
      } else if (opts?.orphans) {
        conds.push("r.turn_seq IS NULL");
      }
      return readRequests(conds.join(" AND "), args, opts?.omitRequest);
    },

    async listLlmRequestsForTurns(turns) {
      if (!turns.length) return [];
      return readRequests(
        `EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb)
        AS wanted("sessionId" text, "turnSeq" bigint)
        WHERE r.session_id = wanted."sessionId" AND r.turn_seq = wanted."turnSeq")`,
        [JSON.stringify(turns)],
      );
    },

    async purgeLlmCaptures(cutoff, opts) {
      const deadline = opts?.deadline ?? Infinity;
      let envelopes = 0;
      while (Date.now() < deadline && !opts?.stop?.()) {
        const deleted = await claimRows(db, "claim_purged_envelopes", [cutoff, LLM_CAPTURE_PURGE_BATCH]);
        envelopes += deleted.length;
        if (deleted.length < LLM_CAPTURE_PURGE_BATCH) break;
      }
      return envelopes;
    },
  };
}
