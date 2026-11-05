import type { LlmTransportMeta } from "../sessions/session-store.ts";
import { MAX_LLM_REQUEST_BYTES } from "../core/attachments.ts";
import { countTokens } from "../util/tokens.ts";
import { ELIDED_IMAGE_TEXT } from "./replay-images.ts";

const MAX_CAPTURED_PAYLOAD_CHARS = 2_000_000;
const LLM_REQUEST_TRIM_SLACK_BYTES = 3_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const BINARY_HOLDERS = ["source", "file", "inlineData", "image_url"];

function binaryLeaf(container: Record<string, unknown>, key: string): string | undefined {
  const value = container[key];
  if (typeof value !== "string") return undefined;
  if (key === "data")
    return (container.type === "base64" && typeof container.media_type === "string") ||
      typeof container.mimeType === "string"
      ? value
      : undefined;
  if (!["image_url", "url", "file_data"].includes(key) || !value.startsWith("data:")) return undefined;
  return value.slice(0, value.indexOf(",")).endsWith(";base64") ? value : undefined;
}

function blockBinary(block: unknown): string | undefined {
  if (!isRecord(block)) return undefined;
  const own = binaryLeaf(block, "image_url") ?? binaryLeaf(block, "file_data");
  if (own !== undefined) return own;
  for (const holder of BINARY_HOLDERS) {
    const inner = block[holder];
    if (!isRecord(inner)) continue;
    for (const key of Object.keys(inner)) {
      const nested = binaryLeaf(inner, key);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function jsonBytesUpperBound(value: unknown, binary?: string): number {
  if (typeof value === "string") {
    if (value !== binary) return value.length * 6 + 2;
    const header = value.startsWith("data:") ? value.indexOf(",") + 1 : 0;
    return header * 6 + value.length - header + 2;
  }
  if (!value || typeof value !== "object") return 24;
  let sum = 2;
  if (Array.isArray(value)) {
    for (const item of value) sum += jsonBytesUpperBound(item, binary) + 1;
    return sum;
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return Number.POSITIVE_INFINITY;
  const data = blockBinary(value) ?? binary;
  for (const key of Object.keys(value))
    sum += key.length * 6 + 4 + jsonBytesUpperBound((value as Record<string, unknown>)[key], data);
  return sum;
}

export function trimPayloadToByteBudget(payload: unknown, maxBytes: number = MAX_LLM_REQUEST_BYTES): unknown {
  const p = payload as Record<string, unknown> | null;
  let listKey: "messages" | "input" | "contents" | undefined;
  if (Array.isArray(p?.messages)) listKey = "messages";
  else if (Array.isArray(p?.input)) listKey = "input";
  else if (Array.isArray(p?.contents)) listKey = "contents";
  if (!p || !listKey) return payload;
  if (jsonBytesUpperBound(payload) <= maxBytes) return payload;
  const totalBytes = Buffer.byteLength(JSON.stringify(payload));
  if (totalBytes <= maxBytes) return payload;

  const inlineImageChars = (b: unknown): number => blockBinary(b)?.length ?? 0;
  const placeholder = (b: unknown) => {
    const block = b as { type?: string; cache_control?: unknown };
    const cache = block.cache_control !== undefined ? { cache_control: block.cache_control } : undefined;
    const text =
      ["document", "input_file", "file"].includes(block.type ?? "") || (b as { inlineData?: unknown })?.inlineData
        ? "[Document omitted because the model request exceeds its byte budget. Do not claim to have read it.]"
        : ELIDED_IMAGE_TEXT;
    if (listKey === "contents") return { text };
    return block.type === "input_image" || block.type === "input_file"
      ? { type: "input_text", text }
      : { type: "text", text, ...cache };
  };
  let toShed = totalBytes - (maxBytes - LLM_REQUEST_TRIM_SLACK_BYTES);
  const trimContent = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content;
    let changed = false;
    const out = content.map((block) => {
      const imageChars = inlineImageChars(block);
      if (imageChars > 0 && toShed > 0) {
        toShed -= imageChars - ELIDED_IMAGE_TEXT.length;
        changed = true;
        return placeholder(block);
      }
      const nested = block as { content?: unknown };
      if (Array.isArray(nested?.content)) {
        const inner = trimContent(nested.content);
        if (inner !== nested.content) {
          changed = true;
          return { ...(block as Record<string, unknown>), content: inner };
        }
      }
      return block;
    });
    return changed ? out : content;
  };

  const items = (p[listKey] as unknown[]).map((m) => {
    if (toShed <= 0) return m;
    const msg = m as { content?: unknown; parts?: unknown };
    const key = listKey === "contents" ? "parts" : "content";
    if (!Array.isArray(msg?.[key])) return m;
    const content = trimContent(msg[key]);
    return content === msg[key] ? m : { ...(m as Record<string, unknown>), [key]: content };
  });
  return { ...p, [listKey]: items };
}

function redactBinary(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactBinary);
  if (!isRecord(v)) return v;
  if (v.type === "thinking" && typeof v.signature === "string")
    return { ...v, signature: `<signature ${v.signature.length} chars omitted>` };
  if (v.type === "redacted_thinking" && typeof v.data === "string")
    return { ...v, data: `<redacted_thinking ${v.data.length} chars omitted>` };
  return Object.fromEntries(
    Object.entries(v).map(([key, value]) => {
      const bytes = binaryLeaf(v, key);
      if (bytes === undefined) return [key, redactBinary(value)];
      return [
        key,
        v.type === "base64"
          ? `<base64 ${String(v.media_type ?? "image")} omitted: ${bytes.length} chars>`
          : `<file bytes omitted: ${bytes.length} chars>`,
      ];
    }),
  );
}

export function promptEnvelopeWithoutHistory(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const envelope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "contents") continue;
    if (key === "messages" || key === "input") {
      if (Array.isArray(value)) {
        const instructions = value.filter(
          (item: unknown) =>
            item !== null &&
            typeof item === "object" &&
            "role" in item &&
            (item.role === "system" || item.role === "developer"),
        );
        if (instructions.length) envelope[key] = instructions;
      }
    } else {
      envelope[key] = key === "context" ? promptEnvelopeWithoutHistory(value) : value;
    }
  }
  return envelope;
}

export function transportFromModel(model: unknown): LlmTransportMeta | undefined {
  if (!model || typeof model !== "object") return undefined;
  const m = model as { id?: unknown; headers?: unknown };
  const out: LlmTransportMeta = {};
  if (typeof m.id === "string") out.modelId = m.id;
  if (m.headers && typeof m.headers === "object") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
    if (Object.keys(headers).length) out.headers = headers;
  }
  return out.modelId || out.headers ? out : undefined;
}

export function sanitizeLlmPayload(
  payload: unknown,
  model?: unknown,
): { envelope: unknown; truncated: boolean; transport?: LlmTransportMeta } {
  const transport = transportFromModel(model);
  const withTransport = (r: { envelope: unknown; truncated: boolean }) => (transport ? { ...r, transport } : r);
  let redacted: unknown;
  try {
    redacted = redactBinary(promptEnvelopeWithoutHistory(payload));
  } catch {
    return withTransport({ envelope: { note: "payload not capturable" }, truncated: true });
  }
  let json: string;
  try {
    json = JSON.stringify(redacted);
  } catch {
    return withTransport({ envelope: { note: "payload not serializable" }, truncated: true });
  }
  if (json.length > MAX_CAPTURED_PAYLOAD_CHARS) {
    return withTransport({
      envelope: { truncated: true, bytes: json.length, preview: json.slice(0, MAX_CAPTURED_PAYLOAD_CHARS) },
      truncated: true,
    });
  }
  return withTransport({ envelope: redacted, truncated: false });
}

export const OUTPUT_BUDGET_FLOOR_TOKENS = 1_024;
export const OUTPUT_GUARD_SAFETY_TOKENS = 4_096;
const OUTPUT_GUARD_CHARS_PER_TOKEN = 4;
const IMAGE_STAND_IN = "i".repeat(4_800);

export type OutputBudgetGuardResult =
  { kind: "ok" } | { kind: "raised"; from: number; to: number; estimatedPromptTokens: number };

function estimatePayloadTokens(payload: Record<string, unknown>): number | undefined {
  try {
    const json = JSON.stringify(payload, function (this: unknown, key, value) {
      if (typeof value !== "string" || value.length <= IMAGE_STAND_IN.length) return value;
      return isRecord(this) && binaryLeaf(this, key) !== undefined ? IMAGE_STAND_IN : value;
    });
    if (typeof json !== "string") return undefined;
    return Math.ceil(json.length / OUTPUT_GUARD_CHARS_PER_TOKEN);
  } catch {
    return undefined;
  }
}

export function payloadTokensWithoutBinary(payload: unknown): number {
  return countTokens(
    JSON.stringify(payload, function (this: unknown, key, value) {
      return isRecord(this) && binaryLeaf(this, key) !== undefined ? "" : value;
    }),
  );
}

export function guardOutputBudget(payload: unknown, model: unknown): OutputBudgetGuardResult {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return { kind: "ok" };
  let capKey: "max_tokens" | "max_output_tokens" | "max_completion_tokens" | undefined;
  if (typeof p.max_tokens === "number") capKey = "max_tokens";
  else if (typeof p.max_output_tokens === "number") capKey = "max_output_tokens";
  else if (typeof p.max_completion_tokens === "number") capKey = "max_completion_tokens";
  if (capKey === undefined) return { kind: "ok" };
  const cap = p[capKey] as number;
  if (cap >= OUTPUT_BUDGET_FLOOR_TOKENS) return { kind: "ok" };
  const m = model as { contextWindow?: number; maxTokens?: number } | null;
  const contextWindow = m?.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return { kind: "ok" };
  const estimatedPromptTokens = estimatePayloadTokens(p);
  if (estimatedPromptTokens === undefined) return { kind: "ok" };
  const available = contextWindow - estimatedPromptTokens - OUTPUT_GUARD_SAFETY_TOKENS;
  if (available < OUTPUT_BUDGET_FLOOR_TOKENS) {
    throw new Error(
      `prompt is too long: estimated ${estimatedPromptTokens} tokens leave no output room in a ${contextWindow}-token window (output-budget guard)`,
    );
  }
  const modelMax = typeof m?.maxTokens === "number" && m.maxTokens > 0 ? m.maxTokens : available;
  const to = Math.min(modelMax, available);
  if (to <= cap) return { kind: "ok" };
  p[capKey] = to;
  return { kind: "raised", from: cap, to, estimatedPromptTokens };
}
