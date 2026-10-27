import type { GapWork } from "../sessions/session-store.ts";
import type { NewItem } from "../sessions/items.ts";
import type { ToolResultScreenInput } from "../security/security-screen.ts";
import type { ToolContext } from "../tools/primitives.ts";
import type { ScopeId } from "../types.ts";
import type { GoalGovernor, GoalRecord } from "./goal.ts";
import type { GrindMeter } from "./grind.ts";
import type { HarnessHandoff } from "./runtime-types.ts";

interface PendingApproval {
  command: string;
  reason: string;
  kind?: "approval";
  matched?: string;
  purpose?: string;
  approvalKey?: string;
  summary?: string;
  grantModes?: { session: boolean; always: boolean };
}

type Emit = (item: NewItem) => void | Promise<unknown>;

export interface TurnToolStateInit {
  current: ToolContext | null;
  emit?: Emit;
  scopeLabel?: ScopeId;
  runtimeActorId?: string;
  pollFire?: boolean;
  shutdown?: AbortSignal;
  abortSignal?: AbortSignal;
  observeToolResult?: (input: ToolResultScreenInput) => void;
  toolApprovalGate?: (callKey: string) => boolean;
  onGapWork?: (work: GapWork) => void;
  goal?: GoalRecord | null;
  saveGoal?: (goal: GoalRecord) => Promise<void>;
  governGoal?: GoalGovernor;
  goalMeter?: GrindMeter;
  goalRound?: number;
  modelHasPrices?: () => boolean;
  goalRecentWork?: () => string;
  runtimeHandoff?: HarnessHandoff;
  pausedOnApproval?: boolean;
  silentRequested?: boolean;
}

export interface ToolRuntime {
  readonly current: ToolContext | null;
  readonly scopeLabel: ScopeId | undefined;
  readonly runtimeActorId: string | undefined;
  readonly pollFire: boolean;
  readonly shutdown: AbortSignal | undefined;
  readonly abortSignal: AbortSignal | undefined;
  readonly emit: Emit | undefined;
  readonly observeToolResult: ((input: ToolResultScreenInput) => void) | undefined;
  approves(callKey: string): boolean;
  approvedCall(callId: string): string | undefined;
  holdApproval(callId: string, callKey: string): () => void;
  reportGapWork(work: GapWork): void;
  runtimeMutationPending(): boolean;
  beginRuntimeMutation(): Promise<void>;
  endRuntimeMutation(): void;
  trackRuntimeCall<T>(call: Promise<T>): Promise<T>;
}

export interface TurnGoal {
  current(): GoalRecord | null | undefined;
  set(goal: GoalRecord | null): void;
  save(goal: GoalRecord): Promise<void>;
  openedThisTurn(): boolean;
  markOpened(): void;
  round(): number;
  setRound(round: number): void;
  meter(): GrindMeter | undefined;
  setMeter(meter: GrindMeter): void;
  modelHasPrices(): boolean | undefined;
  setModelHasPrices(check: () => boolean): void;
  governor(): GoalGovernor | undefined;
  recentWork(): string;
  setRecentWork(read: () => string): void;
}

export interface TurnHalt {
  handoff(): HarnessHandoff | undefined;
  handOff(handoff: HarnessHandoff): void;
  approvals(): PendingApproval[];
  pauseForApproval(approval: PendingApproval): void;
  pausedOnApproval(): boolean;
  silent(): boolean;
  setSilent(silent: boolean): void;
  stopsTools(): boolean;
  halted(): boolean;
}

export interface TurnToolState {
  readonly tools: ToolRuntime;
  readonly goal: TurnGoal;
  readonly halt: TurnHalt;
  routeEmit(emit: Emit | undefined): void;
  bindAbort(signal: AbortSignal | undefined): void;
  stopObserving(): void;
  reportGapWorkTo(sink: ((work: GapWork) => void) | undefined): void;
}

function createTurnHalt(init: TurnToolStateInit): TurnHalt {
  let handoff = init.runtimeHandoff;
  const approvals: PendingApproval[] = [];
  let paused = init.pausedOnApproval === true;
  let silent = init.silentRequested === true;
  return {
    handoff: () => handoff,
    handOff: (next) => {
      handoff = next;
    },
    approvals: () => approvals,
    pauseForApproval: (approval) => {
      approvals.push(approval);
      paused = true;
    },
    pausedOnApproval: () => paused,
    silent: () => silent,
    setSilent: (next) => {
      silent = next;
    },
    stopsTools: () => paused || silent || !!handoff,
    halted: () => !!handoff || silent || paused || approvals.length > 0,
  };
}

function createTurnGoal(init: TurnToolStateInit): TurnGoal {
  const { saveGoal, governGoal } = init;
  let goal = init.goal;
  let opened = false;
  let round = init.goalRound ?? 0;
  let meter = init.goalMeter;
  let hasPrices = init.modelHasPrices;
  let recentWork = init.goalRecentWork;
  return {
    current: () => goal,
    set: (next) => {
      goal = next;
    },
    save: async (record) => {
      await saveGoal?.(record);
    },
    openedThisTurn: () => opened,
    markOpened: () => {
      opened = true;
    },
    round: () => round,
    setRound: (next) => {
      round = next;
    },
    meter: () => meter,
    setMeter: (next) => {
      meter = next;
    },
    modelHasPrices: () => hasPrices?.(),
    setModelHasPrices: (check) => {
      hasPrices = check;
    },
    governor: () => governGoal,
    recentWork: () => recentWork?.() ?? "",
    setRecentWork: (read) => {
      recentWork = read;
    },
  };
}

export function createTurnToolState(init: TurnToolStateInit): TurnToolState {
  const { toolApprovalGate } = init;
  let emit = init.emit;
  let abortSignal = init.abortSignal;
  let observeToolResult = init.observeToolResult;
  let onGapWork = init.onGapWork;
  const approvedCalls = new Map<string, string>();
  let mutationPending = false;
  const inFlight = new Set<Promise<unknown>>();
  const tools: ToolRuntime = {
    current: init.current,
    scopeLabel: init.scopeLabel,
    runtimeActorId: init.runtimeActorId,
    pollFire: init.pollFire === true,
    shutdown: init.shutdown,
    get abortSignal() {
      return abortSignal;
    },
    get emit() {
      return emit;
    },
    get observeToolResult() {
      return observeToolResult;
    },
    approves: (callKey) => !!toolApprovalGate?.(callKey),
    approvedCall: (callId) => approvedCalls.get(callId),
    holdApproval: (callId, callKey) => {
      approvedCalls.set(callId, callKey);
      return () => approvedCalls.delete(callId);
    },
    reportGapWork: (work) => onGapWork?.(work),
    runtimeMutationPending: () => mutationPending,
    beginRuntimeMutation: async () => {
      mutationPending = true;
      await Promise.allSettled(inFlight);
    },
    endRuntimeMutation: () => {
      mutationPending = false;
    },
    trackRuntimeCall: async (call) => {
      inFlight.add(call);
      try {
        return await call;
      } finally {
        inFlight.delete(call);
      }
    },
  };
  return {
    tools,
    goal: createTurnGoal(init),
    halt: createTurnHalt(init),
    routeEmit: (next) => {
      emit = next;
    },
    bindAbort: (signal) => {
      abortSignal = signal;
    },
    stopObserving: () => {
      observeToolResult = undefined;
    },
    reportGapWorkTo: (sink) => {
      onGapWork = sink;
    },
  };
}
