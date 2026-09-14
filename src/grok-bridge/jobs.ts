import { requireAgentName, requireInternalActor } from "./authz.ts";
import {
  GROK_BRIDGE_DEFAULT_TTL_MS,
  GROK_BRIDGE_MAX_TTL_MS,
  GROK_BRIDGE_PROTOCOL,
  GROK_BRIDGE_QUEUE_CAP,
  hashToken,
  parseBearer,
  tokenMatches,
} from "./crypto.ts";
import { buildJobEnvelope, parseEventEnvelope } from "./protocol.ts";
import {
  GrokBridgeError,
  IN_FLIGHT_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  type DispatchJob,
  type EventEnvelope,
  type GrokJob,
  type GrokPairing,
  type JobStore,
  type JobView,
  type OutboundPort,
  type PairingStore,
  type ProjectorPort,
  type SecretVault,
  type SessionAccess,
} from "./types.ts";
import { jobView } from "./views.ts";

function inFlightCount(jobs: readonly GrokJob[]): number {
  return jobs.filter((job) => IN_FLIGHT_JOB_STATUSES.has(job.status)).length;
}

function nextQueued(jobs: readonly GrokJob[]): GrokJob | undefined {
  return jobs.filter((job) => job.status === "queued").sort((a, b) => a.createdAt - b.createdAt)[0];
}

export interface JobLifecycle {
  dispatch(input: DispatchJob): Promise<JobView>;
  ingest(jobId: string, raw: unknown, authorizationHeader: string | undefined): Promise<{ duplicate: boolean }>;
  getJob(jobId: string, viewerId: string): Promise<JobView>;
  failInFlight(pairingId: string, summary: string): Promise<void>;
}

export function createJobLifecycle(deps: {
  pairings: PairingStore;
  jobs: JobStore;
  secrets: SecretVault;
  sessions: SessionAccess;
  outbound: OutboundPort;
  projector: ProjectorPort;
  now: () => number;
  id: () => string;
  mintToken: () => string;
}): JobLifecycle {
  async function toJobView(job: GrokJob): Promise<JobView> {
    const pairing = await deps.pairings.get(job.pairingId);
    return jobView(job, pairing?.agentName ?? "unknown");
  }

  async function expireIfDue(job: GrokJob): Promise<GrokJob> {
    if (TERMINAL_JOB_STATUSES.has(job.status) || deps.now() < job.expiresAt) return job;
    const expired: GrokJob = {
      ...job,
      status: "expired",
      summary: job.summary ?? "timed out waiting for Grok Bot",
      pendingEvents: [],
      updatedAt: deps.now(),
    };
    await deps.jobs.save(expired);
    return expired;
  }

  async function sendOutbound(job: GrokJob, callbackBaseUrl: string): Promise<GrokJob> {
    const pairing = await deps.pairings.get(job.pairingId);
    if (!pairing?.inboundRef || pairing.status !== "paired") {
      const failed: GrokJob = { ...job, status: "failed", summary: "pairing is not ready", updatedAt: deps.now() };
      await deps.jobs.save(failed);
      return failed;
    }
    const secret = await deps.secrets.get(pairing.inboundRef);
    if (!secret) {
      await deps.pairings.save({ ...pairing, status: "degraded", updatedAt: deps.now() });
      const failed: GrokJob = {
        ...job,
        status: "failed",
        summary: "inbound credentials missing",
        updatedAt: deps.now(),
      };
      await deps.jobs.save(failed);
      return failed;
    }
    const token = deps.mintToken();
    const dispatched: GrokJob = {
      ...job,
      status: "dispatched",
      callbackTokenHash: hashToken(token),
      updatedAt: deps.now(),
    };
    await deps.jobs.save(dispatched);
    const posted = await deps.outbound.postJob(
      secret.url,
      secret.bearer,
      buildJobEnvelope({ job: dispatched, pairing, token, callbackBaseUrl }),
    );
    if (posted.ok) return dispatched;
    await deps.pairings.save({ ...pairing, status: "degraded", updatedAt: deps.now() });
    const failed: GrokJob = {
      ...dispatched,
      status: "failed",
      summary: `Grok webhook returned ${posted.status}`,
      updatedAt: deps.now(),
    };
    await deps.jobs.save(failed);
    return failed;
  }

  async function kickQueue(pairingId: string, callbackBaseUrl: string): Promise<void> {
    const jobs = await Promise.all((await deps.jobs.listByPairing(pairingId)).map(expireIfDue));
    const hasActive = jobs.some((job) => IN_FLIGHT_JOB_STATUSES.has(job.status) && job.status !== "queued");
    if (hasActive) return;
    const queued = nextQueued(jobs);
    if (!queued) return;
    await sendOutbound(queued, callbackBaseUrl);
  }

  async function applyEvent(job: GrokJob, pairing: GrokPairing, event: EventEnvelope): Promise<void> {
    const next: GrokJob = {
      ...job,
      status: event.status,
      seqWatermark: event.seq,
      summary: event.summary,
      pendingEvents: job.pendingEvents.filter((pending) => pending.seq !== event.seq),
      updatedAt: deps.now(),
    };
    await deps.jobs.save(next);
    await deps.projector.project(next, pairing, {
      seq: event.seq,
      status: event.status,
      summary: event.summary,
    });
    if (TERMINAL_JOB_STATUSES.has(next.status)) {
      await kickQueue(pairing.id, next.callbackBaseUrl);
    }
  }

  async function loadJob(jobId: string): Promise<GrokJob> {
    const job = await deps.jobs.get(jobId);
    if (!job) throw new GrokBridgeError("not_found", 404, "job not found");
    return expireIfDue(job);
  }

  return {
    async dispatch(input) {
      requireInternalActor(input.actorType, "dispatch");
      const agentName = requireAgentName(input.agentName);
      const instruction = input.instruction.trim();
      if (!instruction) throw new GrokBridgeError("bad_request", 400, "instruction is required");
      if (!(await deps.sessions.canRead(input.originSessionId, input.originActorId))) {
        throw new GrokBridgeError("forbidden", 403, "you cannot read that session");
      }
      if (!(await deps.sessions.ownerIsMember(input.originSessionId, input.ownerPrincipalId))) {
        throw new GrokBridgeError("forbidden", 403, "the Grok Bot owner must be a member of the origin session");
      }
      const pairing = await deps.pairings.findActive(input.ownerPrincipalId, agentName);
      if (!pairing || pairing.status !== "paired" || pairing.consent.status !== "accepted") {
        throw new GrokBridgeError("failed_precondition", 409, "no paired Grok Bot for that agent");
      }
      const existing = await Promise.all((await deps.jobs.listByPairing(pairing.id)).map(expireIfDue));
      if (inFlightCount(existing) >= GROK_BRIDGE_QUEUE_CAP) {
        throw new GrokBridgeError("too_many_requests", 429, "pairing queue is full");
      }
      const createdAt = deps.now();
      const job = await deps.jobs.create({
        id: deps.id(),
        pairingId: pairing.id,
        originSessionId: input.originSessionId,
        originActorId: input.originActorId,
        instruction,
        callbackTokenHash: "",
        seqWatermark: 0,
        status: "queued",
        pendingEvents: [],
        callbackBaseUrl: input.callbackBaseUrl,
        expiresAt: createdAt + Math.min(GROK_BRIDGE_DEFAULT_TTL_MS, GROK_BRIDGE_MAX_TTL_MS),
        createdAt,
        updatedAt: createdAt,
      });
      const active = existing.some((row) => IN_FLIGHT_JOB_STATUSES.has(row.status) && row.status !== "queued");
      const started = active ? job : await sendOutbound(job, input.callbackBaseUrl);
      return toJobView(started);
    },

    async ingest(jobId, raw, authorizationHeader) {
      const live = await loadJob(jobId);
      const pairing = await deps.pairings.get(live.pairingId);
      if (!pairing || pairing.status === "revoked") {
        throw new GrokBridgeError("unauthorized", 401, "pairing is no longer active");
      }
      const token = parseBearer(authorizationHeader);
      if (!token || !live.callbackTokenHash || live.status === "queued") {
        throw new GrokBridgeError("unauthorized", 401, "callback token mismatch");
      }
      if (!tokenMatches(token, live.callbackTokenHash)) {
        throw new GrokBridgeError("unauthorized", 401, "callback token mismatch");
      }
      const event = parseEventEnvelope(raw, jobId);
      if (event.seq <= live.seqWatermark) return { duplicate: true };
      if (TERMINAL_JOB_STATUSES.has(live.status)) {
        throw new GrokBridgeError("conflict", 409, "job is already terminal");
      }
      if (event.seq > live.seqWatermark + 1) {
        const alreadyParked = live.pendingEvents.some((pending) => pending.seq === event.seq);
        if (alreadyParked) return { duplicate: true };
        await deps.jobs.save({
          ...live,
          pendingEvents: [...live.pendingEvents, { seq: event.seq, status: event.status, summary: event.summary }].sort(
            (a, b) => a.seq - b.seq,
          ),
          updatedAt: deps.now(),
        });
        return { duplicate: false };
      }
      await applyEvent(live, pairing, event);
      let current = await deps.jobs.get(jobId);
      while (current) {
        const expectedSeq = current.seqWatermark + 1;
        const next = current.pendingEvents.find((pending) => pending.seq === expectedSeq);
        if (!next) break;
        await applyEvent(current, pairing, {
          protocol: GROK_BRIDGE_PROTOCOL,
          job_id: jobId,
          seq: next.seq,
          status: next.status,
          summary: next.summary,
          artifacts: [],
        });
        current = await deps.jobs.get(jobId);
      }
      if (!current) throw new GrokBridgeError("not_found", 404, "job not found");
      return { duplicate: false };
    },

    async getJob(jobId, viewerId) {
      const live = await loadJob(jobId);
      const pairing = await deps.pairings.get(live.pairingId);
      const allowed =
        live.originActorId === viewerId ||
        pairing?.ownerPrincipalId === viewerId ||
        (await deps.sessions.canRead(live.originSessionId, viewerId));
      if (!allowed) throw new GrokBridgeError("forbidden", 403, "not a viewer of this job");
      return toJobView(live);
    },

    async failInFlight(pairingId, summary) {
      const updatedAt = deps.now();
      for (const job of await deps.jobs.listByPairing(pairingId)) {
        if (!IN_FLIGHT_JOB_STATUSES.has(job.status)) continue;
        await deps.jobs.save({
          ...job,
          status: "failed",
          summary,
          callbackTokenHash: hashToken("revoked"),
          pendingEvents: [],
          updatedAt,
        });
      }
    },
  };
}
