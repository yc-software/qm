import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LlmCallUsage } from "../sessions/session-store.ts";
import type { ProviderTurnError } from "../core/turn-error.ts";
import { providerTurnError } from "../model/provider-error.ts";
import { resolveModel } from "../model/pi-models.ts";
import { goalWorkDigest } from "./goal.ts";

export function sumCacheUsage(
  usages: ReadonlyArray<LlmCallUsage | null>,
): { cacheRead: number; cacheWrite: number; uncachedInput: number } | null {
  let saw = false;
  let cacheRead = 0;
  let cacheWrite = 0;
  let uncachedInput = 0;
  for (const usage of usages) {
    if (!usage) continue;
    saw = true;
    cacheRead += usage.cacheRead;
    cacheWrite += usage.cacheWrite;
    uncachedInput += usage.input;
  }
  return saw ? { cacheRead, cacheWrite, uncachedInput } : null;
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && (c as { type?: unknown }).type === "text")
    .map((c) => (typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .join("");
}

export function piGoalWork(messages: ReadonlyArray<unknown>): string {
  const lines: string[] = [];
  for (const m of messages as ReadonlyArray<{ role?: string; content?: unknown; toolName?: string }>) {
    if (m.role === "toolResult") lines.push(`tool_result ${m.toolName ?? ""}: ${textFromContent(m.content)}`);
    else if (m.role === "user" || m.role === "assistant") {
      const said = textFromContent(m.content);
      if (said) lines.push(`${m.role}: ${said}`);
      for (const c of Array.isArray(m.content) ? m.content : [])
        if ((c as { type?: string }).type === "toolCall")
          lines.push(
            `tool_call ${(c as { name?: string }).name ?? ""}: ${JSON.stringify((c as { arguments?: unknown }).arguments ?? {})}`,
          );
    }
  }
  return goalWorkDigest(lines);
}

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

export function piAssistantFailure(session: AssistantTextSession): ProviderTurnError | null {
  const failed = piFailedAssistant(session);
  if (!failed) return null;
  const contextWindow = (
    failed.model ? (resolveModel(failed.model) as { contextWindow?: number } | undefined) : undefined
  )?.contextWindow;
  return providerTurnError(failed, { contextWindow, lastInputTokens: lastInputTokens(session, failed) });
}

export function piLastAssistantTextOrThrow(session: AssistantTextSession): string | undefined {
  const err = piAssistantFailure(session);
  if (err) throw err;
  return session.getLastAssistantText();
}

export function messagesSince(session: AssistantTextSession, messagesBefore?: number): AssistantTextSession {
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
