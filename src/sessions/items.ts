import type { ItemKind, WAKE_CAUSES } from "./items-schema.ts";
import { isObj } from "../util/objects.ts";

export type { ItemKind } from "./items-schema.ts";

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
  targetSeq: number | null;
  approved: boolean | null;
  blobSha: string | null;
  body: Record<string, unknown>;
}

interface RequiredColumns {
  Elicitation: { elicitId: string };
  ElicitationResponse: { elicitId: string };
  Wake: { wakeCause: WakeCause };
  Error: { errorCode: string };
}

type Required<K extends ItemKind> = K extends keyof RequiredColumns ? RequiredColumns[K] : unknown;

export type Item<K extends ItemKind = ItemKind> = {
  [P in K]: { kind: P; sessionId: string; seq: number; createdAt: number } & ItemColumns & Required<P>;
}[K];

export type NewItem<K extends ItemKind = ItemKind> = {
  [P in K]: { kind: P } & Partial<ItemColumns> & Required<P>;
}[K];

const USER_MESSAGE_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(["UserMessage", "SteeringMessage"]);

export const isUserMessage = (item: Pick<Item, "kind">): item is Item<"UserMessage" | "SteeringMessage"> =>
  USER_MESSAGE_KINDS.has(item.kind);

export const isOverheard = (item: Pick<Item, "kind" | "body">): boolean =>
  item.kind === "UserMessage" && item.body.overheard === true;

export const messageTs = (item: Pick<Item, "kind" | "externalId" | "body">): string | null => {
  if (item.kind === "UserMessage") return item.externalId;
  return item.kind === "SteeringMessage" && typeof item.body.ts === "string" && item.body.ts ? item.body.ts : null;
};

export function proseText(item: Pick<Item, "kind" | "text" | "body">): string | null {
  if (item.kind === "Wake") return typeof item.body.text === "string" ? item.body.text : null;
  if (item.kind === "Reasoning" || item.kind === "ToolResult" || item.kind === "Error") return null;
  return item.text;
}

export const isReply = (item: Pick<Item, "kind" | "variant">): boolean =>
  item.kind === "AgentMessage" && item.variant === null;

export function stepMessage(item: Pick<Item, "body">): Record<string, unknown> | null {
  const wire = item.body.wire;
  return isObj(wire) && isObj(wire.message) ? wire.message : null;
}

export function itemFields(item: Item): Record<string, unknown> {
  const { sessionId: _s, seq: _q, createdAt: _c, kind: _k, turnId: _t, step: _p, body, ...columns } = item;
  const { wire: _w, ...rest } = body;
  return { ...Object.fromEntries(Object.entries(columns).filter(([, value]) => value !== null)), ...rest };
}

const AUTHORED_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>([
  "UserMessage",
  "SteeringMessage",
  "ElicitationResponse",
  "Stop",
  "RuntimeChange",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonEmpty = (value: string | null | undefined): string | null => (value ? value : null);

export function storedItem(
  item: NewItem,
  at: { sessionId: string; seq: number; createdAt: number; turnId?: string | null },
): Item {
  if ((item.kind === "ToolCall" || item.kind === "ToolResult") && !nonEmpty(item.callId))
    throw new Error(`items: ${item.kind} at seq ${at.seq} has no callId`);
  const turnId = item.turnId ?? at.turnId ?? null;
  return {
    sessionId: at.sessionId,
    seq: at.seq,
    createdAt: at.createdAt,
    kind: item.kind,
    turnId: turnId && UUID.test(turnId) ? turnId.toLowerCase() : null,
    author: AUTHORED_KINDS.has(item.kind) ? nonEmpty(item.author) : null,
    callId: nonEmpty(item.callId),
    elicitId: nonEmpty(item.elicitId),
    wakeCause: item.wakeCause ?? null,
    errorCode: nonEmpty(item.errorCode),
    text: nonEmpty(item.text),
    tool: nonEmpty(item.tool),
    step: item.step ?? null,
    variant: item.variant ?? null,
    isError: item.isError ?? null,
    hidden: item.hidden ?? null,
    externalId: nonEmpty(item.externalId),
    throughSeq: item.throughSeq ?? null,
    targetSeq: item.targetSeq ?? null,
    approved: item.approved ?? null,
    blobSha: nonEmpty(item.blobSha),
    body: item.body ?? {},
  } as Item;
}

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
  ["target_seq", "targetSeq", "bigint"],
  ["approved", "approved", "boolean"],
  ["blob_sha", "blobSha", "text"],
  ["body", "body", "jsonb"],
] as const;

export const USER_ITEM_KINDS: readonly string[] = ["UserMessage", "SteeringMessage"];
export const USER_KINDS = `(${USER_ITEM_KINDS.map((kind) => `'${kind}'`).join(", ")})`;
export const AGENT_REPLY_ITEM = (col: string): string => `${col}.kind = 'AgentMessage'`;
export const SEARCHABLE_ITEM = (col: string): string =>
  `(${col}.kind IN ('UserMessage','SteeringMessage','AgentMessage') AND ${col}.variant IS DISTINCT FROM 'files_delivered' AND ${col}.text IS NOT NULL)`;
export const searchTypeExpr = (col: string): string =>
  `CASE WHEN ${col}.kind IN ${USER_KINDS} THEN 'user' WHEN ${col}.variant = 'narration' THEN 'text' ELSE 'assistant' END`;
export const msOf = (col: string): string => `(EXTRACT(EPOCH FROM ${col}) * 1000)::bigint`;
