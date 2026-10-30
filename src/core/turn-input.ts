import type { TraceCarrier } from "../../plugins/chassis/src/error-reporting.ts";
import type { GoalCreateInput } from "../agent/goal.ts";
import type { RunStop } from "../runs/run-store.ts";
import type { Conversation, Principal, TurnRequest } from "../types.ts";
import type { SurfaceContextQuery, SurfaceContextResult } from "../reach/reach.ts";
import type { TurnOrigin } from "./turn-origin.ts";
import type { ModelAccount } from "../resolution/config-store.ts";
import type { SwarmTurn } from "../swarms/swarm-service.ts";

export interface OrchestratorInput extends Omit<
  TurnRequest,
  | "surface"
  | "actor"
  | "conversation"
  | "idempotencyKey"
  | "spawned"
  | "async"
  | "triggerTs"
  | "entryTs"
  | "triggered"
  | "securityScreenData"
  | "triggerDestination"
  | "ownerKeychainUnion"
  | "unprompted"
  | "liveActor"
> {
  modelAccount?: ModelAccount;
  surface?: string;
  privateSessionMessage?: true;
  delegatingRunId?: string;
  sessionMessageDepth?: number;
  actor: Principal;
  conversation: Conversation;
  origin: TurnOrigin;
  runId?: string;
  attempt?: number;
  resumeCause?: RunStop;
  runLeaseToken?: string;

  runStartedAt?: number;
  finalAttempt?: boolean;
  background?: boolean;
  cancel?: AbortSignal;
  shutdown?: AbortSignal;
  sessionParticipantIds?: readonly string[];
  scopeVersion?: string;
  swarm?: SwarmTurn;
  swarmGoal?: GoalCreateInput & { assignedAt: number };
  trace?: TraceCarrier;
}

export interface SurfaceContextPuller {
  pull(source: string, query: SurfaceContextQuery): Promise<SurfaceContextResult | null>;
  searchLive?(source: string, query: SurfaceContextQuery): Promise<SurfaceContextResult | null>;
}
