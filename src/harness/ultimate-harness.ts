import { sleep, withAbort } from "../util/async.ts";
import { defineHarness, type Harness, type HarnessTurnInput } from "./harness.ts";
import { replayPreamble } from "./replay.ts";

interface UltimateModel {
  provider: string;
  modelId: string;
}

interface UltimateHarnessOptions {
  baseUrl: string;
  projectRoot?: string;
  model?: UltimateModel | ((modelId: string) => UltimateModel | undefined);
  modelBroker?: (input: HarnessTurnInput) => Promise<{ baseUrl: string; token: string; modelId: string }>;
  toolBroker?: (input: HarnessTurnInput) => Promise<{ baseUrl: string; token: string }>;
  pollIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface UltimateHistoryEntry {
  kind?: string;
  model?: unknown;
}

interface UltimateAssistantMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

function assistantMessages(entry: UltimateHistoryEntry): UltimateAssistantMessage[] {
  if (entry.kind !== "pi.assistant" || !Array.isArray(entry.model)) return [];
  return entry.model.filter(
    (candidate): candidate is UltimateAssistantMessage =>
      !!candidate && typeof candidate === "object" && "role" in candidate && candidate.role === "assistant",
  );
}

function assistantText(entry: UltimateHistoryEntry): string | undefined {
  const message = assistantMessages(entry).find((candidate) => candidate.stopReason === "stop");
  if (!message || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part,
    )
    .map((part) => part.text)
    .join("");
  return text || undefined;
}

export function createUltimateHarness(options: UltimateHarnessOptions): Harness {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const pollIntervalMs = options.pollIntervalMs ?? 250;

  async function call(path: string, init?: RequestInit): Promise<unknown> {
    const response = await request(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok)
      throw new Error(`Ultimate ${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
    return body;
  }

  async function runTurn(input: HarnessTurnInput) {
    const continueTurn = !!input.continueTurn && input.history.some((entry) => entry.seq === input.resumeUserSeq);
    if (!continueTurn)
      await input.emit({
        type: "user",
        payload: {
          text: input.input,
          ...(input.environment ? { environment: input.environment } : {}),
          ...((input.triggerTs ?? input.entryTs) ? { ts: input.triggerTs ?? input.entryTs } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        },
        scopeLabel: input.scopeLabel,
        ...(input.runtimeActorId ? { author: input.runtimeActorId } : {}),
      });
    const model = typeof options.model === "function" ? options.model(input.runtime?.modelId ?? "") : options.model;
    const modelBroker = await options.modelBroker?.(input);
    const toolBroker = await options.toolBroker?.(input);
    const created = (await call("/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        cwd: options.projectRoot ?? process.cwd(),
        title: `QM ${input.session.id}`,
        instructions: input.systemPrompt,
        ...(modelBroker ? { modelBroker } : {}),
        ...(toolBroker ? { toolBroker } : {}),
      }),
      signal: input.cancel,
    })) as { id?: unknown };
    if (!Number.isSafeInteger(created.id)) throw new Error("Ultimate did not return a conversation id");
    const id = created.id as number;
    let aborting: Promise<unknown> | undefined;
    const abort = () => {
      aborting = call(`/api/conversations/${id}/abort`, { method: "POST", body: "{}" }).catch(() => {});
    };
    input.cancel?.addEventListener("abort", abort, { once: true });
    try {
      if (model && !modelBroker)
        await call(`/api/conversations/${id}/configure`, {
          method: "POST",
          body: JSON.stringify({ model }),
          signal: input.cancel,
        });
      await call(`/api/conversations/${id}/submit`, {
        method: "POST",
        body: JSON.stringify({
          text: continueTurn
            ? replayPreamble(input.history).trim()
            : `${replayPreamble(input.history)}\n\n${input.input}`.trim(),
        }),
        signal: input.cancel,
      });
      for (;;) {
        if (input.cancel?.aborted) return { reply: "", stopped: true as const };
        const page = (await call(`/api/conversations/${id}/history?before=${Number.MAX_SAFE_INTEGER}`, {
          signal: input.cancel,
        })) as { entries?: unknown };
        const entries = Array.isArray(page.entries) ? (page.entries as UltimateHistoryEntry[]) : [];
        const failure = entries.flatMap(assistantMessages).find((message) => message.stopReason === "error");
        if (failure)
          throw new Error(
            typeof failure.errorMessage === "string" ? failure.errorMessage : "Ultimate model request failed",
          );
        const reply = entries.map(assistantText).find((text) => text !== undefined);
        if (reply !== undefined) {
          input.recordModelCall({ model: model?.modelId ?? "ultimate", inputTokens: 0, entryCount: 1 });
          input.onDelta?.(reply);
          await input.emit({ type: "assistant", payload: { text: reply }, scopeLabel: input.scopeLabel });
          return { reply, modelCalls: 1 };
        }
        await withAbort(() => sleep(pollIntervalMs), input.cancel);
      }
    } catch (error) {
      if (input.cancel?.aborted) return { reply: "", stopped: true as const };
      throw error;
    } finally {
      input.cancel?.removeEventListener("abort", abort);
      await aborting;
    }
  }

  return defineHarness(
    {
      id: "ultimate",
      controlTransport: "http",
      toolTransport: "mcp",
      transcriptFormat: "pi-durable",
      capabilities: new Set(["abort", "thinking-level"]),
    },
    { runTurn, resetSession: () => {} },
  );
}
