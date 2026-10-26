export type ItemKind =
  | "UserMessage"
  | "SteeringMessage"
  | "AgentMessage"
  | "Reasoning"
  | "ToolCall"
  | "ToolResult"
  | "Elicitation"
  | "ElicitationResponse"
  | "Wake"
  | "Error"
  | "ContextCompaction"
  | "Retraction"
  | "Stop"
  | "RuntimeChange";

type WakeCause = "cron" | "webhook" | "child_done" | "system";

type AgentMessageVariant = "narration" | "files_delivered";

export interface ItemColumns {
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

type RequiredFor<K extends ItemKind> = K extends keyof RequiredColumns ? RequiredColumns[K] : unknown;

export type Item<K extends ItemKind = ItemKind> = {
  [P in K]: { kind: P; sessionId: string; seq: number; createdAt: number; truncated?: true } & ItemColumns &
    RequiredFor<P>;
}[K];

interface TextStartMarker {
  marker: "text_start";
  seq: number;
  createdAt: number;
  phase?: string;
  streamOffset?: number;
}

interface SandboxStatusMarker {
  marker: "sandbox_status";
  seq: number;
  createdAt: number;
  text: string;
}

export type RunActivityEntry = { item: Item } | TextStartMarker | SandboxStatusMarker;

export type WorkActivity = { item: Item } | TextStartMarker;

export const isUserMessage = (item: Pick<Item, "kind">): boolean =>
  item.kind === "UserMessage" || item.kind === "SteeringMessage";

export const isNarration = (item: Pick<Item, "kind" | "variant">): boolean =>
  item.kind === "AgentMessage" && item.variant === "narration";

export const messageTs = (item: Pick<Item, "kind" | "externalId" | "body">): string | null => {
  if (item.kind === "UserMessage") return item.externalId;
  return item.kind === "SteeringMessage" && typeof item.body.ts === "string" && item.body.ts ? item.body.ts : null;
};

export function stepMessage(item: Pick<Item, "body">): Record<string, unknown> | null {
  const wire = item.body.wire as { message?: unknown } | null | undefined;
  return wire && typeof wire === "object" && wire.message && typeof wire.message === "object"
    ? (wire.message as Record<string, unknown>)
    : null;
}

export function reasoningStepKey(item: Pick<Item, "kind" | "step" | "body">): string | null {
  if (item.kind !== "Reasoning") return null;
  const id = stepMessage(item)?.id;
  return id === undefined || item.step === null ? null : `${String(id)}:${item.step}`;
}

export function activityItems(activity: readonly WorkActivity[]): Item[] {
  return activity.flatMap((entry) => ("item" in entry ? [entry.item] : []));
}

export function activitySeq(entry: WorkActivity): number {
  return "item" in entry ? entry.item.seq : entry.seq;
}

export function activityCreatedAt(entry: WorkActivity): number {
  return "item" in entry ? entry.item.createdAt : entry.createdAt;
}

export const isHidden = (item: Pick<Item, "hidden">): boolean => item.hidden === true;
