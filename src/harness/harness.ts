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
import type { ProviderKeys } from "./pi-harness.ts";
import type { ToolContext } from "../tools/primitives.ts";
import type { SecurityScreenVerdict } from "../security/security-posture.ts";
import {
  messageApprovalContinuationPrompt,
  type MessageApprovalContinuation,
  type MessageApprovalToolInvocation,
  type MessageApprovalToolPermit,
} from "../core/message-approval.ts";
import {
  MESSAGE_APPROVAL_STAGE_FAILURE,
  NonRetryableTurnError,
  STAGED_MESSAGE_APPROVAL_FAILURE,
} from "../core/turn-error.ts";

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

interface HarnessContinuationInstruction {
  kind: "message_approval";
  value: MessageApprovalContinuation;
  hidden: true;
}

interface HarnessSecurityScreenInput {
  payload: string;
  signal: AbortSignal;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: HarnessLlmRequestRecord, signal?: AbortSignal): void | Promise<void>;
}

/**
 * Derived per-turn Codex auth: access + id token only. The refresh token
 * stays in the keychain; the harness (and its jail) never see it.
 */
export interface CodexTurnAuth {
  accessToken: string;
  idToken: string;
  accountId?: string;
  expiresAt?: number;
}

export interface HarnessTurnInput {
  session: Session;
  runId?: string;
  cancel?: AbortSignal;
  input: string;
  continuationInstruction?: HarnessContinuationInstruction;
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
  messageApprovals?: boolean;
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
  providerKeys?: ProviderKeys;
  runtimePinned?: boolean;
  claudeOauthToken?: string;
  codexAuth?: CodexTurnAuth;
  recordModelCall(rec: { model: string; inputTokens: number; entryCount: number }): void;
  recordLlmRequest?(rec: HarnessLlmRequestRecord, signal?: AbortSignal): void | Promise<void>;
  onProgress?(p: { toolCalls: number; tokens?: number }): void;
  onGapWork?(sink: (work: GapWork) => void): void;
  onDelta?(chunk: string): void;
  onTextBlockStart?(): void;
  screenToolResult?(tool: string, result: string, unscreenable: boolean): Promise<boolean | "unscreened">;
  beforeToolInvocation?(invocation: MessageApprovalToolInvocation): Promise<MessageApprovalToolPermit | void>;
}

export function harnessTurnInputText(turn: Pick<HarnessTurnInput, "input" | "continuationInstruction">): string {
  return turn.continuationInstruction?.kind === "message_approval"
    ? messageApprovalContinuationPrompt(turn.continuationInstruction.value)
    : turn.input;
}

export function harnessDelegationAllowed(
  turn: Pick<HarnessTurnInput, "readOnly" | "continuationInstruction">,
): boolean {
  return !turn.readOnly && turn.continuationInstruction?.kind !== "message_approval";
}

export function harnessPersistedInputText(turn: Pick<HarnessTurnInput, "input">): string {
  return turn.input;
}

export function harnessPersistedProviderRecord(
  turn: Pick<HarnessTurnInput, "continuationInstruction">,
  payload: unknown,
  state?: { generated?: boolean; messageApprovalAttempted?: boolean },
): { payload: unknown; hidden: boolean } {
  return turn.continuationInstruction?.hidden || (state?.generated === true && state.messageApprovalAttempted === true)
    ? { payload: { omitted: true }, hidden: true }
    : { payload, hidden: false };
}

export function harnessCapturedPromptEnvelope(
  turn: Pick<HarnessTurnInput, "continuationInstruction">,
  envelope: unknown,
): unknown {
  const captured = turn.continuationInstruction ? envelopeWithoutMessages(envelope) : envelope;
  return harnessPersistedProviderRecord(turn, captured).payload;
}

export interface HarnessTurnResult {
  reply: string;
  silent?: boolean;
  messageApprovalAttempted?: true;
  messageApprovalStaged?: true;
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

async function runApprovalPrivateTurn(
  implementation: HarnessImplementation,
  turn: HarnessTurnInput,
): Promise<HarnessTurnResult> {
  if (!turn.messageApprovals || !turn.tools.stageMessageApproval) return implementation.runTurn(turn);
  const entries: Array<{ entry: NewEntry; provisional: SessionEntry }> = [];
  const tape: NewTapeRecord[] = [];
  const requests: HarnessLlmRequestRecord[] = [];
  const stream: Array<{ type: "delta"; chunk: string } | { type: "block" }> = [];
  const seqs = new Map<number, number>();
  let triggerPersisted = false;
  let provisionalSeq = -1;
  let attempted = false;
  let staged = false;
  let tapeWriteFailed = false;
  const stageMessageApproval = turn.tools.stageMessageApproval.bind(turn.tools);
  const privateTurn: HarnessTurnInput = {
    ...turn,
    tools: new Proxy(turn.tools, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "stageMessageApproval") {
          if (!attempted || typeof value !== "function") return value;
          return async () => {
            throw new NonRetryableTurnError(MESSAGE_APPROVAL_STAGE_FAILURE);
          };
        }
        return async (...args: Parameters<NonNullable<ToolContext["stageMessageApproval"]>>) => {
          if (attempted) throw new NonRetryableTurnError(MESSAGE_APPROVAL_STAGE_FAILURE);
          attempted = true;
          const result = await stageMessageApproval(...args);
          if (result.ok) staged = true;
          return result;
        };
      },
    }),
    emit: async (entry) => {
      if (!triggerPersisted && entry.type === "user") {
        triggerPersisted = true;
        return turn.emit(entry);
      }
      const provisional: SessionEntry = {
        sessionId: turn.session.id,
        seq: provisionalSeq--,
        parentSeq: null,
        type: entry.type,
        payload: entry.payload,
        scopeLabel: entry.scopeLabel,
        createdAt: Date.now(),
      };
      entries.push({ entry, provisional });
      return provisional;
    },
    ...(turn.tape
      ? {
          tape: async (record: NewTapeRecord) => {
            tape.push(record);
          },
        }
      : {}),
    ...(turn.recordLlmRequest
      ? {
          recordLlmRequest: async (record: HarnessLlmRequestRecord) => {
            requests.push(record);
          },
        }
      : {}),
    ...(turn.onDelta
      ? {
          onDelta: (chunk: string) => {
            stream.push({ type: "delta", chunk });
          },
        }
      : {}),
    ...(turn.onTextBlockStart
      ? {
          onTextBlockStart: () => {
            stream.push({ type: "block" });
          },
        }
      : {}),
  };
  const flushPrivateTurn = async (): Promise<void> => {
    for (const pending of entries) {
      const actual = await turn.emit({
        ...pending.entry,
        ...(attempted ? { payload: { omitted: true, hidden: true } } : {}),
      });
      seqs.set(pending.provisional.seq, actual.seq);
    }
    for (const record of tape) {
      const generated = record.kind !== "message" || record.meta?.bareText === undefined;
      const remapped = {
        ...record,
        ...(record.entrySeq !== undefined ? { entrySeq: seqs.get(record.entrySeq) ?? record.entrySeq } : {}),
        ...(record.coversEntrySeq !== undefined
          ? { coversEntrySeq: seqs.get(record.coversEntrySeq) ?? record.coversEntrySeq }
          : {}),
        ...(attempted && generated ? { payload: { omitted: true }, meta: { ...record.meta, hidden: true } } : {}),
      };
      try {
        await turn.tape!(remapped);
      } catch {
        tapeWriteFailed = true;
      }
    }
    for (const request of requests) {
      await turn.recordLlmRequest!({
        ...request,
        ...(request.turnSeq !== null ? { turnSeq: seqs.get(request.turnSeq) ?? request.turnSeq } : {}),
        ...(attempted ? { promptEnvelope: { omitted: true } } : {}),
      });
    }
    if (!attempted) {
      for (const event of stream) {
        if (event.type === "block") turn.onTextBlockStart?.();
        else turn.onDelta?.(event.chunk);
      }
    }
  };
  let result: HarnessTurnResult;
  try {
    result = await implementation.runTurn.call(implementation, privateTurn);
  } catch (error) {
    try {
      await flushPrivateTurn();
    } catch (flushError) {
      if (attempted)
        throw new NonRetryableTurnError(staged ? STAGED_MESSAGE_APPROVAL_FAILURE : MESSAGE_APPROVAL_STAGE_FAILURE);
      throw flushError;
    }
    if (attempted)
      throw new NonRetryableTurnError(staged ? STAGED_MESSAGE_APPROVAL_FAILURE : MESSAGE_APPROVAL_STAGE_FAILURE);
    throw error;
  }
  try {
    await flushPrivateTurn();
  } catch (error) {
    if (attempted)
      throw new NonRetryableTurnError(staged ? STAGED_MESSAGE_APPROVAL_FAILURE : MESSAGE_APPROVAL_STAGE_FAILURE);
    throw error;
  }
  if (attempted && !staged) {
    return {
      reply: MESSAGE_APPROVAL_STAGE_FAILURE,
      messageApprovalAttempted: true,
      ...(result.stopped ? { stopped: true } : {}),
      ...(result.modelCalls !== undefined ? { modelCalls: result.modelCalls } : {}),
      ...(result.cacheUsage ? { cacheUsage: result.cacheUsage } : {}),
      ...(result.compileMs !== undefined ? { compileMs: result.compileMs } : {}),
      ...(tapeWriteFailed || result.tapeWriteFailed ? { tapeWriteFailed: true } : {}),
    };
  }
  return {
    ...result,
    ...(tapeWriteFailed ? { tapeWriteFailed: true } : {}),
    ...(staged ? { reply: "", silent: true, messageApprovalAttempted: true, messageApprovalStaged: true } : {}),
  };
}

export function defineHarness(
  profile: HarnessAdapterProfile,
  implementation: HarnessImplementation,
  tools: HarnessToolPresentation = { name: (coreName) => coreName },
): Harness {
  const turns: HarnessTurnController = {
    runTurn: (turn) => runApprovalPrivateTurn(implementation, turn),
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
