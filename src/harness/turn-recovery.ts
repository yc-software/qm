import { NonRetryableTurnError } from "../core/turn-error.ts";
import { defaultInteractiveThinkingLevel, modelDisplayName } from "../model/pi-models.ts";
import { swallow } from "../util/errors.ts";
import type { TurnHalt } from "./turn-tool-state.ts";
import type { TurnRequestSettings } from "./turn-request.ts";
import type { HarnessTurnInput } from "./harness.ts";
import { applyTurnEffort, wantsFastMode, withRequestHeaders } from "./pi-model-runtime.ts";
import { EMPTY_ENDING_MIN_BUDGET_MS, type TurnWallClockOutcome } from "./pi-turn-clock.ts";
import type { DocumentInput } from "../core/document-inputs.ts";
import { documentStub } from "../core/document-kinds.ts";
import { type AgentSession } from "@earendil-works/pi-coding-agent";
import { type AssistantMessage } from "@earendil-works/pi-ai";
import { ProviderTurnError } from "../core/turn-error.ts";
import { providerTurnError } from "./provider-error.ts";
import { resolveModel } from "../model/pi-models.ts";

export type AssistantTextSession = Pick<AgentSession, "getLastAssistantText" | "messages">;

export function piFailedAssistant(session: AssistantTextSession): AssistantMessage | undefined {
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant") as
    AssistantMessage | undefined;
  return lastAssistant?.stopReason === "error" ? lastAssistant : undefined;
}

function lastInputTokens(session: AssistantTextSession, failed: AssistantMessage): number | undefined {
  const ok = [...session.messages]
    .reverse()
    .find((m) => m !== failed && m.role === "assistant" && (m as AssistantMessage).stopReason !== "error") as
    AssistantMessage | undefined;
  const u = ok?.usage;
  return u ? u.input + u.cacheRead + u.cacheWrite : undefined;
}

function piAssistantFailure(session: AssistantTextSession): ProviderTurnError | null {
  const failed = piFailedAssistant(session);
  if (!failed) return null;
  const contextWindow = (
    failed.model ? (resolveModel(failed.model) as { contextWindow?: number } | undefined) : undefined
  )?.contextWindow;
  return providerTurnError(failed, { contextWindow, lastInputTokens: lastInputTokens(session, failed) });
}

export const FALLBACK_CODES = new Set(["refusal", "model_unavailable"]);
const DOCUMENT_REJECTION_CODES = new Set(["context_too_long", "bad_request"]);

export function documentsDroppedNote(documents: readonly DocumentInput[]): string {
  return (
    `The model provider rejected an earlier request in this task while it carried these attachments inline ` +
    `(most likely they exceed the model's context), so they were removed from model input. ` +
    documents.map((document) => documentStub(document)).join(" ") +
    ` If the file matters to the request, tell the person it could not be read in full here and read only the parts you need.`
  );
}

const DOCUMENTS_DROPPED_RETRY_NOTE =
  "[system] The previous request failed while it carried inline attachments; they have been replaced with notes on how to read them from saved files. Continue with the request.";

function dropFailedAssistant(session: AgentSession, messagesBefore: number): void {
  const state = session.agent.state;
  for (let i = state.messages.length - 1; i >= messagesBefore; i--) {
    const m = state.messages[i] as { role?: string; stopReason?: string } | undefined;
    if (m?.role === "assistant" && m.stopReason === "error") {
      state.messages = [...state.messages.slice(0, i), ...state.messages.slice(i + 1)];
      break;
    }
  }
}

export function piLastAssistantTextOrThrow(session: AssistantTextSession): string | undefined {
  const err = piAssistantFailure(session);
  if (err) throw err;
  return session.getLastAssistantText();
}

function messagesSince(session: AssistantTextSession, messagesBefore?: number): AssistantTextSession {
  return messagesBefore === undefined
    ? session
    : ({ messages: session.messages.slice(messagesBefore) } as AssistantTextSession);
}

export function piRoundFailed(session: AssistantTextSession, messagesBefore: number): boolean {
  return !!piFailedAssistant(messagesSince(session, messagesBefore));
}

export function piTurnError(session: AssistantTextSession, thrown: unknown, messagesBefore?: number): Error {
  const detailed = piAssistantFailure(messagesSince(session, messagesBefore));
  if (detailed) return detailed;
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

export function providerRefusalError(session: AssistantTextSession, messagesBefore?: number): string | null {
  const err = piAssistantFailure(messagesSince(session, messagesBefore));
  return err && FALLBACK_CODES.has(err.code) ? err.message : null;
}

export const REFUSAL_FALLBACK_MODEL_IDS = ["claude-opus-5", "claude-sonnet-5"] as const;

export function refusalFallbackModelId(
  fromId: string,
  configuredId?: string,
  usable: (id: string) => boolean = () => true,
): string | undefined {
  if (configuredId && configuredId !== fromId && usable(configuredId)) return configuredId;
  return REFUSAL_FALLBACK_MODEL_IDS.find((id) => id !== fromId);
}

export function refusalFallbackNote(fromModel: string, toModel: string, refusal: string): string {
  return (
    `[system] Your previous response was blocked or failed at the model provider before it reached the user ` +
    `— these failures can fire spuriously; the user did nothing wrong. ` +
    `The provider's stated reason was: "${refusal}". ` +
    `The turn has been switched from ${fromModel} to ${toModel}. Start your reply by briefly ` +
    `telling the user that ${fromModel} could not answer this request and why (paraphrase the provider's ` +
    `stated reason in plain words), and that you are answering as ${toModel} instead — then answer ` +
    `their message.`
  );
}

export function createTurnRecovery(o: {
  turn: HarnessTurnInput;
  session: AgentSession;
  request: Omit<TurnRequestSettings, "fast" | "addDocuments">;
  halt: Pick<TurnHalt, "handoff">;
  messagesBefore: number;
  turnWallClockMs: number;
  raceCapMs: () => number;
  race: (prompting: Promise<void>, capMs?: number) => Promise<TurnWallClockOutcome>;
  stopped: () => boolean;
  directModel: (id: string) => boolean;
  servedModelId: (id: string) => string;
  resolveFallbackRuntime: () => { modelId: string; effortLevel?: string; fastMode?: boolean } | undefined;
}) {
  const {
    turn,
    session,
    request,
    halt,
    messagesBefore,
    turnWallClockMs,
    raceCapMs,
    race,
    stopped,
    directModel,
    servedModelId,
    resolveFallbackRuntime,
  } = o;
  const refusedModelIds = new Set<string>();
  const attemptRefusalFallback = async (refusal: string): Promise<boolean> => {
    if (stopped() || turn.cancel?.aborted) return false;
    const fromId = (session.model as { id?: string } | undefined)?.id;
    if (fromId) refusedModelIds.add(fromId);
    const configured = resolveFallbackRuntime();
    const fallbackId = fromId
      ? refusalFallbackModelId(fromId, configured?.modelId, (id) => !!resolveModel(servedModelId(id)))
      : undefined;
    const fallback = fallbackId ? resolveModel(servedModelId(fallbackId)) : undefined;
    if (!fallbackId || !fallback || refusedModelIds.has(fallbackId) || refusedModelIds.has(servedModelId(fallbackId)))
      return false;
    const capMs = raceCapMs();
    if (turnWallClockMs > 0 && capMs < EMPTY_ENDING_MIN_BUDGET_MS) return false;
    console.error(
      `[pi] provider refusal — retrying on fallback model ${fromId} -> ${fallbackId} session=${turn.session.id}: ${refusal}`,
    );
    const custom = configured?.modelId === fallbackId ? configured : undefined;
    const wantFast = wantsFastMode(custom?.fastMode ?? turn.runtime?.fastMode, fallbackId);
    await session.setModel(withRequestHeaders(fallback, directModel(fallbackId), wantFast));
    request.setFast(wantFast);
    request.setEffortLevel(
      custom?.effortLevel ?? turn.runtime?.effortLevel ?? defaultInteractiveThinkingLevel(fallback),
    );
    applyTurnEffort(session, request.effortLevel());
    dropFailedAssistant(session, messagesBefore);
    const outcome = await race(
      session.prompt(refusalFallbackNote(modelDisplayName(fromId!), modelDisplayName(fallbackId), refusal)),
      capMs,
    );
    if (stopped()) return false;
    if (outcome !== "ok") throw new NonRetryableTurnError(refusal);
    return true;
  };
  let documentRejection: ProviderTurnError | undefined;
  let documentRetried = false;
  const noteDocumentRejection = (message: unknown): void => {
    if (documentRejection || !request.documents()?.length) return;
    const failed = message as AssistantMessage | undefined;
    if (failed?.role !== "assistant" || failed.stopReason !== "error") return;
    const failure = piAssistantFailure({ messages: [failed] } as unknown as AssistantTextSession);
    if (!failure || !DOCUMENT_REJECTION_CODES.has(failure.code)) return;
    documentRejection = failure;
    request.stubDocuments();
    console.error(
      `[pi] request with ${request.documents()!.length} inline document(s) rejected (${failure.code}: ${failure.raw || failure.message}) — replacing them with stubs session=${turn.session.id}`,
    );
  };
  const retryWithoutDocuments = async (): Promise<boolean> => {
    if (!documentRejection || documentRetried || stopped() || turn.cancel?.aborted) return false;
    const lastAssistant = session.messages
      .slice(messagesBefore)
      .findLast((m) => (m as { role?: string }).role === "assistant") as AssistantMessage | undefined;
    if (lastAssistant && lastAssistant.stopReason !== "error") return false;
    const capMs = raceCapMs();
    if (turnWallClockMs > 0 && capMs < EMPTY_ENDING_MIN_BUDGET_MS) return false;
    documentRetried = true;
    dropFailedAssistant(session, messagesBefore);
    const outcome = await race(session.prompt(DOCUMENTS_DROPPED_RETRY_NOTE), capMs);
    if (stopped()) return false;
    if (outcome !== "ok")
      throw new NonRetryableTurnError(`${documentRejection.message} (retry without inline documents was ${outcome})`);
    return true;
  };
  const recoverFailedRound = async (): Promise<void> => {
    if (halt.handoff() || stopped() || turn.cancel?.aborted) return;
    await retryWithoutDocuments();
    const refusal = providerRefusalError(session, messagesBefore);
    if (!refusal) return;
    try {
      await attemptRefusalFallback(refusal);
    } catch (e) {
      swallow("pi: refusal fallback", e);
      throw new NonRetryableTurnError(refusal);
    }
  };
  return { noteDocumentRejection, retryWithoutDocuments, attemptRefusalFallback, recoverFailedRound };
}
