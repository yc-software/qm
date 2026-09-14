import type { ConversationKind, TurnRequest, TurnResult } from "../types.ts";
import { parseScopeId } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { RunStore } from "../runs/run-store.ts";
import { isTerminal } from "../runs/run-store.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import { swallow } from "../util/errors.ts";
import type { MessageBoardStore } from "./message-board.ts";
import type { PeerDirectory } from "./peer-directory.ts";
import type { CoordinationService } from "./coordination-service.ts";
import { PEER_COORDINATION_FLAG } from "./types.ts";

const CLAIM_LEASE_MS = 60_000;
const BATCH_LIMIT = 25;
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const ROSTER_RACE_REFUSAL = "project membership changed; retry from the current project";

const CONVERSATION_KIND_BY_SCOPE: Record<string, ConversationKind> = {
  personal: "dm",
  group: "group",
  channel: "channel",
};

export interface PeerDispatcherDeps {
  board: MessageBoardStore;
  directory: PeerDirectory;
  coordination: CoordinationService;
  sessions: SessionStore;
  runs: RunStore;
  signals: RunSignalStore;
  featureFlags: FeatureFlagStore;
  peopleDirectory?: DirectoryStore;
  turn(request: TurnRequest): Promise<TurnResult>;
  now?: () => number;
}

export interface PeerDispatcher {
  tick(): Promise<void>;
  sweeper(intervalMs: number): Sweeper;
}

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS);
}

export function createPeerDispatcher(deps: PeerDispatcherDeps): PeerDispatcher {
  const now = deps.now ?? Date.now;

  const dispatch = async (messageId: string, recipientSessionId: string, attempts: number): Promise<void> => {
    const park = (status: string, reason: string, terminal: boolean): Promise<void> =>
      deps.board.park(messageId, recipientSessionId, {
        nextAttemptAt: terminal ? null : now() + backoffMs(attempts),
        lastStatus: status,
        lastReason: reason,
      });

    const recipient = await deps.directory.get(recipientSessionId);
    if (!recipient) return park("refused", "the recipient has no peer identity", true);
    if (!(await deps.featureFlags.enabled(PEER_COORDINATION_FLAG, recipient.scopeId))) {
      return park("parked", "peer coordination is off for the recipient's scope", false);
    }
    if (await deps.coordination.sessionStopped(recipientSessionId)) {
      return park("stopped", "the recipient was stopped", true);
    }
    const [message, session] = await Promise.all([
      deps.board.get(recipient.orgId, messageId),
      deps.sessions.get(recipientSessionId),
    ]);
    if (!message) return park("refused", "the message is gone", true);
    if (!session) return park("refused", "the recipient session is gone", true);
    const sender = await deps.directory.get(message.senderSessionId);
    if (!sender) return park("refused", "the sender has no peer identity", true);

    const parsed = parseScopeId(session.scopeId);
    const kind = CONVERSATION_KIND_BY_SCOPE[parsed.kind ?? ""];
    if (!kind) return park("refused", "the recipient's scope cannot receive a peer turn", true);
    const actorDisplayName = await deps.peopleDirectory
      ?.get(recipient.executionActorId)
      .then((person) => person?.displayName)
      .catch(() => undefined);
    const redeliveryKey = `peer:${messageId}:${recipientSessionId}`;
    const request: TurnRequest = {
      surface: "peer",
      actor: {
        externalId: recipient.executionActorId,
        ...(actorDisplayName ? { displayName: actorDisplayName } : {}),
      },
      conversation: {
        kind,
        threadRef: session.threadRef,
        ...(kind === "dm" ? {} : { channelRef: parsed.ref }),
        audience: [
          { externalId: recipient.executionActorId, ...(actorDisplayName ? { displayName: actorDisplayName } : {}) },
        ],
      },
      text: message.text,
      origin: {
        kind: "peer",
        senderSessionId: sender.sessionId,
        senderAgentName: sender.agentName,
        messageId,
      },
      redeliveryKey,
      async: true,
    };

    let result: TurnResult;
    try {
      result = await deps.turn(request);
    } catch (error) {
      swallow("peer-dispatcher: turn", error);
      return park("error", "the turn threw", false);
    }

    const retire = async (runId: string | null): Promise<void> => {
      const linked = runId ?? (await deps.runs.getByDedupKey(redeliveryKey))?.id ?? null;
      await deps.board.retire(messageId, recipientSessionId, {
        runId: linked,
        dispatchedAt: now(),
        consumedAt: linked ? null : now(),
        lastStatus: result.status,
      });
    };

    if (result.status === "silent") return retire(null);
    if (result.status === "refused") {
      const roster = result.reason === ROSTER_RACE_REFUSAL;
      return park("refused", result.reason ?? "refused", !roster);
    }
    if (result.status === "pending_approval") return park("pending_approval", "a human approval is outstanding", false);
    if (result.status !== "queued" && result.status !== "ok") {
      return park(result.status, "the turn did not deliver", false);
    }
    const runId = "runId" in result ? (result.runId ?? null) : null;
    if (result.steered === true && !(await deps.signals.hasDedupeKey(redeliveryKey))) {
      return park("steered", "the steer was not delivered", false);
    }
    return retire(runId);
  };

  const consume = async (): Promise<void> => {
    for (const row of await deps.board.awaitingConsumption(BATCH_LIMIT)) {
      const run = await deps.runs.get(row.runId!);
      if (run && !isTerminal(run.status)) continue;
      await deps.board.markConsumed(row.messageId, row.recipientSessionId, now());
    }
  };

  const tick = async (): Promise<void> => {
    const record = await deps.featureFlags.get(PEER_COORDINATION_FLAG);
    if (!record?.enabledScopes.length) return;
    const claimed = await deps.board.claimDue({ now: now(), leaseMs: CLAIM_LEASE_MS, limit: BATCH_LIMIT });
    for (const row of claimed) await dispatch(row.messageId, row.recipientSessionId, row.attempts);
    await consume();
  };

  return {
    tick,
    sweeper: (intervalMs) => createSweeper(tick, intervalMs, { label: "peer-dispatcher" }),
  };
}
