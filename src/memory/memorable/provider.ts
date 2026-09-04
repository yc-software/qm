import type { ScopeId, SessionEntry } from "../../types.ts";
import type { MemoryService } from "../memory-service.ts";
import { captureSession, type MemorableCapture, type MemorableToolCall } from "./capture.ts";
import { memorableInject } from "./inject.ts";
import { relayRecord } from "./relay.ts";

export interface MemorableProviderDeps {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Loads the session entries a capture should be derived from. */
  loadEntries: (sessionId: string) => Promise<SessionEntry[]>;
  /** Redacts secret values before anything leaves the process. */
  mask?: (text: string) => string;
  injectTimeoutMs?: number;
  recordTimeoutMs?: number;
  inject?: typeof memorableInject;
  relay?: typeof relayRecord;
}

function maskInput(input: Record<string, unknown>, mask: (text: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") out[key] = mask(value);
    else if (value && typeof value === "object") out[key] = JSON.parse(mask(JSON.stringify(value)));
    else out[key] = value;
  }
  return out;
}

function redactCapture(capture: MemorableCapture, mask: (text: string) => string): MemorableCapture {
  return {
    ...capture,
    workflows: capture.workflows.map((workflow) => ({
      ...workflow,
      prompt: mask(workflow.prompt),
      tool_calls: workflow.tool_calls.map((call): MemorableToolCall => ({
        ...call,
        input: maskInput(call.input, mask),
      })),
    })),
  };
}

/**
 * Procedural memory backed by the Memorable CLI, exposed as an ordinary memory provider.
 *
 * Recall shells out to `memorable inject` with the turn's task; capture ignores the extracted
 * facts and instead derives a tool-call trace from the session that produced the turn, then
 * relays it through `memorable record`. Everything else (query, read, replace) is a no-op:
 * procedures are not a notebook and are never surfaced for direct editing.
 */
export function createMemorableMemoryProvider(deps: MemorableProviderDeps): MemoryService {
  const inject = deps.inject ?? memorableInject;
  const relay = deps.relay ?? relayRecord;
  const mask = deps.mask ?? ((text: string) => text);
  const spawnOpts = { env: deps.env };

  return {
    async recall(scopeId: ScopeId, context) {
      const task = context?.query?.trim();
      if (!task) return "";
      const block = await inject(deps.argv, scopeId, task, spawnOpts, deps.injectTimeoutMs);
      return block ?? "";
    },

    async capture(scopeId: ScopeId, _facts, _at, _author, context) {
      if (context?.mode !== "automatic" || !context.sessionId) return 0;
      const entries = await deps.loadEntries(context.sessionId);
      const raw = captureSession(context.sessionId, entries);
      const capture = redactCapture({ ...raw, scope_id: scopeId }, mask);
      if (!capture.workflows.length) return 0;
      const outcome = await relay(deps.argv, capture, deps.recordTimeoutMs, spawnOpts);
      if (!outcome.ok) throw new Error(`memorable record refused: ${outcome.reason}`);
      return capture.workflows.length;
    },

    async query() {
      return [];
    },

    async read() {
      return "";
    },

    async replace() {
      throw new Error("Memorable procedures are not an editable notebook");
    },

    async purge() {
      throw new Error("Memorable procedures cannot be erased through QM; erase them in Memorable");
    },
  };
}
