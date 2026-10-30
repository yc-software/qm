import type { ReplayImageLoader } from "./replay-images.ts";
import type { ResumableToolCall } from "../core/turn-resume.ts";
import type { DocumentInput } from "../core/documents.ts";
import type { RuntimeControl, TurnHandoff } from "./runtime-types.ts";
import type {
  AttachmentMeta,
  ClientToolDeclaration,
  ConversationTurn,
  ScopeId,
  Session,
  SessionEntry,
  TurnRequest,
  TurnRuntime,
} from "../types.ts";
import type { LlmCallUsage, LlmTransportMeta, NewEntry } from "../sessions/session-store.ts";
import type { OverheardEntryPayload } from "./replay.ts";
import type { GoalRecord } from "./goal.ts";
import type { GrindMeter } from "./goal.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import type { ProviderKeys } from "../model/model-runtime.ts";
import type { ToolContext } from "../tools/primitives.ts";
import type { SecurityScreenVerdict, ToolResultScreen, ToolResultScreenInput } from "../security/security-posture.ts";

export interface RuntimeChoice {
  modelId: string;
  effortLevel?: string;
  fastMode?: boolean;
}

interface TurnImage {
  mimeType: string;
  dataBase64: string;
  artifactId?: string;
}

export interface TurnLlmRequestRecord {
  turnSeq: number | null;
  step: number;
  model: string;
  promptEnvelope?: unknown;
  truncated: boolean;
  transport?: LlmTransportMeta | null;
  usage?: LlmCallUsage | null;
}

export interface ScreenSecurityInput {
  payload: string;
  modelId?: string;
  systemPrompt?: string;
  signal: AbortSignal;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: TurnLlmRequestRecord, signal?: AbortSignal): void | Promise<void>;
}

export interface AgentTurnInput {
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
  images?: TurnImage[];
  prepareSteer?(
    text: string,
    request?: TurnRequest,
  ): Promise<{
    text: string;
    attachments?: AttachmentMeta[];
    images?: TurnImage[];
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
  history: SessionEntry[];
  goal?: GoalRecord | null;
  goalMeter?: GrindMeter;
  saveGoal?(goal: GoalRecord): Promise<void>;
  goalInbox?: import("./goal.ts").GoalInbox;
  tools: ToolContext;
  mcpTools?: McpToolDescriptor[];
  toolApprovalGate?(tool: string, callKey?: string): boolean;
  emit(entry: NewEntry): Promise<SessionEntry>;
  resumeToolCall?: ResumableToolCall;
  scopeLabel: ScopeId;
  orgScopeId: ScopeId;
  providerKeys?: ProviderKeys;
  runtimePinned?: boolean;
  onRuntime?(runtime: TurnRuntime): void;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: TurnLlmRequestRecord, signal?: AbortSignal): void | Promise<void>;
  onProgress?(p: { toolCalls: number; tokens?: number }): void;
  onModelRequest?(): void;
  onDelta?(chunk: string): void;
  onReasoningDelta?(step: string, index: number, chunk: string): void;
  onTextBlockStart?(phase?: "commentary" | "final_answer"): void | Promise<void>;
  onToolCallStart?(name: string): void;
  screenToolResult?(input: ToolResultScreenInput): Promise<ToolResultScreen>;
  governGoal?: import("./goal.ts").GoalGovernor;
}

export interface AgentTurnResult {
  runtimeHandoff?: TurnHandoff;
  reply: string;
  silent?: boolean;
  stopped?: true;
  stoppedByUser?: true;
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

export interface DetectInput {
  session: Session;
  message: string;
  recentContext: string;
  threadOpener?: string;
  systemPrompt: string;
  reactionGuidance?: string;
  history: SessionEntry[];
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: TurnLlmRequestRecord, signal?: AbortSignal): void | Promise<void>;
}

export interface DetectResult {
  respond: boolean;
  reactions?: string[];
  reason?: string;
}

export interface CompactInput {
  session: Session;
  history: SessionEntry[];
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
}

export interface ModelUtilities {
  shouldRespond?(input: DetectInput): Promise<DetectResult>;
  compactHistory?(input: CompactInput): Promise<string>;
  contextTokenBudget?(scopeLabel?: string, model?: string): number | undefined;
  oneShot?(systemPrompt: string, prompt: string): Promise<string | undefined>;
  judge?(systemPrompt: string, prompt: string, signal?: AbortSignal): Promise<string | undefined>;
  screenSecurity?(input: ScreenSecurityInput): Promise<SecurityScreenVerdict | undefined>;
  pickAckEmoji?(text: string, candidates: readonly string[]): Promise<string | undefined>;
  generateTitle?(transcript: string): Promise<string | undefined>;
  summarizeApproval?(command: string, reason: string, purpose?: string): Promise<string | undefined>;
}

export interface Agent extends ModelUtilities {
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
  close?(): Promise<void> | void;
  resetSession?(sessionId: string): Promise<void> | void;
}
