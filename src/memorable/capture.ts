import type { SessionEntry } from "../types.ts";

export interface MemorableToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: { ok: boolean; exit_code?: number };
}

export interface MemorableCapture {
  session_id: string;
  scope_id: string;
  task_description: string;
  tool_calls: MemorableToolCall[];
}

export function captureSession(sessionId: string, entries: SessionEntry[]): MemorableCapture {
  let taskDescription = "";
  let scopeId = "";
  const outcomes = new Map<string, { ok: boolean; exit_code?: number }>();
  for (const entry of entries) {
    if (entry.type !== "tool_result") continue;
    const payload = entry.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.callId !== "string") continue;
    const ok = payload.isError !== true;
    const code = payload.tool === "execute" && typeof payload.code === "number" ? payload.code : undefined;
    outcomes.set(payload.callId, { ok, ...(code !== undefined ? { exit_code: code } : {}) });
  }
  const toolCalls: MemorableToolCall[] = [];
  for (const entry of entries) {
    if (!scopeId && entry.scopeLabel) scopeId = entry.scopeLabel;
    if (!taskDescription && entry.type === "user") {
      const text = (entry.payload as { text?: unknown } | null)?.text;
      if (typeof text === "string" && text.trim()) taskDescription = text.trim();
    }
    if (entry.type !== "tool_call") continue;
    const payload = entry.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.tool !== "string") continue;
    const { tool, callId, ...input } = payload;
    const outcome = typeof callId === "string" ? outcomes.get(callId) : undefined;
    toolCalls.push({ name: tool, input, ...(outcome ? { result: outcome } : {}) });
  }
  return { session_id: sessionId, scope_id: scopeId, task_description: taskDescription, tool_calls: toolCalls };
}
