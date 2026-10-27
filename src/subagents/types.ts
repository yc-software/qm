import type { SessionMailbox, SessionMessage } from "../sessions/session-mailbox.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { CoreSearch } from "../search/core-search.ts";
import type { ScopeId, Session } from "../types.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { SwarmBoard } from "../swarms/swarm-board.ts";
import type { SwarmInput, SwarmResult } from "../swarms/swarm.ts";

export interface SessionOpenInput {
  requestId?: string;
  task: string;
  name?: string;
  readOnly?: boolean;
  model?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
}

export type SessionOpenResult =
  { ok: true; sessionId: string; title: string; liveRunsRemaining: number } | { ok: false; message: string };

export interface SessionWriteInput {
  target: string;
  peer?: boolean;
  text?: string;
  interrupt?: boolean;
  followup?: boolean;
  requestId?: string;
}

export type SessionWriteResult =
  | {
      ok: true;
      sessionId: string;
      title: string;
      delivered: "steered" | "queued_turn" | "interrupted" | "queued_message";
    }
  | { ok: false; message: string };

export interface SessionReadInput {
  target?: string;
  peer?: boolean;
  limit?: number;
  maxChars?: number;
}

export interface SessionChildSummary {
  sessionId: string;
  title: string;
  status: "running" | "pending" | "idle";
  lastSaid?: string;
}

export interface SessionStartInput {
  fork: boolean;
  text?: string;
  title?: string;
}

export type SessionStartResult =
  { ok: true; sessionId: string; title: string; refused?: string } | { ok: false; message: string };

export interface SessionSummary {
  sessionId: string;
  title: string;
  status: "running" | "pending" | "idle";
  current: boolean;
}

export type SessionListResult = { ok: true; sessions: SessionSummary[] } | { ok: false; message: string };

export type SessionReadResult =
  | { ok: true; mode: "children"; children: SessionChildSummary[] }
  | { ok: true; mode: "transcript"; sessionId: string; title: string; status: string; rendered: string }
  | { ok: false; message: string };

export interface SessionSyscallBinding {
  session: Session;
  scopeId: ScopeId;
  orgScopeId?: ScopeId;
  liveTurn?: boolean;
  request: Pick<
    OrchestratorInput,
    | "cancel"
    | "surface"
    | "surfaceTools"
    | "deliveryCandidates"
    | "unattendedGrants"
    | "privateSessionMessage"
    | "sessionMessageDepth"
    | "runId"
    | "conversation"
    | "actor"
    | "deliveryTarget"
    | "timezone"
    | "readOnly"
    | "scopeVersion"
    | "sessionParticipantIds"
    | "source"
    | "slackSource"
    | "externalSlack"
  > & { origin?: OrchestratorInput["origin"] };
}

export interface SessionSyscalls {
  receive?(timeoutMs?: number): Promise<SessionMessage[]>;
  acknowledge?(ids: string[]): Promise<void>;
  open(input: SessionOpenInput): Promise<SessionOpenResult>;
  write(input: SessionWriteInput): Promise<SessionWriteResult>;
  read(input: SessionReadInput): Promise<SessionReadResult>;
  search?(input: { query: string; limit?: number }): ReturnType<CoreSearch["search"]>;
  list?(): Promise<SessionListResult>;
  start?(input: SessionStartInput): Promise<SessionStartResult>;
  swarm?(input: SwarmInput): Promise<SwarmResult>;
}

export interface SessionSyscallsFactory {
  forTurn(binding: SessionSyscallBinding): SessionSyscalls;
}

export interface SessionSyscallDeps {
  mailbox: SessionMailbox;
  board?: SwarmBoard;
  sessions: Pick<
    SessionStore,
    | "get"
    | "getByThread"
    | "getOrCreateByThread"
    | "setParentSession"
    | "setSpawnMeta"
    | "childrenOf"
    | "descendantsOf"
    | "addParticipant"
    | "updateTitle"
    | "getItems"
    | "latestItemSeq"
    | "visibleItems"
    | "getForParticipant"
  >;
  runs: Pick<
    RunStore,
    "enqueue" | "inFlightForThread" | "latestForThread" | "getByDedupKey" | "get" | "withdraw" | "cancelTree"
  >;
  signals: Pick<RunSignalStore, "send" | "pending">;
  maxAttempts: number;
  treeRunCap?: number;
  advisoryLock: AdvisoryLock;
  prepareRequest?: (request: OrchestratorInput) => Promise<OrchestratorInput>;
  authorize?: (session: Session, actorId: string) => Promise<boolean>;
  validateRuntime?: (input: SessionOpenInput, scopeId: ScopeId) => Promise<void>;
  conversations?: {
    search?: CoreSearch["search"];
    list(actorId: string): Promise<Session[]>;
    start(
      actorId: string,
      input: {
        scopeId: ScopeId;
        forkOf?: string;
        text?: string;
        title?: string;
        origin?: OrchestratorInput["origin"];
        sessionSenderId?: string;
        delegatingRunId?: string;
      },
    ): Promise<{ session: Session; refused?: string } | { error: string }>;
  };
}
