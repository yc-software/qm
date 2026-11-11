import { swallow } from "../util/errors.ts";
import type { RunStop } from "../runs/run-store.ts";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ConversationTurn, OverheardMessage } from "../types.ts";
import {
  isOverheard,
  isAgentReply,
  isUserItem,
  messageTs,
  stepMessage,
  visibleBody,
  type Item,
  type NewItem,
} from "../sessions/items.ts";
import { deliveryNote } from "../core/attachments.ts";
import { goalCancelledNote } from "./goal.ts";
import { messageRevision, renderMessageRevision } from "../slack/message-revisions.ts";
import { contextSummaryHeader, INTERRUPTED_TOOL_RESULT, unrecordedToolResult } from "./context-compaction.ts";
import { contextSummary } from "../sessions/session-store.ts";
import { isoFromTs, messageTag } from "../util/message-tag.ts";
import { isObj } from "../util/objects.ts";
import { DEFAULT_CRON_TIMEZONE } from "../cron/schedule.ts";
import { zeroUsage } from "../model/model-runtime.ts";

function turnStoppedNote(reason: string): string {
  return `[system] Turn stopped ${reason}.`;
}

function stoppedToolResult(reason: string): string {
  return `[system] Turn stopped ${reason} while this call was running; its outcome wasn't recorded. Check what happened before retrying.`;
}

function cutOffByStop(result: Item | undefined): boolean {
  return !result || result.body.stopped === true;
}

function stoppedToolCalls(
  history: readonly Item[],
  resultByCallId: ReadonlyMap<string, Item>,
): { reasons: Map<string, string>; folded: Set<Item> } {
  const reasons = new Map<string, string>();
  const folded = new Set<Item>();
  let open: string[] = [];
  for (const e of history) {
    if (e.kind === "UserMessage" && !isOverheard(e)) open = [];
    else if (e.kind === "ToolCall" && e.callId && cutOffByStop(resultByCallId.get(e.callId))) open.push(e.callId);
    else if (e.kind === "Stop" && typeof e.body.reason === "string") {
      if (open.length) folded.add(e);
      for (const callId of open) reasons.set(callId, e.body.reason);
      open = [];
    }
  }
  return { reasons, folded };
}

export { INTERRUPTED_TOOL_RESULT };

export interface SeededMessage {
  role: "user" | "assistant";
  text: string;
}

export interface OverheardEntryPayload {
  overheard: true;
  sourceRole?: "agent";
  ts: string;
  changeTime?: string;
  name?: string;
  speakerId?: string;
  text: string;
  files?: string[];
  mentions?: Record<string, string>;
}

function overheardOf(e: Item): OverheardEntryPayload | null {
  if (!isOverheard(e) || !e.externalId) return null;
  const { overheard: _o, ...rest } = e.body;
  return {
    ...(rest as Omit<OverheardEntryPayload, "overheard" | "ts" | "text">),
    overheard: true,
    ts: e.externalId,
    text: e.text ?? "",
  };
}

export function overheardItem(p: OverheardEntryPayload): NewItem<"UserMessage"> {
  const { ts, text, ...body } = p;
  return { kind: "UserMessage", externalId: ts, text, body };
}

export function recordedMessageTimestamps(history: readonly Item[]): Set<string> {
  const seen = new Set<string>();
  for (const e of history) {
    const ts = messageTs(e);
    if (ts) seen.add(ts);
  }
  return seen;
}

export function selectOverheardToImport(
  incoming: readonly OverheardMessage[],
  imported: ReadonlySet<string>,
): OverheardEntryPayload[] {
  const fresh = incoming
    .filter((m) => typeof m.ts === "string" && m.ts && !imported.has(m.ts))
    .sort((a, b) => {
      if (a.ts < b.ts) return -1;
      if (a.ts > b.ts) return 1;
      return 0;
    });
  const out: OverheardEntryPayload[] = [];
  const seen = new Set(imported);
  for (const m of fresh) {
    if (seen.has(m.ts!)) continue;
    const text = String(m.text ?? "").trim();
    if (!text && !m.files?.length) continue;
    seen.add(m.ts!);
    out.push({
      overheard: true,
      ...(m.role === "self" ? { sourceRole: "agent" as const } : {}),
      ts: m.ts,
      ...(m.name ? { name: m.name } : {}),
      ...(m.speakerId ? { speakerId: m.speakerId } : {}),
      text,
      ...(m.files?.length ? { files: m.files } : {}),
      ...(m.mentions && Object.keys(m.mentions).length ? { mentions: m.mentions } : {}),
    });
  }
  return out;
}

const DAY_MARKER_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: DEFAULT_CRON_TIMEZONE,
});

function itemDay(e: Item): string {
  const ov = overheardOf(e);
  const sent = ov ? Date.parse(isoFromTs(ov.ts)) : Number.NaN;
  return DAY_MARKER_FORMAT.format(Number.isFinite(sent) ? sent : e.createdAt);
}

export function dayMarkerPrefix(previous: Item | undefined, e: Item): string {
  const day = itemDay(e);
  return previous && itemDay(previous) === day ? "" : `── ${day} ──\n`;
}

export function renderOverheard(p: OverheardEntryPayload): string {
  const body = p.text || (p.files?.length ? "(shared file)" : "");
  return messageTag(
    {
      overheard: true,
      from: p.sourceRole ?? "human",
      ...(p.ts ? { id: p.ts, sentAt: isoFromTs(p.ts) } : {}),
      ...(p.name?.trim() ? { author: p.name.trim() } : {}),
      ...(p.mentions && Object.keys(p.mentions).length ? { mentions: p.mentions } : {}),
    },
    body,
    p.files,
  );
}

export interface ReplayImageRef {
  artifactId?: string;
  mimeType: string;
}
type ReplayImageRefBlock = { type: "image"; ref: ReplayImageRef };
type ReplayUserMessage = Omit<UserMessage, "content"> & {
  content: Array<TextContent | ImageContent | ReplayImageRefBlock>;
};
export type PiReplayMessage = ReplayUserMessage | AssistantMessage | ToolResultMessage;

export type ReplayStep = Pick<AssistantMessage, "api" | "provider" | "model" | "stopReason"> & {
  id: string;
  index?: number;
};

export type ToolCallWire = Partial<Omit<ToolCall, "type" | "id" | "arguments">> & { argumentsJson?: string };

export type StoredResultContent = TextContent | Omit<ImageContent, "data">;
export type ToolResultWire = Partial<Pick<ToolResultMessage, "isError">> & { content?: StoredResultContent[] };

export const AGENT_OPENED_TEXT = "[The agent opened this conversation.]";

export const OMITTED_IMAGE_TEXT = "[image omitted from replay]";

export function userPromptText(payload: {
  text?: unknown;
  environment?: unknown;
  goalNote?: unknown;
  prompt?: unknown;
}): string {
  if (typeof payload.prompt === "string") return payload.prompt;
  return [payload.goalNote, payload.text, payload.environment]
    .filter((s): s is string => typeof s === "string" && !!s.trim())
    .join("\n\n");
}

function itemText(e: Item): string {
  return (e.text ?? "").trim();
}

function itemStep(e: Item): ReplayStep | null {
  const message = stepMessage(e);
  if (!message || typeof message.id !== "string") return null;
  return { ...(message as unknown as ReplayStep), ...(e.step !== null ? { index: e.step } : {}) };
}

export function legacyAssistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "",
    provider: "",
    model: "",
    timestamp,
    stopReason: "stop",
    usage: zeroUsage(),
  };
}

type Positioned = { index: number; block: AssistantMessage["content"][number] };

function stepBlocks(e: Item, step: ReplayStep): Positioned[] {
  const p = e.body;
  const at = step.index ?? 0;
  if (e.kind === "Reasoning")
    return [{ index: at, block: { ...visibleBody(e), type: "thinking", thinking: e.text ?? "" } as ThinkingContent }];
  if (e.kind === "AgentMessage" && e.variant === "narration")
    return [{ index: at, block: { ...visibleBody(e), type: "text", text: e.text ?? "" } as TextContent }];
  if (e.kind === "ToolCall") {
    if (!e.callId) return [];
    const {
      argumentsJson,
      message: _message,
      ...wire
    } = (isObj(p.wire) ? p.wire : {}) as ToolCallWire & {
      message?: unknown;
    };
    const block: ToolCall = {
      type: "toolCall",
      id: e.callId,
      name: e.tool ?? "tool",
      arguments: argumentsJson === undefined ? recordedToolArguments(e) : recordedWireArguments(argumentsJson, e),
      ...wire,
    };
    return [{ index: at, block }];
  }
  if (!isAgentReply(e)) return [];
  if (Array.isArray(p.parts))
    return (p.parts as Array<TextContent & { index: number }>).map(({ index, ...block }) => ({ index, block }));
  if (step.index === undefined) return [];
  const extra = isObj(p.textBlock) ? p.textBlock : {};
  return [{ index: at, block: { ...extra, type: "text", text: e.text ?? "" } as TextContent }];
}

function recordedWireArguments(argumentsJson: string, call: Item): ToolCall["arguments"] {
  try {
    return JSON.parse(argumentsJson) as ToolCall["arguments"];
  } catch (e) {
    swallow(`replay: unparseable recorded arguments for ${String(call.tool)} call ${String(call.callId)}`, e);
    return recordedToolArguments(call);
  }
}

export function recordedToolArguments(call: Pick<Item, "body">): Record<string, unknown> {
  const { rerun, result: _r, approvedRequestId: _a, ...recorded } = visibleBody(call);
  const input = (rerun as { input?: unknown } | undefined)?.input;
  if (isObj(input)) return { ...input, retrySafe: true };
  if (typeof recorded.bytes !== "number" || typeof recorded.text === "string") return recorded;
  if (recorded.action !== "post" && recorded.action !== "reach" && recorded.action !== "edit") return recorded;
  const { bytes: _b, files: recordedFiles, ...rest } = recorded;
  return {
    ...rest,
    ...(Array.isArray(recordedFiles) ? { files: recordedFiles } : {}),
    text: "[sent earlier — text not retained]",
  };
}

function resultContent(content: StoredResultContent[]): ToolResultMessage["content"] {
  return content.map((block) =>
    block.type === "image" && !("data" in block) ? { type: "text", text: OMITTED_IMAGE_TEXT } : (block as TextContent),
  );
}

function toolResultMessage(
  call: ToolCall,
  recordedCall: Item | undefined,
  re: Item | undefined,
  at: number,
  missing: string = INTERRUPTED_TOOL_RESULT,
): ToolResultMessage {
  const base = { role: "toolResult" as const, toolCallId: call.id, toolName: call.name };
  const text = (value: string) => [{ type: "text" as const, text: value }];
  if (!re) {
    const recorded = recordedCall?.body.result;
    return typeof recorded === "string"
      ? { ...base, content: text(recorded), isError: false, timestamp: at }
      : { ...base, content: text(missing), isError: true, timestamp: at };
  }
  if (re.body.interrupted === true)
    return {
      ...base,
      content: text(unrecordedToolResult(re.body.stop as RunStop | undefined)),
      isError: true,
      timestamp: re.createdAt,
    };
  const wire = re.body.wire as ToolResultWire | undefined;
  return {
    ...base,
    content: wire?.content ? resultContent(wire.content) : text(re.text ?? ""),
    isError: wire?.isError ?? re.isError === true,
    timestamp: re.createdAt,
  };
}

export function reconstructMessagesFromHistory(
  history: readonly Item[],
  opts?: { requireUserStart?: boolean },
): PiReplayMessage[] {
  const resultByCallId = new Map<string, Item>();
  const callById = new Map<string, Item>();
  for (const e of history) {
    if (e.kind === "ToolCall" && e.callId) callById.set(e.callId, e);
    else if (e.kind === "ToolResult" && e.callId) resultByCallId.set(e.callId, e);
  }
  const stopped = stoppedToolCalls(history, resultByCallId);
  const raw: PiReplayMessage[] = [];
  const stepped = new Set<PiReplayMessage>();
  const steps = new Map<string, AssistantMessage>();
  const blockIndex = new WeakMap<object, number>();
  const userMsg = (text: string, ts: number): PiReplayMessage => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: ts,
  });

  let previous: Item | undefined;
  let previousUser: Item | undefined;
  let batch: AssistantMessage | undefined;
  for (const e of history) {
    const prior = previous;
    previous = e;
    const summary = contextSummary(e);
    if (summary) {
      raw.push(userMsg(`${contextSummaryHeader(summary.throughSeq, e.createdAt)}\n${summary.text}`, e.createdAt));
      continue;
    }
    const step = itemStep(e);
    if (step) {
      if (step.stopReason === "aborted" || step.stopReason === "error") continue;
      const blocks = stepBlocks(e, step);
      if (!blocks.length) continue;
      let message = steps.get(step.id);
      if (!message) {
        message = {
          role: "assistant",
          content: [],
          api: step.api,
          provider: step.provider,
          model: step.model,
          timestamp: e.createdAt,
          stopReason: step.stopReason,
          usage: zeroUsage(),
        };
        steps.set(step.id, message);
        stepped.add(message);
        raw.push(message);
      }
      for (const { index, block } of blocks) {
        blockIndex.set(block, index);
        const at = message.content.findIndex((b) => blockIndex.get(b)! > index);
        if (at < 0) message.content.push(block);
        else message.content.splice(at, 0, block);
      }
      continue;
    }
    if (isUserItem(e)) {
      const day = dayMarkerPrefix(previousUser, e);
      previousUser = e;
      const ov = overheardOf(e);
      if (ov) {
        if (ov.text.trim() || ov.files?.length) raw.push(userMsg(day + renderOverheard(ov), e.createdAt));
      } else {
        const t = userPromptText({ ...e.body, text: e.text });
        const images = Array.isArray(e.body.images) ? (e.body.images as ReplayImageRef[]) : [];
        if (t || images.length)
          raw.push({
            role: "user",
            content: [{ type: "text", text: day + t }, ...images.map((ref) => ({ type: "image" as const, ref }))],
            timestamp: e.createdAt,
          });
      }
    } else if (isAgentReply(e)) {
      const t = itemText(e);
      const via = typeof e.body.via === "string" ? e.body.via : undefined;
      if (t && via) raw.push(userMsg(messageTag({ from: "agent", via }, t), e.createdAt));
      else if (t) raw.push(legacyAssistant([{ type: "text", text: t }], e.createdAt));
    } else if (e.kind === "AgentMessage" && e.variant === "files_delivered") {
      const t = itemText(e);
      if (t) raw.push(userMsg(deliveryNote(t), e.createdAt));
    } else if (e.kind === "Retraction") {
      const revision = messageRevision(e);
      if (revision) raw.push(userMsg(renderMessageRevision(revision), e.createdAt));
    } else if (e.kind === "Wake") {
      const { kind, text, objective } = e.body;
      if (kind === "goal_cancelled") {
        if (typeof objective === "string") raw.push(userMsg(goalCancelledNote(objective), e.createdAt));
      } else if (typeof text === "string") raw.push(userMsg(text, e.createdAt));
    } else if (e.kind === "Stop") {
      if (typeof e.body.reason === "string" && !stopped.folded.has(e))
        raw.push(userMsg(turnStoppedNote(e.body.reason), e.createdAt));
    } else if (e.kind === "ToolCall") {
      if (!e.callId) continue;
      const block: ToolCall = {
        type: "toolCall",
        id: e.callId,
        name: e.tool ?? "tool",
        arguments: recordedToolArguments(e),
      };
      if (prior?.kind === "ToolCall" && batch && raw.at(-1) === batch) batch.content.push(block);
      else {
        batch = legacyAssistant([block], e.createdAt);
        raw.push(batch);
      }
    }
  }

  const out: PiReplayMessage[] = [];
  for (const m of raw) {
    const prev = out[out.length - 1];
    if (
      prev?.role === "assistant" &&
      m.role === "assistant" &&
      !stepped.has(prev) &&
      !stepped.has(m) &&
      !prev.content.some((c) => c.type === "toolCall") &&
      !m.content.some((c) => c.type === "toolCall")
    ) {
      prev.content.push(...m.content);
      continue;
    }
    out.push(m);
    if (m.role !== "assistant") continue;
    for (const c of m.content) {
      if (c.type !== "toolCall") continue;
      const reason = stopped.reasons.get(c.id);
      const re = resultByCallId.get(c.id);
      if (reason === undefined) out.push(toolResultMessage(c, callById.get(c.id), re, m.timestamp));
      else if (!re)
        out.push(toolResultMessage(c, callById.get(c.id), undefined, m.timestamp, stoppedToolResult(reason)));
      else {
        const result = toolResultMessage(c, callById.get(c.id), re, m.timestamp);
        out.push({ ...result, content: [...result.content, { type: "text", text: turnStoppedNote(reason) }] });
      }
    }
  }
  if (opts?.requireUserStart !== false && out[0] && out[0].role !== "user")
    out.unshift({ role: "user", content: [{ type: "text", text: AGENT_OPENED_TEXT }], timestamp: out[0].timestamp });
  return out;
}

function normalizeForDedup(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function seedPriorTurns(
  turns: readonly ConversationTurn[],
  existingTexts: readonly string[] = [],
): SeededMessage[] {
  const seen = new Set(existingTexts.map(normalizeForDedup).filter(Boolean));
  const reconciled: SeededMessage[] = [];
  for (const t of turns) {
    const text = String(t.text ?? "").trim();
    if (!text) continue;
    if (seen.has(normalizeForDedup(text))) continue;
    const tag =
      t.role === "assistant"
        ? messageTag({ from: "agent", ...(t.name ? { via: t.name } : {}) }, text)
        : messageTag({ from: "human", ...(t.name ? { author: t.name } : {}) }, text);
    reconciled.push({ role: "user", text: tag });
  }
  const merged: SeededMessage[] = [];
  for (const m of reconciled) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.text = `${prev.text}\n${m.text}`;
    else merged.push({ role: m.role, text: m.text });
  }
  return merged;
}
