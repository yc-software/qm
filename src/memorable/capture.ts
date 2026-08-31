import { createHash } from "node:crypto";
import type { SessionEntry } from "../types.ts";
import { clampChars, stripTerminalControl } from "./inject.ts";

export interface MemorableToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: { ok: boolean; exit_code?: number };
}

export interface MemorableWorkflow {
  workflow_id: string;
  prompt: string;
  tool_calls: MemorableToolCall[];
}

export interface MemorableCapture {
  session_id: string;
  scope_id: string;
  workflows: MemorableWorkflow[];
}

const MAX_WORKFLOW_ID_CHARS = 200;
const WORKFLOW_ID_DIGEST_CHARS = 16;
const MAX_PROMPT_CHARS = 16_000;
const MAX_TOOL_INPUT_CHARS = 32_000;

function workflowId(sessionId: string, seq: number): string {
  const raw = `${sessionId}-${seq}`;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "-");
  if (safe === raw && safe.length <= MAX_WORKFLOW_ID_CHARS) return safe;
  const digest = createHash("sha256")
    .update(`${sessionId}\u0000${seq}`)
    .digest("hex")
    .slice(0, WORKFLOW_ID_DIGEST_CHARS);
  return `${safe.slice(0, MAX_WORKFLOW_ID_CHARS - WORKFLOW_ID_DIGEST_CHARS - 1)}-${digest}`;
}

function cleanPrompt(text: string): string {
  const clean = stripTerminalControl(text).trim();
  return clean.length > MAX_PROMPT_CHARS ? clampChars(clean, MAX_PROMPT_CHARS).trimEnd() : clean;
}

function capInput(input: Record<string, unknown>): Record<string, unknown> {
  let capped: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > MAX_TOOL_INPUT_CHARS) {
      capped ??= { ...input };
      capped[key] = clampChars(value, MAX_TOOL_INPUT_CHARS);
    }
  }
  return capped ?? input;
}

function callKey(call: MemorableToolCall): string {
  return `${call.name}\u0000${JSON.stringify(call.input)}`;
}

export function worthOffering(workflow: MemorableWorkflow): boolean {
  const calls = workflow.tool_calls;
  if (calls.length < 2) return false;
  const first = callKey(calls[0]!);
  return calls.some((call) => callKey(call) !== first);
}

export function captureSession(sessionId: string, entries: SessionEntry[]): MemorableCapture {
  let scopeId = "";
  const outcomes = new Map<string, Array<{ ok: boolean; exit_code?: number }>>();
  for (const entry of entries) {
    if (entry.type !== "tool_result") continue;
    const payload = entry.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.callId !== "string") continue;
    const ok = payload.isError !== true;
    const code = payload.tool === "execute" && typeof payload.code === "number" ? payload.code : undefined;
    const outcome = { ok, ...(code !== undefined ? { exit_code: code } : {}) };
    const queue = outcomes.get(payload.callId);
    if (queue) queue.push(outcome);
    else outcomes.set(payload.callId, [outcome]);
  }
  const workflows: MemorableWorkflow[] = [];
  let current: MemorableWorkflow = { workflow_id: workflowId(sessionId, 0), prompt: "", tool_calls: [] };
  const close = () => {
    if (current.tool_calls.length) workflows.push(current);
  };
  for (const entry of entries) {
    if (!scopeId && entry.scopeLabel) scopeId = entry.scopeLabel;
    if (entry.type === "user") {
      const text = (entry.payload as { text?: unknown } | null)?.text;
      if (typeof text !== "string") continue;
      const prompt = cleanPrompt(text);
      if (!prompt) continue;
      close();
      current = { workflow_id: workflowId(sessionId, entry.seq), prompt, tool_calls: [] };
      continue;
    }
    if (entry.type !== "tool_call") continue;
    const payload = entry.payload as Record<string, unknown> | null;
    if (!payload || typeof payload.tool !== "string") continue;
    const { tool, callId, ...input } = payload;
    const outcome = typeof callId === "string" ? outcomes.get(callId)?.shift() : undefined;
    current.tool_calls.push({ name: tool, input: capInput(input), ...(outcome ? { result: outcome } : {}) });
  }
  close();
  return { session_id: sessionId, scope_id: scopeId, workflows };
}
