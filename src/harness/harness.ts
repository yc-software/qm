import type { ReplayImageLoader } from "./replay-images.ts";
import type { ResumableToolCall } from "../core/turn-resume.ts";
import type { DocumentInput } from "../core/document-inputs.ts";
import type { RuntimeControl, HarnessHandoff } from "./runtime-types.ts";
import type {
  AttachmentMeta,
  ClientToolDeclaration,
  ConversationTurn,
  ScopeId,
  Session,
  TurnRequest,
  TurnRuntime,
} from "../types.ts";
import type { GapPhases, GapWork, LlmCallUsage, LlmTransportMeta } from "../sessions/session-store.ts";
import type { Item, NewItem } from "../sessions/items.ts";
export type { GapWork } from "../sessions/session-store.ts";
import type { OverheardEntryPayload } from "./replay.ts";
import type { GoalRecord } from "./goal.ts";
import type { GrindMeter } from "./grind.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import type { ProviderKeys } from "./pi-model-runtime.ts";
import type { ToolContext } from "../tools/primitives.ts";
import type { SecurityScreenVerdict, ToolResultScreenInput } from "../security/security-screen.ts";

export interface RuntimeChoice {
  modelId: string;
  effortLevel?: string;
  fastMode?: boolean;
}

interface HarnessImage {
  mimeType: string;
  dataBase64: string;
  artifactId?: string;
}

export interface HarnessLlmRequestRecord {
  turnSeq: number | null;
  step: number;
  model: string;
  transport?: LlmTransportMeta | null;
  ttftMs?: number | null;
  durationMs?: number | null;
  stepGapMs?: number | null;
  toolWallMs?: number[] | null;
  gapPhases?: GapPhases | null;
  usage?: LlmCallUsage | null;
}

export interface HarnessSecurityScreenInput {
  payload: string;
  modelId?: string;
  systemPrompt?: string;
  signal: AbortSignal;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: HarnessLlmRequestRecord, signal?: AbortSignal): void | Promise<void>;
}

export interface HarnessTurnInput {
  loadImage?: ReplayImageLoader;
  session: Session;
  runId?: string;
  cancel?: AbortSignal;
  continueTurn?: boolean;
  resumeUserSeq?: number;
  shutdown?: AbortSignal;
  input: string;
  triggerTs?: string;
  entryTs?: string;
  environment?: string;
  timezone?: string;
  priorTurns?: ConversationTurn[];
  overheard?: OverheardEntryPayload[];
  attachments?: AttachmentMeta[];
  images?: HarnessImage[];
  prepareSteer?(
    text: string,
    request?: TurnRequest,
  ): Promise<{
    text: string;
    attachments?: AttachmentMeta[];
    images?: HarnessImage[];
    documents?: DocumentInput[];
    author?: string;
  }>;
  documents?: DocumentInput[];
  runtime?: Partial<RuntimeChoice>;
  runtimePurpose?: import("../resolution/config-store.ts").RuntimePurpose;
  runtimeControl?: RuntimeControl;
  runtimeActorId?: string;
  readOnly?: boolean;
  surfaceTools?: boolean;
  delegateWork?: boolean;
  surfaceName?: string;
  clientTools?: readonly ClientToolDeclaration[];
  pollFire?: boolean;
  turnWallClockMs?: number;
  systemPrompt: string;
  history: Item[];
  goal?: GoalRecord | null;
  goalMeter?: GrindMeter;
  saveGoal?(goal: GoalRecord): Promise<void>;
  tools: ToolContext;
  mcpTools?: McpToolDescriptor[];
  toolApprovalGate?(callKey: string): boolean;
  emit(item: NewItem): Promise<Item>;
  resumeToolCall?: ResumableToolCall;
  scopeLabel: ScopeId;
  orgScopeId: ScopeId;
  providerKeys?: ProviderKeys;
  runtimePinned?: boolean;
  onRuntime?(runtime: TurnRuntime): void;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: HarnessLlmRequestRecord, signal?: AbortSignal): void | Promise<void>;
  onGapWork?(sink: (work: GapWork) => void): void;
  onDelta?(chunk: string): void;
  onReasoningDelta?(step: string, index: number, chunk: string): void;
  onTextBlockStart?(phase?: "commentary" | "final_answer"): void | Promise<void>;
  onToolCallStart?(name: string): void;
  observeToolResult?(input: ToolResultScreenInput): void;
  governGoal?: import("./goal.ts").GoalGovernor;
}

export interface HarnessTurnResult {
  runtimeHandoff?: HarnessHandoff;
  reply: string;
  silent?: boolean;
  stopped?: true;
  pendingApprovals?: Array<{
    command: string;
    reason: string;
    kind?: "approval";
    matched?: string;
    purpose?: string;
    approvalKey?: string;
    grantModes?: { session: boolean; always: boolean };
  }>;
  pausedOnApproval?: boolean;
  modelCalls?: number;
  cacheUsage?: { cacheRead: number; cacheWrite: number; uncachedInput: number };
}

export interface HarnessDetectInput {
  session: Session;
  message: string;
  recentContext: string;
  threadOpener?: string;
  systemPrompt: string;
  reactionGuidance?: string;
  history: Item[];
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
}

export interface HarnessDetectResult {
  respond: boolean;
  reactions?: string[];
  reason?: string;
}

export interface HarnessCompactInput {
  session: Session;
  history: Item[];
  summaryTokenBudget: number;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
}

interface HarnessTurnController {
  runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult>;
}

export interface HarnessModelUtilities {
  shouldRespond?(input: HarnessDetectInput): Promise<HarnessDetectResult>;
  compactHistory?(input: HarnessCompactInput): Promise<string>;
  contextTokenBudget?(scopeLabel?: string, model?: string): number | undefined;
  oneShot?(systemPrompt: string, prompt: string): Promise<string | undefined>;
  judge?(systemPrompt: string, prompt: string, signal?: AbortSignal): Promise<string | undefined>;
  judgeTokenBudget?(): number | undefined;
  screenSecurity?(input: HarnessSecurityScreenInput): Promise<SecurityScreenVerdict | undefined>;
  pickAckEmoji?(text: string, candidates: readonly string[]): Promise<string | undefined>;
  generateTitle?(transcript: string): Promise<string | undefined>;
  summarizeApproval?(command: string, reason: string, purpose?: string): Promise<string | undefined>;
}

export interface Harness {
  turns: HarnessTurnController;
  models: HarnessModelUtilities;
}

export type HarnessImplementation = HarnessTurnController & HarnessModelUtilities;

export function defineHarness({ runTurn, ...models }: HarnessImplementation): Harness {
  return { turns: { runTurn }, models };
}
