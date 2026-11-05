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
export function storedItem<K extends ItemKind>(
  item: NewItem<K>,
  at: { sessionId: string; seq: number; createdAt: number; turnId?: string | undefined },
): Item<K> {
  const turnId = at.turnId ?? item.turnId;
  const columns: ItemColumns = {
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
  };
  return { ...item, ...columns, sessionId: at.sessionId, seq: at.seq, createdAt: at.createdAt } as Item<K>;
}

export const USER_ITEM_KINDS: readonly string[] = ["UserMessage", "SteeringMessage"];
export const USER_KINDS = `(${USER_ITEM_KINDS.map((kind) => `'${kind}'`).join(", ")})`;
export const TENANT = "qm_tenant_id()";
export const userTurn = (col: string): string =>
  `${col}.kind IN ${USER_KINDS} AND NOT (${col}.body @> '{"overheard":true}')`;
export const isUserItem = (item: Pick<Item, "kind">): item is Item<"UserMessage" | "SteeringMessage"> =>
  USER_ITEM_KINDS.includes(item.kind);
export const isAgentReply = (item: { kind: ItemKind; variant?: AgentMessageVariant | null }): boolean =>
  item.kind === "AgentMessage" && !item.variant;
export const isOverheard = (item: Pick<Item, "kind" | "body">): boolean =>
  item.kind === "UserMessage" && item.body.overheard === true;
export const isHidden = (item: Pick<Item, "hidden" | "body">): boolean =>
  item.hidden === true || item.body.hidden === true;
export const messageTs = (item: Pick<Item, "kind" | "externalId" | "body">): string | null => {
  if (item.kind === "UserMessage") return item.externalId;
  return item.kind === "SteeringMessage" && typeof item.body.ts === "string" && item.body.ts ? item.body.ts : null;
};
const PROSE_KINDS: ReadonlySet<ItemKind> = new Set([
  "UserMessage",
  "SteeringMessage",
  "AgentMessage",
  "ContextCompaction",
]);
export function proseText(item: Pick<Item, "kind" | "text" | "body">): string | null {
  if (PROSE_KINDS.has(item.kind)) return item.text ?? "";
  return typeof item.body.text === "string" ? item.body.text : null;
}
export function visibleBody(item: Pick<Item, "body">): Record<string, unknown> {
  const { wire: _wire, ...rest } = item.body;
  return rest;
}
export const compactItem = (item: Partial<Item>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null));
export function itemFields(item: Item): Record<string, unknown> {
  const { sessionId: _s, seq: _q, createdAt: _c, kind: _k, turnId: _t, step: _p, body: _b, ...columns } = item;
  return { ...compactItem(columns), ...visibleBody(item) };
}
export function stepMessage(item: Pick<Item, "body">): Record<string, unknown> | null {
  const wire = item.body.wire;
  return isObj(wire) && isObj(wire.message) ? wire.message : null;
}
export const AGENT_REPLY_ITEM = (col: string): string => `${col}.kind = 'AgentMessage'`;
export const SEARCHABLE_ITEM = (col: string): string =>
  `(${col}.kind IN ('UserMessage','SteeringMessage','AgentMessage') AND ${col}.variant IS DISTINCT FROM 'files_delivered' AND ${col}.text IS NOT NULL)`;
export const searchTypeExpr = (col: string): string =>
  `CASE WHEN ${col}.kind IN ${USER_KINDS} THEN 'user' WHEN ${col}.variant = 'narration' THEN 'text' ELSE 'assistant' END`;
export const msOf = (col: string): string => `(EXTRACT(EPOCH FROM ${col}) * 1000)::bigint`;
