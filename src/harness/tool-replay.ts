import type { SessionEntry } from "../types.ts";
import type { TapeRecord } from "../sessions/session-store.ts";
import { isObj } from "../util/objects.ts";
import { INTERRUPTED_TOOL_RESULT } from "./context-compaction.ts";

export function toolReplayPolicy(call: Record<string, unknown>): "safe" | "unsafe" {
  if (call.client || call.mcpServer) return "unsafe";
  const tool = call.tool;
  const action = call.action;
  if (tool === "history") return "safe";
  if (tool === "files" && action === "read") return "safe";
  if (tool === "runtime" && action === "get") return "safe";
  if (tool === "goal" && action === "get") return "safe";
  if (tool === "memory" && (action === "read" || action === "search")) return "safe";
  if (tool === "guidance" && action === "read") return "safe";
  if (tool === "sandbox" && (action === "list" || action === "status")) return "safe";
  return "unsafe";
}

export function uncertainToolCalls(entries: readonly SessionEntry[], rows: readonly TapeRecord[]): string[] {
  const pending = new Map<string, Record<string, unknown>>();
  const startedCount = new Map<string, number>();
  const completed = new Set<string>();
  const unknown = new Set<string>();
  for (const entry of entries) {
    const p = entry.payload;
    if (!isObj(p) || typeof p.callId !== "string") continue;
    if (entry.type === "tool_call") {
      pending.set(p.callId, p);
      startedCount.set(p.callId, (startedCount.get(p.callId) ?? 0) + 1);
      completed.delete(p.callId);
      unknown.delete(p.callId);
    }
    if (entry.type === "tool_result") {
      if (p.outcomeUnknown === true) unknown.add(p.callId);
      else completed.add(p.callId);
    }
  }
  const nativeCalls = new Map<string, string>();
  const nativeResults = new Set<string>();
  const nativeCount = new Map<string, number>();
  const addCall = (id: unknown, name: unknown) => {
    if (typeof id === "string") {
      nativeCalls.set(id, typeof name === "string" ? name : "unknown");
      nativeCount.set(id, (nativeCount.get(id) ?? 0) + 1);
      nativeResults.delete(id);
    }
  };
  const addResult = (id: unknown) => {
    if (typeof id === "string") nativeResults.add(id);
  };
  for (const row of rows) {
    if (row.kind !== "message" || !isObj(row.payload)) continue;
    const p = row.payload;
    if (p.type === "function_call") addCall(p.call_id, p.name);
    if (p.type === "function_call_output") addResult(p.call_id);
    if (p.role === "toolResult") {
      if (
        !Array.isArray(p.content) ||
        !p.content.some((b) => isObj(b) && b.type === "text" && b.text === INTERRUPTED_TOOL_RESULT)
      )
        addResult(p.toolCallId);
    }
    const message = isObj(p.message) ? p.message : p;
    if (message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) continue;
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isObj(block)) continue;
        if (block.type === "toolCall" || block.type === "tool_use") addCall(block.id, block.name);
        if (block.type === "tool_result") addResult(block.tool_use_id);
      }
    }
    if (Array.isArray(p.parts)) {
      for (const part of p.parts) {
        if (!isObj(part) || part.type !== "tool") continue;
        addCall(part.callID, part.tool);
        if (isObj(part.state) && (part.state.status === "completed" || part.state.status === "error"))
          addResult(part.callID);
      }
    }
  }
  const unsafe = new Set<string>();
  for (const [id, call] of pending) {
    if (completed.has(id) && !unknown.has(id)) continue;
    if (call.replay === "safe" && toolReplayPolicy(call) === "safe") continue;
    unsafe.add(typeof call.tool === "string" ? call.tool : "unknown");
  }
  for (const [id, tool] of nativeCalls) {
    if (nativeResults.has(id)) continue;
    if ((startedCount.get(id) ?? 0) >= (nativeCount.get(id) ?? 0) && pending.has(id)) continue;
    unsafe.add(tool);
  }
  return [...unsafe];
}
