import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { legacyAssistant, type PiReplayMessage, type SeededMessage } from "./replay.ts";
import { swallow } from "../util/errors.ts";

export function continuableContext<M extends { role?: unknown }>(messages: readonly M[]): M[] | null {
  let end = messages.length;
  while (messages[end - 1]?.role === "assistant") end--;
  const role = messages[end - 1]?.role;
  return role === "user" || role === "toolResult" ? messages.slice(0, end) : null;
}

interface PiSeedTarget {
  agent?: { state?: { messages?: unknown[] } };
  sessionManager?: { appendMessage?: (message: unknown) => unknown };
  getActiveToolNames?: () => string[];
  _baseSystemPromptOptions?: object;
  _preparePromptAndToolLoadout?: (options: object) => unknown;
}

export function toPiMessage(m: SeededMessage): PiReplayMessage {
  return m.role === "assistant"
    ? legacyAssistant([{ type: "text", text: m.text }], Date.now())
    : { role: "user", content: [{ type: "text", text: m.text }], timestamp: Date.now() };
}

export function seedRawMessagesIntoSession(session: unknown, messages: readonly PiReplayMessage[]): void {
  if (!messages.length) return;
  const target = session as PiSeedTarget;
  const liveMessages = target.agent?.state?.messages;
  const appendMessage = target.sessionManager?.appendMessage?.bind(target.sessionManager);
  const system = target._preparePromptAndToolLoadout?.({
    ...target._baseSystemPromptOptions,
    selectedTools: target.getActiveToolNames?.() ?? [],
  });
  for (const message of system ? [system, ...messages] : messages) {
    if (Array.isArray(liveMessages)) liveMessages.push(message);
    if (appendMessage) {
      try {
        appendMessage(message);
      } catch (e) {
        swallow("pi: replay message append", e);
      }
    }
  }
}

export function omitFromModelContext(session: AgentSession, omitted: ReadonlySet<unknown>): void {
  if (!omitted.size) return;
  const manager = session.sessionManager;
  for (const entry of manager.getBranch())
    if (entry.type === "message" && entry.message.role !== "system" && omitted.has(entry.message))
      manager.appendContextEdit(entry.id, null);
  session.refreshContext();
}

export function dropFailedAssistant(session: AgentSession, messagesBefore: number): void {
  const failed = session.agent.state.messages
    .slice(messagesBefore)
    .findLast((m) => m.role === "assistant" && m.stopReason === "error");
  if (failed) omitFromModelContext(session, new Set([failed]));
}
