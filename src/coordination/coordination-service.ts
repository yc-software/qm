import { randomUUID } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import { parseScopeId, type ScopeId, type Session } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { swallow } from "../util/errors.ts";
import type { MessageBoardStore } from "./message-board.ts";
import type { PeerDirectory } from "./peer-directory.ts";
import { descendantSessionIds, liveChildren, type SwarmStore } from "./swarm-store.ts";
import { evaluateAudience } from "./jq-audience.ts";
import {
  DEFAULT_MAX_CHILDREN_PER_PARENT,
  DEFAULT_MAX_DEPTH,
  DEFAULT_SESSION_LIMIT,
  MAX_AGENT_NAME_CHARS,
  MAX_BOARD_PAGE,
  MAX_CHARACTER_BYTES,
  MAX_MESSAGE_TEXT_CHARS,
  PEER_COORDINATION_FLAG,
  type PeerDelivery,
  type PeerIdentity,
  type PeerMessage,
  type PeerView,
  type Swarm,
} from "./types.ts";

export type CoordinationCaller =
  { kind: "capability"; sessionId: string | null; runId: string | null; actorId: string } | { kind: "source" };

type Fail = { ok: false; status: number; body: Record<string, unknown> };
type Ok<T> = { ok: true; value: T };
export type Outcome<T> = Ok<T> | Fail;

const fail = (status: number, error: string, message?: string, extra?: Record<string, unknown>): Fail => ({
  ok: false,
  status,
  body: { error, ...(message ? { message } : {}), ...extra },
});

interface CoordinationApp {
  spawnSession(principalId: string, opts: { scopeId: ScopeId; title?: string }): Promise<{ session: Session } | null>;
  discardSession(sessionId: string, principalId: string): Promise<boolean>;
}

export interface CoordinationDeps {
  directory: PeerDirectory;
  board: MessageBoardStore;
  swarms: SwarmStore;
  sessions: SessionStore;
  runs: RunStore;
  signals: RunSignalStore;
  featureFlags: FeatureFlagStore;
  app: CoordinationApp;
  now?: () => number;
  newId?: () => string;
}

interface RegisterPeerBody {
  sessionId?: unknown;
  agentName?: unknown;
  character?: unknown;
  executionActorId?: unknown;
}

interface PublishBody {
  senderSessionId?: unknown;
  text?: unknown;
  audience?: unknown;
  recipients?: unknown;
  replyTo?: unknown;
}

interface CreateSwarmBody {
  rootSessionId?: unknown;
  scopeId?: unknown;
  sessionLimit?: unknown;
  maxChildrenPerParent?: unknown;
  maxDepth?: unknown;
}

interface PoolBrief {
  agentName: string;
  brief: string;
  character: Record<string, unknown>;
}

interface CreatePoolBody {
  requestId?: unknown;
  parentSessionId?: unknown;
  count?: unknown;
  briefs?: unknown;
}

interface StopBody {
  scope?: unknown;
  sessionId?: unknown;
}

export interface CoordinationService {
  availableForScope(scope: ScopeId): Promise<boolean>;
  availableAnywhere(): Promise<boolean>;
  registerPeer(caller: CoordinationCaller, body: RegisterPeerBody): Promise<Outcome<PeerView>>;
  listPeers(): Promise<PeerView[]>;
  getPeer(sessionId: string): Promise<Outcome<PeerView>>;
  updateCharacter(caller: CoordinationCaller, sessionId: string, body: unknown): Promise<Outcome<PeerView>>;
  publish(caller: CoordinationCaller, body: PublishBody): Promise<Outcome<PeerMessage>>;
  previewAudience(caller: CoordinationCaller, body: PublishBody): Promise<Outcome<{ recipientIds: string[] }>>;
  listMessages(opts: {
    afterSeq?: number;
    limit?: number;
  }): Promise<{ messages: PeerMessage[]; nextCursor: number | null }>;
  getMessage(messageId: string): Promise<PeerMessage | null>;
  deliveriesOf(messageId: string): Promise<PeerDelivery[] | null>;
  createSwarm(caller: CoordinationCaller, body: CreateSwarmBody): Promise<Outcome<Swarm>>;
  createPool(
    caller: CoordinationCaller,
    swarmId: string,
    body: CreatePoolBody,
  ): Promise<Outcome<{ swarmId: string; requestId: string; sessionIds: string[]; sessionsUsed: number }>>;
  stop(caller: CoordinationCaller, swarmId: string, body: StopBody): Promise<Outcome<{ stopped: string[] }>>;
  scopeOfPeer(sessionId: string): Promise<ScopeId | null>;
  scopeOfSwarm(swarmId: string): Promise<ScopeId | null>;
  sessionStopped(sessionId: string): Promise<boolean>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function characterOf(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CHARACTER_BYTES) return null;
  return value;
}

function briefsOf(value: unknown): PoolBrief[] | null {
  if (!Array.isArray(value)) return null;
  const out: PoolBrief[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return null;
    const agentName = typeof entry.agentName === "string" ? entry.agentName.trim() : "";
    const brief = typeof entry.brief === "string" ? entry.brief.trim() : "";
    const character = characterOf(entry.character);
    if (!agentName || agentName.length > MAX_AGENT_NAME_CHARS || !brief || !character) return null;
    if (brief.length > MAX_MESSAGE_TEXT_CHARS) return null;
    out.push({ agentName, brief, character });
  }
  return out;
}

export function createCoordinationService(deps: CoordinationDeps): CoordinationService {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;

  const stoppedIn = async (swarmId: string, sessionId: string): Promise<boolean> => {
    const [swarm, member] = await Promise.all([
      deps.swarms.getSwarm(swarmId),
      deps.swarms.getMember(swarmId, sessionId),
    ]);
    return swarm?.stoppedAt != null || member?.stoppedAt != null;
  };

  const viewOf = async (identity: PeerIdentity): Promise<PeerView> => ({
    sessionId: identity.sessionId,
    agentName: identity.agentName,
    character: identity.character,
    characterVersion: identity.characterVersion,
    parentSessionId: identity.parentSessionId,
    swarmId: identity.swarmId,
    depth: identity.depth,
    lifecycle: identity.swarmId && (await stoppedIn(identity.swarmId, identity.sessionId)) ? "stopped" : "active",
  });

  const callerSession = (caller: CoordinationCaller): string | null =>
    caller.kind === "capability" ? caller.sessionId : null;

  const ownsSession = (caller: CoordinationCaller, sessionId: string): boolean =>
    caller.kind === "source" || callerSession(caller) === sessionId;

  const callerRun = (caller: CoordinationCaller, senderSessionId: string): string | null =>
    caller.kind === "capability" && caller.sessionId === senderSessionId ? caller.runId : null;

  const resolveSender = async (caller: CoordinationCaller, body: PublishBody): Promise<Outcome<PeerIdentity>> => {
    const claimed = typeof body.senderSessionId === "string" ? body.senderSessionId : undefined;
    if (caller.kind === "capability") {
      if (!caller.sessionId) return fail(403, "forbidden", "this token isn't bound to a peer session");
      if (claimed !== undefined && claimed !== caller.sessionId) {
        return fail(403, "forbidden", "a capability caller publishes only as its own session");
      }
      const identity = await deps.directory.get(caller.sessionId);
      return identity ? { ok: true, value: identity } : fail(404, "not_found", "no peer identity for this session");
    }
    if (!claimed) return fail(400, "bad_request", "senderSessionId is required");
    const identity = await deps.directory.get(claimed);
    return identity ? { ok: true, value: identity } : fail(404, "not_found", "no peer identity for that session");
  };

  const freezeRecipients = async (
    body: PublishBody,
  ): Promise<Outcome<{ recipientIds: string[]; audienceExpr: string | null }>> => {
    const hasAudience = body.audience !== undefined;
    const hasRecipients = body.recipients !== undefined;
    if (hasAudience === hasRecipients) {
      return fail(400, "bad_request", "pass exactly one of `audience` (a jq expression) or `recipients`");
    }
    if (hasAudience) {
      if (typeof body.audience !== "string") return fail(400, "bad_request", "audience must be a jq expression");
      const evaluated = await evaluateAudience(body.audience, await deps.directory.list());
      if (!evaluated.ok) return fail(400, "bad_audience", evaluated.reason);
      return { ok: true, value: { recipientIds: evaluated.recipientIds, audienceExpr: body.audience } };
    }
    if (!Array.isArray(body.recipients) || body.recipients.some((id) => typeof id !== "string")) {
      return fail(400, "bad_request", "recipients must be an array of peer session ids");
    }
    const unique = [...new Set(body.recipients as string[])];
    for (const recipient of unique) {
      if (!(await deps.directory.get(recipient))) {
        return fail(400, "bad_request", `${recipient} is not a registered peer in this organization`);
      }
    }
    return { ok: true, value: { recipientIds: unique, audienceExpr: null } };
  };

  const publishMessage = async (
    sender: PeerIdentity,
    senderRunId: string | null,
    text: string,
    recipientIds: string[],
    audienceExpr: string | null,
    replyTo: string | null,
  ): Promise<PeerMessage> =>
    deps.board.publish({
      id: newId(),
      orgId: configOrgId(),
      senderSessionId: sender.sessionId,
      senderRunId,
      text,
      audienceExpr,
      resolvedRecipientIds: recipientIds,
      replyTo,
      createdAt: now(),
    });

  const discardReserved = async (reservedIds: readonly string[], principalId: string): Promise<string[]> => {
    const discarded: string[] = [];
    for (const sessionId of reservedIds) {
      const gone = await deps.app.discardSession(sessionId, principalId).catch((error: unknown) => {
        swallow("coordination: discard spawned child", error);
        return false;
      });
      if (!gone) continue;
      await deps.directory.remove(sessionId);
      discarded.push(sessionId);
    }
    return discarded;
  };

  return {
    availableForScope: (scope) => deps.featureFlags.enabled(PEER_COORDINATION_FLAG, scope),
    async availableAnywhere() {
      const record = await deps.featureFlags.get(PEER_COORDINATION_FLAG);
      return (record?.enabledScopes.length ?? 0) > 0;
    },

    async registerPeer(caller, body) {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) return fail(400, "bad_request", "sessionId is required");
      if (!ownsSession(caller, sessionId)) {
        return fail(403, "forbidden", "a capability caller registers only its own session");
      }
      const agentName = typeof body.agentName === "string" ? body.agentName.trim() : "";
      if (!agentName || agentName.length > MAX_AGENT_NAME_CHARS) {
        return fail(400, "bad_request", `agentName is required and must be at most ${MAX_AGENT_NAME_CHARS} characters`);
      }
      const character = characterOf(body.character);
      if (!character) return fail(400, "bad_request", "character must be a JSON object within the size limit");
      const session = await deps.sessions.get(sessionId);
      if (!session) return fail(404, "not_found", "no such session");
      const kind = parseScopeId(session.scopeId).kind;
      if (kind !== "personal" && kind !== "group" && kind !== "channel") {
        return fail(400, "unsupported_scope", "peer identities live in personal, group, or channel scopes");
      }
      const namedActorId = typeof body.executionActorId === "string" ? body.executionActorId : "";
      const executionActorId = caller.kind === "capability" ? caller.actorId : namedActorId;
      if (!executionActorId) return fail(400, "bad_request", "executionActorId is required");
      const participants = await deps.sessions.participantsOf(sessionId);
      if (!participants.includes(executionActorId)) {
        return fail(400, "bad_request", "executionActorId must be a participant of that session");
      }
      const identity = await deps.directory.register({
        sessionId,
        scopeId: session.scopeId,
        agentName,
        character,
        executionActorId,
      });
      if (!identity) return fail(409, "already_registered", "that session already has a peer identity");
      return { ok: true, value: await viewOf(identity) };
    },

    async listPeers() {
      const identities = await deps.directory.list();
      return Promise.all(identities.map(viewOf));
    },

    async getPeer(sessionId) {
      const identity = await deps.directory.get(sessionId);
      if (!identity) return fail(404, "not_found", "no such peer");
      return { ok: true, value: await viewOf(identity) };
    },

    async updateCharacter(caller, sessionId, body) {
      if (!ownsSession(caller, sessionId)) {
        return fail(403, "forbidden", "a capability caller edits only its own character");
      }
      if (!isPlainObject(body)) return fail(400, "bad_request", "expected a JSON body");
      const ifVersion = body.ifVersion;
      if (typeof ifVersion !== "number" || !Number.isInteger(ifVersion)) {
        return fail(400, "bad_request", "ifVersion is required and must be the character version you read");
      }
      const character = characterOf(body.character);
      if (!character || body.character === undefined) {
        return fail(400, "bad_request", "character must be a JSON object within the size limit");
      }
      const updated = await deps.directory.updateCharacter(sessionId, character, ifVersion);
      if (!updated.ok && updated.error === "not_found") return fail(404, "not_found", "no such peer");
      if (!updated.ok) {
        return fail(409, "version_conflict", "that character changed since you read it", {
          characterVersion: updated.characterVersion,
        });
      }
      return { ok: true, value: await viewOf(updated.identity) };
    },

    async publish(caller, body) {
      const sender = await resolveSender(caller, body);
      if (!sender.ok) return sender;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > MAX_MESSAGE_TEXT_CHARS) {
        return fail(400, "bad_request", "text is required and must be within the size limit");
      }
      let replyTo: string | null = null;
      if (body.replyTo !== undefined) {
        if (typeof body.replyTo !== "string") return fail(400, "bad_request", "replyTo must be a message id");
        if (!(await deps.board.get(configOrgId(), body.replyTo))) {
          return fail(400, "bad_request", "replyTo names no message on this board");
        }
        replyTo = body.replyTo;
      }
      const frozen = await freezeRecipients(body);
      if (!frozen.ok) return frozen;
      const message = await publishMessage(
        sender.value,
        callerRun(caller, sender.value.sessionId),
        text,
        frozen.value.recipientIds,
        frozen.value.audienceExpr,
        replyTo,
      );
      return { ok: true, value: message };
    },

    async previewAudience(caller, body) {
      const sender = await resolveSender(caller, body);
      if (!sender.ok) return sender;
      const frozen = await freezeRecipients(body);
      if (!frozen.ok) return frozen;
      return { ok: true, value: { recipientIds: frozen.value.recipientIds } };
    },

    listMessages(opts) {
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_BOARD_PAGE);
      return deps.board.list(configOrgId(), {
        ...(opts.afterSeq !== undefined ? { afterSeq: opts.afterSeq } : {}),
        limit,
      });
    },

    getMessage: (messageId) => deps.board.get(configOrgId(), messageId),

    async deliveriesOf(messageId) {
      const message = await deps.board.get(configOrgId(), messageId);
      if (!message) return null;
      return deps.board.deliveries(messageId);
    },

    async createSwarm(caller, body) {
      const rootSessionId = typeof body.rootSessionId === "string" ? body.rootSessionId : "";
      if (!rootSessionId) return fail(400, "bad_request", "rootSessionId is required");
      if (!ownsSession(caller, rootSessionId)) {
        return fail(403, "forbidden", "a capability caller roots a swarm only on its own session");
      }
      const root = await deps.directory.get(rootSessionId);
      if (!root) return fail(404, "not_found", "no peer identity for that session");
      if (body.scopeId !== root.scopeId) {
        return fail(400, "bad_request", "scopeId must equal the root peer's scope");
      }
      if (root.swarmId) return fail(409, "already_in_swarm", "that session already belongs to a swarm");
      const limits: Array<[string, unknown, number]> = [
        ["sessionLimit", body.sessionLimit, DEFAULT_SESSION_LIMIT],
        ["maxChildrenPerParent", body.maxChildrenPerParent, DEFAULT_MAX_CHILDREN_PER_PARENT],
        ["maxDepth", body.maxDepth, DEFAULT_MAX_DEPTH],
      ];
      const resolved: number[] = [];
      for (const [name, requested, ceiling] of limits) {
        if (requested === undefined) {
          resolved.push(ceiling);
          continue;
        }
        if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1 || requested > ceiling) {
          return fail(400, "bad_request", `${name} must be an integer between 1 and ${ceiling}`);
        }
        resolved.push(requested);
      }
      const swarm = await deps.swarms.createSwarm({
        id: newId(),
        scopeId: root.scopeId,
        rootSessionId,
        sessionLimit: resolved[0]!,
        maxChildrenPerParent: resolved[1]!,
        maxDepth: resolved[2]!,
        createdAt: now(),
      });
      await deps.directory.joinSwarm(rootSessionId, { swarmId: swarm.id, depth: 0, parentSessionId: null });
      return { ok: true, value: swarm };
    },

    async createPool(caller, swarmId, body) {
      const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
      if (!requestId) return fail(400, "bad_request", "requestId is required");
      const parentSessionId = typeof body.parentSessionId === "string" ? body.parentSessionId : "";
      if (!parentSessionId) return fail(400, "bad_request", "parentSessionId is required");
      if (!ownsSession(caller, parentSessionId)) {
        return fail(403, "forbidden", "a capability caller spawns only from its own session");
      }
      const briefs = briefsOf(body.briefs);
      if (!briefs?.length) return fail(400, "bad_request", "briefs must be a non-empty array of {agentName, brief}");
      if (body.count !== briefs.length) return fail(400, "bad_request", "count must equal briefs.length");
      const swarm = await deps.swarms.getSwarm(swarmId);
      if (!swarm) return fail(404, "not_found", "no such swarm");
      const parent = await deps.directory.get(parentSessionId);
      if (!parent) return fail(404, "not_found", "no peer identity for that parent");
      if (parent.swarmId !== swarmId || !(await deps.swarms.getMember(swarmId, parentSessionId))) {
        return fail(403, "forbidden", "that parent is not a member of this swarm");
      }
      if (swarm.scopeId !== parent.scopeId)
        return fail(400, "bad_request", "that parent lives outside the swarm scope");

      const reserved = await deps.swarms.reserve({
        swarmId,
        requestId,
        parentSessionId,
        n: briefs.length,
        createdAt: now(),
      });
      if (!reserved.ok) {
        const why =
          reserved.reason === "provisioning_in_progress"
            ? "that requestId is still being provisioned; retry once it settles"
            : "the swarm cannot admit that many more sessions";
        return fail(409, reserved.reason, why);
      }
      if (reserved.reservation.n !== briefs.length || reserved.reservation.parentSessionId !== parentSessionId) {
        return fail(409, "reservation_conflict", "that requestId already reserved a different pool");
      }

      const parentMember = (await deps.swarms.getMember(swarmId, parentSessionId))!;
      const slots = [...reserved.reservation.slots];
      const unrecorded: string[] = [];
      const senderRunId = callerRun(caller, parentSessionId);
      try {
        for (const [slot, brief] of briefs.entries()) {
          if (slots[slot]) continue;
          const spawned = await deps.app.spawnSession(parent.executionActorId, {
            scopeId: parent.scopeId,
            title: brief.agentName,
          });
          if (!spawned) throw new Error("spawnSession refused the parent's scope");
          const childId = spawned.session.id;
          unrecorded.push(childId);
          await deps.swarms.appendChild({
            swarmId,
            requestId,
            childSessionId: childId,
            parentSessionId,
            slot,
            depth: parentMember.depth + 1,
            createdAt: now(),
          });
          slots[slot] = childId;
          const identity = await deps.directory.register({
            sessionId: childId,
            scopeId: parent.scopeId,
            agentName: brief.agentName,
            character: brief.character,
            executionActorId: parent.executionActorId,
            parentSessionId,
            swarmId,
            depth: parentMember.depth + 1,
          });
          if (!identity) throw new Error("a peer identity already exists for a freshly spawned session");
          await publishMessage(parent, senderRunId, brief.brief, [childId], null, null);
        }
      } catch (error) {
        swallow("coordination: pool provisioning", error);
        const open = await deps.swarms.getReservation(swarmId, requestId);
        const reachable = new Set([...(open ? liveChildren(open) : []), ...unrecorded]);
        const discarded = await discardReserved([...reachable], parent.executionActorId);
        await deps.swarms.settleFailure(swarmId, requestId, discarded);
        return fail(503, "provisioning_failed", "the pool could not be provisioned; retry with the same requestId");
      }
      const after = await deps.swarms.getSwarm(swarmId);
      return {
        ok: true,
        value: {
          swarmId,
          requestId,
          sessionIds: liveChildren({ ...reserved.reservation, slots }),
          sessionsUsed: after?.sessionsUsed ?? swarm.sessionsUsed,
        },
      };
    },

    async stop(caller, swarmId, body) {
      const scope = body.scope;
      if (scope !== "parent" && scope !== "subtree" && scope !== "swarm") {
        return fail(400, "bad_request", 'scope must be "parent", "subtree", or "swarm"');
      }
      const swarm = await deps.swarms.getSwarm(swarmId);
      if (!swarm) return fail(404, "not_found", "no such swarm");
      const members = await deps.swarms.members(swarmId);
      const own = callerSession(caller);
      if (caller.kind === "capability") {
        if (!own || !members.some((member) => member.sessionId === own)) {
          return fail(403, "forbidden", "a capability caller stops only a swarm it belongs to");
        }
      }
      let targets: string[];
      if (scope === "swarm") {
        targets = members.map((member) => member.sessionId);
      } else {
        const sessionId = typeof body.sessionId === "string" ? body.sessionId : own;
        if (!sessionId || !members.some((member) => member.sessionId === sessionId)) {
          return fail(400, "bad_request", "sessionId must name a member of this swarm");
        }
        if (
          caller.kind === "capability" &&
          sessionId !== own &&
          !descendantSessionIds(members, own!).includes(sessionId)
        ) {
          return fail(403, "forbidden", "a capability caller stops only itself or its descendants");
        }
        targets = scope === "parent" ? [sessionId] : [sessionId, ...descendantSessionIds(members, sessionId)];
      }
      await deps.swarms.markStopped(swarmId, targets, now(), scope === "swarm");
      for (const sessionId of targets) {
        const session = await deps.sessions.get(sessionId);
        if (!session) continue;
        for (const run of await deps.runs.inFlightForThread(session.threadRef)) {
          if (!(await deps.runs.withdraw(run.id))) await deps.signals.send(run.id, { kind: "abort" });
        }
      }
      return { ok: true, value: { stopped: targets } };
    },

    async scopeOfPeer(sessionId) {
      return (await deps.directory.get(sessionId))?.scopeId ?? null;
    },

    async scopeOfSwarm(swarmId) {
      return (await deps.swarms.getSwarm(swarmId))?.scopeId ?? null;
    },

    async sessionStopped(sessionId) {
      const identity = await deps.directory.get(sessionId);
      if (!identity?.swarmId) return false;
      return stoppedIn(identity.swarmId, sessionId);
    },
  };
}
