import type { AttachmentMeta, ConversationTurn, ScopeId, Session, SessionEntry } from "../types.ts";
import type {
  GapPhases,
  GapWork,
  LlmCallUsage,
  LlmTransportMeta,
  NewEntry,
  NewTapeRecord,
  TapeRecord,
} from "../sessions/session-store.ts";
export type { GapWork } from "../sessions/session-store.ts";
import type { OverheardEntryPayload } from "./replay.ts";
import type { ToolContext } from "../tools/primitives.ts";
import type { SecurityScreenVerdict } from "../security/security-posture.ts";

interface HarnessImage {
  mimeType: string;
  dataBase64: string;
  artifactId?: string;
}

export function envelopeWithoutMessages(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([k]) => k !== "messages"));
}

export interface HarnessLlmRequestRecord {
  turnSeq: number | null;
  step: number;
  model: string;
  promptEnvelope?: unknown;
  truncated: boolean;
  transport?: LlmTransportMeta | null;
  ttftMs?: number | null;
  durationMs?: number | null;
  stepGapMs?: number | null;
  toolWallMs?: number[] | null;
  gapPhases?: GapPhases | null;
  usage?: LlmCallUsage | null;
}

interface HarnessSecurityScreenInput {
  payload: string;
  signal: AbortSignal;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: HarnessLlmRequestRecord): void | Promise<void>;
}

export interface HarnessTurnInput {
  session: Session;
  runId?: string;
  cancel?: AbortSignal;
  input: string;
  triggerTs?: string;
  entryTs?: string;
  environment?: string;
  priorTurns?: ConversationTurn[];
  overheard?: OverheardEntryPayload[];
  attachments?: AttachmentMeta[];
  images?: HarnessImage[];
  model?: string;
  harness?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  readOnly?: boolean;
  surfaceTools?: boolean;
  surfaceName?: string;
  pollFire?: boolean;
  turnWallClockMs?: number;
  systemPrompt: string;
  systemCacheBoundary?: number;
  history: SessionEntry[];
  tools: ToolContext;
  credentialExecServices?: readonly { service: string; binary: string }[];
  screenExternalContent?(input: {
    content: string;
    tool: string;
    source: string;
  }): Promise<SecurityScreenVerdict | undefined>;
  toolApprovalGate?(tool: string): boolean;
  emit(entry: NewEntry): Promise<SessionEntry>;
  tape?(rec: NewTapeRecord): Promise<unknown>;
  tapeRows?: TapeRecord[];
  tapeMode?: "shadow" | "serve";
  tapeFold?: unknown[];
  scopeLabel: ScopeId;
  orgScopeId: ScopeId;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: HarnessLlmRequestRecord): void | Promise<void>;
  onProgress?(p: { toolCalls: number; tokens?: number }): void;
  onGapWork?(sink: (work: GapWork) => void): void;
  onDelta?(chunk: string): void;
  onTextBlockStart?(): void;
  screenToolResult?(tool: string, result: string, unscreenable: boolean): Promise<boolean | "unscreened">;
}

export interface HarnessTurnResult {
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
  }>;
  pausedOnApproval?: boolean;
  modelCalls?: number;
  cacheUsage?: { cacheRead: number; cacheWrite: number; uncachedInput: number };
  compileMs?: number;
  tapeWriteFailed?: boolean;
}

export interface HarnessDetectInput {
  session: Session;
  message: string;
  recentContext: string;
  threadOpener?: string;
  systemPrompt: string;
  reactionGuidance?: string;
  history: SessionEntry[];
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
}

export interface HarnessDetectResult {
  respond: boolean;
  reactions?: string[];
  reason?: string;
}

export interface HarnessCompactInput {
  session: Session;
  history: SessionEntry[];
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
}

interface HarnessTurnController {
  runTurn(input: HarnessTurnInput): Promise<HarnessTurnResult>;
  close?(): Promise<void> | void;
  resetSession?(sessionId: string): Promise<void> | void;
}

export interface HarnessModelUtilities {
  shouldRespond?(input: HarnessDetectInput): Promise<HarnessDetectResult>;
  compactHistory?(input: HarnessCompactInput): Promise<string>;
  contextTokenBudget?(scopeLabel?: string, model?: string): number | undefined;
  oneShot?(systemPrompt: string, prompt: string): Promise<string | undefined>;
  judge?(systemPrompt: string, prompt: string): Promise<string | undefined>;
  screenSecurity?(input: HarnessSecurityScreenInput): Promise<SecurityScreenVerdict | undefined>;
  pickAckEmoji?(text: string, candidates: readonly string[]): Promise<string | undefined>;
  generateTitle?(transcript: string): Promise<string | undefined>;
  summarizeApproval?(command: string, reason: string, purpose?: string): Promise<string | undefined>;
}

type HarnessControlTransport = "mock" | "in-process" | "sdk" | "http" | "json-rpc" | "api";
type HarnessToolTransport = "mock" | "in-process" | "plugin" | "dynamic" | "in-process-mcp" | "mcp";
type HarnessCapability = "abort" | "steer" | "images" | "thinking-level" | "fast-mode" | "provider-sessions";

export interface HarnessAdapterProfile {
  id: string;
  controlTransport: HarnessControlTransport;
  toolTransport: HarnessToolTransport;
  transcriptFormat: string;
  capabilities: ReadonlySet<HarnessCapability>;
}

export interface HarnessToolPresentation {
  name(coreName: string): string;
}

export interface Harness {
  profile: HarnessAdapterProfile;
  turns: HarnessTurnController;
  models: HarnessModelUtilities;
  tools: HarnessToolPresentation;
}

export type HarnessImplementation = HarnessTurnController & HarnessModelUtilities;

export function defineHarness(
  profile: HarnessAdapterProfile,
  implementation: HarnessImplementation,
  tools: HarnessToolPresentation = { name: (coreName) => coreName },
): Harness {
  const turns: HarnessTurnController = {
    runTurn: implementation.runTurn.bind(implementation),
    ...(implementation.close ? { close: implementation.close.bind(implementation) } : {}),
    ...(implementation.resetSession ? { resetSession: implementation.resetSession.bind(implementation) } : {}),
  };
  const models: HarnessModelUtilities = {
    ...(implementation.shouldRespond ? { shouldRespond: implementation.shouldRespond.bind(implementation) } : {}),
    ...(implementation.compactHistory ? { compactHistory: implementation.compactHistory.bind(implementation) } : {}),
    ...(implementation.contextTokenBudget
      ? { contextTokenBudget: implementation.contextTokenBudget.bind(implementation) }
      : {}),
    ...(implementation.oneShot ? { oneShot: implementation.oneShot.bind(implementation) } : {}),
    ...(implementation.judge ? { judge: implementation.judge.bind(implementation) } : {}),
    ...(implementation.screenSecurity ? { screenSecurity: implementation.screenSecurity.bind(implementation) } : {}),
    ...(implementation.pickAckEmoji ? { pickAckEmoji: implementation.pickAckEmoji.bind(implementation) } : {}),
    ...(implementation.generateTitle ? { generateTitle: implementation.generateTitle.bind(implementation) } : {}),
    ...(implementation.summarizeApproval
      ? { summarizeApproval: implementation.summarizeApproval.bind(implementation) }
      : {}),
  };
  return { profile, turns, models, tools };
}
