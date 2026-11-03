import type { EntryType, ScopeId, SessionEntry } from "../types.ts";
import { jsonbStringify } from "../util/text.ts";
import type { NewEntry } from "./session-store.ts";
import { isObj } from "../util/objects.ts";
import { type ItemKind, WAKE_CAUSES } from "./items-schema.ts";

type WakeCause = (typeof WAKE_CAUSES)[number];

type AgentMessageVariant = "narration" | "files_delivered";

interface ItemColumns {
  turnId: string | null;
  author: string | null;
  callId: string | null;
  elicitId: string | null;
  wakeCause: WakeCause | null;
  errorCode: string | null;
  text: string | null;
  tool: string | null;
  step: number | null;
  variant: AgentMessageVariant | null;
  isError: boolean | null;
  hidden: boolean | null;
  externalId: string | null;
  throughSeq: number | null;
  approved: boolean | null;
  blobSha: string | null;
  body: Record<string, unknown>;
}

interface RequiredColumns {
  ToolCall: { callId: string };
  ToolResult: { callId: string };
  Elicitation: { elicitId: string };
  ElicitationResponse: { elicitId: string };
  Wake: { wakeCause: WakeCause };
  Error: { errorCode: string };
}

type KindColumns<K extends ItemKind> = K extends keyof RequiredColumns ? RequiredColumns[K] : unknown;

export type Item<K extends ItemKind = ItemKind> = {
  [P in K]: { kind: P; sessionId: string; seq: number; createdAt: number } & ItemColumns & KindColumns<P>;
}[K];

export type NewItem<K extends ItemKind = ItemKind> = {
  [P in K]: { kind: P } & Partial<ItemColumns> & KindColumns<P>;
}[K];

export const ITEM_COLUMNS = [
  ["turn_id", "turnId", "uuid"],
  ["kind", "kind", "item_kind"],
  ["author", "author", "text"],
  ["call_id", "callId", "text"],
  ["elicit_id", "elicitId", "text"],
  ["wake_cause", "wakeCause", "wake_cause"],
  ["error_code", "errorCode", "text"],
  ["text", "text", "text"],
  ["tool", "tool", "text"],
  ["step", "step", "int"],
  ["variant", "variant", "text"],
  ["is_error", "isError", "boolean"],
  ["hidden", "hidden", "boolean"],
  ["external_id", "externalId", "text"],
  ["through_seq", "throughSeq", "bigint"],
  ["approved", "approved", "boolean"],
  ["blob_sha", "blobSha", "text"],
  ["body", "body", "jsonb"],
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const AUTHORED_KINDS: ReadonlySet<ItemKind> = new Set([
  "UserMessage",
  "SteeringMessage",
  "ElicitationResponse",
  "Stop",
  "RuntimeChange",
]);
const TEXT_KEYS: Partial<Record<ItemKind, string>> = {
  UserMessage: "text",
  SteeringMessage: "text",
  AgentMessage: "text",
  ContextCompaction: "text",
  Reasoning: "thinking",
  ToolResult: "result",
  Error: "message",
};
const TYPES: Partial<Record<EntryType, ItemKind>> = {
  user: "UserMessage",
  assistant: "AgentMessage",
  text: "AgentMessage",
  delivery: "AgentMessage",
  thinking: "Reasoning",
  tool_call: "ToolCall",
  tool_result: "ToolResult",
  approval_request: "Elicitation",
  approval_resolved: "ElicitationResponse",
};
const SYSTEM_KINDS: Record<string, ItemKind> = {
  context_summary: "ContextCompaction",
  turn_failure: "Error",
  turn_stopped: "Stop",
  message_revision: "Retraction",
  wake: "Wake",
  goal_cancelled: "Wake",
};

export function itemFromEntry(entry: Pick<NewEntry, "type" | "payload" | "author">): NewItem {
  const type = entry.type;
  const payload: unknown = JSON.parse(jsonbStringify(entry.payload ?? null));
  let raw: Record<string, unknown> = {};
  if (isObj(payload) && !Array.isArray(payload)) raw = payload;
  else if (typeof payload === "string") raw = { text: payload };
  else if (payload != null) raw = { value: payload };
  const body = { ...raw };
  let kind = TYPES[type];
  if (type === "system") kind = SYSTEM_KINDS[String(raw.kind)];
  else if (type === "user" && raw.steered === true) kind = "SteeringMessage";
  if (!kind) throw new Error(`items: entry type ${type}/${String(raw.kind)} is not stored`);
  const turnId = str(raw.runId);
  const row: Omit<Item, "sessionId" | "seq" | "createdAt"> = {
    kind,
    turnId: turnId && UUID.test(turnId) ? turnId.toLowerCase() : null,
    author: str(entry.author),
    callId: null,
    elicitId: null,
    wakeCause: null,
    errorCode: null,
    text: null,
    tool: null,
    step: null,
    variant:
      ({ text: "narration", delivery: "files_delivered" } as Partial<Record<EntryType, AgentMessageVariant>>)[type] ??
      null,
    isError: null,
    hidden: null,
    externalId: null,
    throughSeq: null,
    approved: null,
    blobSha: null,
    body,
  };
  const take = (key: string): unknown => {
    const value = body[key];
    delete body[key];
    return value;
  };
  const required = (key: string): string => {
    const value = str(take(key));
    if (!value) throw new Error(`items: ${type} entry has no ${key}`);
    return value;
  };
  const textKey = TEXT_KEYS[kind];
  if (textKey && typeof raw[textKey] === "string") row.text = str(take(textKey));
  if (kind === "ToolCall" || kind === "ToolResult") {
    row.callId = required("callId");
    row.tool = str(take("tool"));
  }
  if (kind === "ToolResult") {
    if (typeof body.isError === "boolean") row.isError = take("isError") as boolean;
    for (const key of ["stdout", "stderr"])
      if (typeof body[key] === "string" && typeof raw.result === "string" && raw.result.includes(body[key])) take(key);
  }
  if (kind === "Elicitation" || kind === "ElicitationResponse") row.elicitId = required("requestId");
  if (kind === "ElicitationResponse" && typeof body.approved === "boolean") row.approved = take("approved") as boolean;
  if (kind === "UserMessage") {
    if (typeof body.hidden === "boolean") row.hidden = take("hidden") as boolean;
    if (typeof body.ts === "string") row.externalId = str(take("ts"));
  }
  if (type === "user") take("steered");
  if (type === "system" && raw.kind !== "goal_cancelled") take("kind");
  if (kind === "Wake") {
    const cause = take("cause") ?? "system";
    row.wakeCause = WAKE_CAUSES.find((v) => v === cause) ?? null;
    if (!row.wakeCause) throw new Error(`items: wake cause ${String(cause)} is not a wake_cause`);
  }
  if (kind === "Error") row.errorCode = "turn_failure";
  if (kind === "ContextCompaction" && typeof body.throughSeq === "number")
    row.throughSeq = take("throughSeq") as number;
  if (row.turnId) take("runId");
  if (["ToolCall", "ToolResult", "Reasoning", "AgentMessage"].includes(kind) && isObj(body.step)) {
    const { index, ...message } = body.step;
    row.step = typeof index === "number" ? index : null;
    body.wire = { ...(isObj(body.wire) ? body.wire : {}), message };
    take("step");
  }
  if (kind === "ToolResult" && isObj(body.output) && typeof body.output.blob === "string") {
    row.blobSha = body.output.blob;
    const { blob: _blob, ...output } = body.output;
    body.output = output;
  }
  take("securityTainted");
  if (type === "assistant" || kind === "Error") take("deliveryKey");
  return row as NewItem;
}

const ENTRY_TYPES: Partial<Record<ItemKind, EntryType>> = {
  UserMessage: "user",
  SteeringMessage: "user",
  AgentMessage: "assistant",
  Reasoning: "thinking",
  ToolCall: "tool_call",
  ToolResult: "tool_result",
  Elicitation: "approval_request",
  ElicitationResponse: "approval_resolved",
};

export function entryFromItem(row: Item, scopeLabel: ScopeId): SessionEntry {
  const payload = { ...row.body };
  if (row.blobSha) payload.output = { ...(isObj(payload.output) ? payload.output : {}), blob: row.blobSha };
  const put = (key: string, value: unknown): void => {
    if (value != null) payload[key] = value;
  };
  let type = ENTRY_TYPES[row.kind] ?? "system";
  if (row.kind === "AgentMessage") {
    if (row.variant === "narration") type = "text";
    else if (row.variant === "files_delivered") type = "delivery";
  }
  const textKey = TEXT_KEYS[row.kind];
  if (textKey && (row.text !== null || !(textKey in payload))) put(textKey, row.text ?? "");
  put("runId", row.turnId);
  put("callId", row.callId);
  put("tool", row.tool);
  put("requestId", row.elicitId);
  put("isError", row.isError);
  put("hidden", row.hidden);
  put("ts", row.externalId);
  put("throughSeq", row.throughSeq);
  put("approved", row.approved);
  if (row.kind === "SteeringMessage") payload.steered = true;
  if (type === "system") {
    const systemKinds: Partial<Record<ItemKind, string>> = {
      ContextCompaction: "context_summary",
      Retraction: "message_revision",
      Error: "turn_failure",
      Stop: "turn_stopped",
    };
    payload.kind = systemKinds[row.kind] ?? (payload.kind === "goal_cancelled" ? "goal_cancelled" : "wake");
  }
  put("cause", row.wakeCause);
  if (row.step != null || (isObj(payload.wire) && isObj(payload.wire.message))) {
    payload.step = {
      ...(isObj(payload.wire) && isObj(payload.wire.message) ? payload.wire.message : {}),
      ...(row.step == null ? {} : { index: row.step }),
    };
  }
  return {
    sessionId: row.sessionId,
    seq: row.seq,
    parentSeq: row.seq === 0 ? null : row.seq - 1,
    type,
    payload,
    scopeLabel,
    createdAt: row.createdAt,
  };
}

export function storedItem(
  item: NewItem,
  at: { sessionId: string; seq: number; createdAt: number; turnId?: string | undefined },
): Item {
  const turnId = at.turnId ?? item.turnId;
  return {
    sessionId: at.sessionId,
    seq: at.seq,
    createdAt: at.createdAt,
    kind: item.kind,
    turnId: turnId && UUID.test(turnId) ? turnId.toLowerCase() : null,
    author: AUTHORED_KINDS.has(item.kind) ? str(item.author) : null,
    callId: str(item.callId),
    elicitId: str(item.elicitId),
    wakeCause: item.wakeCause ?? null,
    errorCode: str(item.errorCode),
    text: str(item.text),
    tool: str(item.tool),
    step: item.step ?? null,
    variant: item.variant ?? null,
    isError: item.isError ?? null,
    hidden: item.hidden ?? null,
    externalId: str(item.externalId),
    throughSeq: item.throughSeq ?? null,
    approved: item.approved ?? null,
    blobSha: str(item.blobSha),
    body: item.body ?? {},
  } as Item;
}

export const USER_ITEM_KINDS: readonly string[] = ["UserMessage", "SteeringMessage"];
export const USER_KINDS = `(${USER_ITEM_KINDS.map((kind) => `'${kind}'`).join(", ")})`;
export const isUserItem = (item: { kind: ItemKind }): boolean => USER_ITEM_KINDS.includes(item.kind);
export const isAgentReply = (item: { kind: ItemKind; variant?: AgentMessageVariant | null }): boolean =>
  item.kind === "AgentMessage" && !item.variant;
export const AGENT_REPLY_ITEM = (col: string): string => `${col}.kind = 'AgentMessage'`;
export const SEARCHABLE_ITEM = (col: string): string =>
  `(${col}.kind IN ('UserMessage','SteeringMessage','AgentMessage') AND ${col}.variant IS DISTINCT FROM 'files_delivered' AND ${col}.text IS NOT NULL)`;
export const searchTypeExpr = (col: string): string =>
  `CASE WHEN ${col}.kind IN ${USER_KINDS} THEN 'user' WHEN ${col}.variant = 'narration' THEN 'text' ELSE 'assistant' END`;
export const msOf = (col: string): string => `(EXTRACT(EPOCH FROM ${col}) * 1000)::bigint`;
