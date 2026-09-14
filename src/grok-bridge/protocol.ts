import { GROK_BRIDGE_PROTOCOL } from "./crypto.ts";
import {
  GrokBridgeError,
  JOB_EVENT_STATUSES,
  type EventEnvelope,
  type GrokJob,
  type GrokPairing,
  type JobEnvelope,
  type JobEventStatus,
} from "./types.ts";

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export function buildJobEnvelope(input: {
  job: GrokJob;
  pairing: GrokPairing;
  token: string;
  callbackBaseUrl: string;
}): JobEnvelope {
  return {
    protocol: GROK_BRIDGE_PROTOCOL,
    job_id: input.job.id,
    qm_agent: input.pairing.agentName,
    qm_session_id: input.job.originSessionId,
    instruction: input.job.instruction,
    callback_url: `${input.callbackBaseUrl.replace(/\/$/, "")}/v1/grok-bridge/jobs/${input.job.id}/events`,
    callback_token: input.token,
    reply_required: true,
    expires_at: new Date(input.job.expiresAt).toISOString(),
    approval_policy: "owner-must-approve-side-effects",
  };
}

export function parseEventEnvelope(raw: unknown, expectedJobId: string): EventEnvelope {
  if (!isObj(raw)) throw new GrokBridgeError("bad_request", 400, "event body must be a JSON object");
  if (raw.protocol !== GROK_BRIDGE_PROTOCOL) {
    throw new GrokBridgeError("bad_request", 400, "unknown protocol");
  }
  if (raw.job_id !== expectedJobId) {
    throw new GrokBridgeError("not_found", 404, "job_id does not match the URL");
  }
  if (typeof raw.seq !== "number" || !Number.isInteger(raw.seq) || raw.seq < 1) {
    throw new GrokBridgeError("bad_request", 400, "seq must be an integer >= 1");
  }
  if (!isJobEventStatus(raw.status)) {
    throw new GrokBridgeError("bad_request", 400, "unsupported event status");
  }
  if (typeof raw.summary !== "string") {
    throw new GrokBridgeError("bad_request", 400, "summary is required");
  }
  const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts : [];
  return {
    protocol: GROK_BRIDGE_PROTOCOL,
    job_id: expectedJobId,
    seq: raw.seq,
    status: raw.status,
    summary: raw.summary,
    artifacts,
  };
}

function isJobEventStatus(value: unknown): value is JobEventStatus {
  return typeof value === "string" && (JOB_EVENT_STATUSES as readonly string[]).includes(value);
}
