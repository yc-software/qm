export type SeatBlock = { type: string; [key: string]: unknown };

export interface SeatTool {
  name: string;
  description?: string;
  input_schema?: unknown;
  [key: string]: unknown;
}

interface SeatMessage {
  role: string;
  content: string | SeatBlock[];
}

export interface SeatRequest {
  model?: string;
  system?: string | Array<{ type: string; text?: string }>;
  messages?: SeatMessage[];
  tools?: SeatTool[];
  [key: string]: unknown;
}

export interface SeatStepSummary {
  id: string;
  sessionId: string;
  sessionTitle?: string;
  createdAt: number;
}

export interface SeatStep extends SeatStepSummary {
  request: SeatRequest;
}

export type MoveBlock =
  { type: "text"; text: string } | { type: "tool_use"; name: string; input: Record<string, unknown> };

interface ToolCallDraft {
  name: string;
  args: string;
}

export interface MoveDraft {
  text: string;
  calls: ToolCallDraft[];
}

export interface RenderedBlock {
  label: string;
  body: string;
  code: boolean;
}

export interface MessageView {
  role: string;
  preview: string;
  open: boolean;
  blocks: RenderedBlock[];
}

const OPEN_TAIL_MESSAGES = 4;
const PREVIEW_CHARS = 160;

export function preview(text: string, max = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function systemTexts(request: SeatRequest): string[] {
  const system = request.system;
  if (typeof system === "string") return system ? [system] : [];
  return (system ?? []).map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b, null, 2)));
}

function byteSize(base64: string): string {
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.match(/=*$/)?.[0].length ?? 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function imagePlaceholder(block: SeatBlock): string {
  const source = (block.source ?? {}) as { type?: string; media_type?: string; data?: unknown; url?: string };
  if (typeof source.data === "string")
    return `[image ${source.media_type ?? "unknown type"}, ${byteSize(source.data)}]`;
  if (source.url) return `[image ${source.url}]`;
  return "[image]";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return (content as SeatBlock[])
    .map((b) => {
      const r = renderBlock(b);
      return r.label === "text" ? r.body : `${r.label}\n${r.body}`.trimEnd();
    })
    .join("\n\n");
}

export function renderBlock(block: SeatBlock): RenderedBlock {
  switch (block.type) {
    case "text":
      return { label: "text", body: String(block.text ?? ""), code: false };
    case "image":
      return { label: "image", body: imagePlaceholder(block), code: false };
    case "tool_use":
      return {
        label: `tool_use ${String(block.name)} · ${String(block.id ?? "")}`,
        body: JSON.stringify(block.input ?? {}, null, 2),
        code: true,
      };
    case "tool_result":
      return {
        label: `tool_result ${String(block.tool_use_id ?? "")}${block.is_error ? " · error" : ""}`,
        body: contentText(block.content ?? ""),
        code: false,
      };
    case "thinking":
      return { label: "thinking", body: String(block.thinking ?? ""), code: false };
    case "redacted_thinking":
      return { label: "redacted_thinking", body: "[redacted]", code: false };
    default:
      return { label: block.type, body: JSON.stringify(withoutImageData(block), null, 2), code: true };
  }
}

export function messageViews(request: SeatRequest): MessageView[] {
  const messages = request.messages ?? [];
  return messages.map((m, i) => {
    const blocks: RenderedBlock[] =
      typeof m.content === "string" ? [{ label: "text", body: m.content, code: false }] : m.content.map(renderBlock);
    const first = blocks.find((b) => b.body.trim());
    return {
      role: m.role,
      preview: first ? preview(first.label === "text" ? first.body : `${first.label} ${first.body}`) : "",
      open: i >= messages.length - OPEN_TAIL_MESSAGES,
      blocks,
    };
  });
}

export function withoutImageData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutImageData);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = withoutImageData(v);
  const source = out.source as { data?: unknown } | undefined;
  if (out.type === "image" && typeof source?.data === "string")
    out.source = { ...source, data: imagePlaceholder(value as SeatBlock) };
  return out;
}

function sample(schema: unknown): unknown {
  const s = (schema ?? {}) as { type?: unknown; enum?: unknown[]; default?: unknown };
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  if (type === "string") return "";
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") return argsSkeleton(schema);
  return null;
}

function argsSkeleton(schema: unknown): Record<string, unknown> {
  const s = (schema ?? {}) as { properties?: Record<string, unknown>; required?: unknown };
  const required = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string") : [];
  return Object.fromEntries(required.map((key) => [key, sample(s.properties?.[key])]));
}

export function argsTemplate(tools: SeatTool[], name: string): string {
  const tool = tools.find((t) => t.name === name);
  return JSON.stringify(tool ? argsSkeleton(tool.input_schema) : {}, null, 2);
}

export function buildMove(draft: MoveDraft, tools: SeatTool[]): { content: MoveBlock[] } | { error: string } {
  const content: MoveBlock[] = [];
  if (draft.text.trim()) content.push({ type: "text", text: draft.text });
  for (const call of draft.calls) {
    if (!call.name) return { error: "Pick a tool for each call." };
    if (tools.length && !tools.some((t) => t.name === call.name))
      return { error: `${call.name} is not one of this request's tools.` };
    let input: unknown;
    try {
      input = JSON.parse(call.args.trim() || "{}");
    } catch (error) {
      return { error: `${call.name} arguments are not valid JSON: ${(error as Error).message}` };
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      return { error: `${call.name} arguments must be a JSON object.` };
    content.push({ type: "tool_use", name: call.name, input: input as Record<string, unknown> });
  }
  if (!content.length) return { error: "Write a reply or add a tool call." };
  return { content };
}

export function draftFromBlocks(blocks: SeatBlock[]): MoveDraft {
  const text = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n");
  const calls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ name: String(b.name ?? ""), args: JSON.stringify(b.input ?? {}, null, 2) }));
  return { text, calls };
}

export function ageLabel(createdAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - createdAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}
