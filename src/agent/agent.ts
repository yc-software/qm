import type { ModelRequestPurpose } from "../model/provider-endpoints.ts";
import type { ReplayImageLoader } from "./replay-images.ts";
import type { ResumableToolCall } from "../core/turn-resume.ts";
import type { DocumentInput } from "../core/documents.ts";
import type { RuntimeControl, TurnHandoff } from "./runtime-types.ts";
import type {
  ApprovedToolCallSpec,
  AttachmentMeta,
  ClientToolDeclaration,
  ConversationTurn,
  ScopeId,
  Session,
  StopScope,
  TurnRequest,
  TurnRuntime,
} from "../types.ts";
import type { LlmCallUsage, LlmTransportMeta } from "../sessions/session-store.ts";
import type { Item, NewItem } from "../sessions/items.ts";
import type { OverheardEntryPayload } from "./replay.ts";
import type { GoalRecord } from "./goal.ts";
import type { GrindMeter } from "./goal.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import type { ProviderKeys } from "../model/model-runtime.ts";
import type { ToolContext } from "../tools/primitives.ts";
import type { SurfaceToolPrompt } from "../surfaces/registry.ts";
import type { SecurityScreenVerdict, ToolResultScreen, ToolResultScreenInput } from "../security/security-posture.ts";
import type { TurnPark } from "../runs/run-store.ts";

export interface ApprovedToolCall extends ApprovedToolCallSpec {
  callId: string;
  requestId: string;
}

export type SteeredApproval =
  | { kind: "run"; call: ApprovedToolCall; summary: string; approver: string }
  | { kind: "denied"; summary: string; approver: string }
  | { kind: "ignored" };

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
  signal: AbortSignal;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: TurnLlmRequestRecord): void | Promise<void>;
}

export interface AgentTurnInput {
  loadImage?: ReplayImageLoader;
  session: Session;
  runId?: string;
  cancel?: AbortSignal;
  continueTurn?: boolean;
  resumeUserSeq?: number;
  shutdown?: AbortSignal;
  park?: TurnPark;
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
    authorName?: string;
    withheld?: boolean;
  }>;
  documents?: DocumentInput[];
  runtime?: Partial<RuntimeChoice>;
  runtimePurpose?: import("../resolution/config-store.ts").TurnRuntimePurpose;
  runtimeControl?: RuntimeControl;
  runtimeActorId?: string;
  readOnly?: boolean;
  memoryNotebookOnly?: boolean;
  surfaceTools?: boolean;
  delegateWork?: boolean;
  surfaceName?: string;
  surfacePrompt?: SurfaceToolPrompt;
  clientTools?: readonly ClientToolDeclaration[];
  pollFire?: boolean;
  turnWallClockMs?: number;
  systemPrompt: string;
  history: Item[];
  goal?: GoalRecord | null;
  goalMeter?: GrindMeter;
  saveGoal?(goal: GoalRecord): Promise<void>;
  goalInbox?: import("./goal.ts").GoalInbox;
  tools: ToolContext;
  mcpTools?: McpToolDescriptor[];
  toolApprovalGate?(tool: string, callKey?: string): boolean;
  approvalUnavailable?: string;
  emit(item: NewItem): Promise<Item>;
  resumeToolCall?: ResumableToolCall;
  approvedToolCalls?: ApprovedToolCall[];
  resolveSteeredApproval?(request: TurnRequest): Promise<SteeredApproval>;
  scopeLabel: ScopeId;
  orgScopeId: ScopeId;
  providerKeys?: ProviderKeys;
  runtimePinned?: boolean;
  onRuntime?(runtime: TurnRuntime): void;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: TurnLlmRequestRecord): void | Promise<void>;
  onProgress?(p: { toolCalls: number; tokens?: number }): void;
  onModelRequest?(): void;
  onDelta?(chunk: string): void;
  onReasoningDelta?(step: string, index: number, chunk: string): void;
  onTextBlockStart?(phase?: "commentary" | "final_answer"): void | Promise<void>;
  onToolCallStart?(name: string): void;
  checkReply?(draft: string): Promise<ReplyVerdict | undefined>;
  onInterimReply?(text: string): boolean | Promise<boolean>;
  screenToolResult?(input: ToolResultScreenInput): Promise<ToolResultScreen>;
  governGoal?: import("./goal.ts").GoalGovernor;
}

export interface ReplyVerdict {
  action: "retry" | "prod";
  reason: string;
  message: string;
}

export const REPLY_CHECK_LIMITS: Record<ReplyVerdict["action"], number> = { retry: 2, prod: 1 };

export const replyCheckPrompt = (verdict: ReplyVerdict): string =>
  verdict.action === "prod"
    ? `[system] The reply check says you stopped early; the user has already seen your reply above. ${verdict.message}`
    : `[system] The reply check retracted your reply above; the user sees it marked as retracted. ${verdict.message} Write the full reply again now.`;

export interface AgentTurnResult {
  runtimeHandoff?: TurnHandoff;
  reply: string;
  retracted?: string[];
  prodded?: string[];
  silent?: boolean;
  stopped?: true;
  stopScope?: StopScope;
  stoppedByUser?: true;
  pendingApprovals?: Array<{
    command: string;
    reason: string;
    kind?: "approval";
    matched?: string;
    purpose?: string;
    approvalKey?: string;
    grantModes?: { session: boolean; always: boolean };
    call?: ApprovedToolCallSpec;
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
  history: Item[];
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: TurnLlmRequestRecord): void | Promise<void>;
}

export interface DetectResult {
  respond: boolean;
  reactions?: string[];
  reason?: string;
}

export type SessionRoute = Partial<
  Pick<AgentTurnInput, "scopeLabel" | "runtime" | "runtimePurpose" | "runtimePinned" | "providerKeys">
>;

export interface CompactInput extends SessionRoute {
  session: Session;
  history: Item[];
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
}

export interface ModelUtilities {
  shouldRespond?(input: DetectInput): Promise<DetectResult>;
  compactHistory?(input: CompactInput): Promise<string>;
  contextTokenBudget?(model?: string): number | undefined;
  oneShot?(systemPrompt: string, prompt: string, purpose?: ModelRequestPurpose): Promise<string | undefined>;
  judge?(
    systemPrompt: string,
    prompt: string,
    signal?: AbortSignal,
    purpose?: ModelRequestPurpose,
  ): Promise<string | undefined>;
  screenSecurity?(input: ScreenSecurityInput): Promise<SecurityScreenVerdict | undefined>;
  pickAckEmoji?(text: string, candidates: readonly string[]): Promise<string | undefined>;
  generateTitle?(transcript: string, opts?: { descriptive?: boolean }): Promise<string | undefined>;
  summarizeApproval?(command: string, reason: string, purpose?: string): Promise<string | undefined>;
  suggestNextPrompt?(transcript: string): Promise<string | undefined>;
}

export interface Agent extends ModelUtilities {
  runTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
  close?(): Promise<void> | void;
}
