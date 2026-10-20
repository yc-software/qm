import type { LlmCallUsage, SessionStore } from "../../src/sessions/session-store.ts";
import type { SessionType } from "../../src/types.ts";

export const usage = (over: Partial<LlmCallUsage>): LlmCallUsage => ({
  input: 100,
  output: 20,
  cacheRead: 400,
  cacheWrite: 40,
  totalTokens: 560,
  costUsd: 0,
  ...over,
});

export async function bill(
  sessions: SessionStore,
  threadRef: string,
  type: SessionType,
  scope: string,
  over: Partial<LlmCallUsage>,
  model = "mock",
): Promise<void> {
  const session = await sessions.getOrCreateByThread(threadRef, type, scope);
  await sessions.recordLlmRequest(session.id, {
    turnSeq: null,
    step: 0,
    model,
    scopeLabel: scope,
    usage: usage(over),
  });
}
