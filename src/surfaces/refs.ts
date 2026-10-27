import type { ConversationKind } from "../types.ts";

export interface SurfaceConversation {
  surface: string;
  account: string;
  kind: ConversationKind;
  container: string;
  thread?: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const KIND_TAG: Record<ConversationKind, string> = { dm: "dm", channel: "ch", group: "grp" };

function segment(value: string, field: string): string {
  if (!SEGMENT.test(value))
    throw new Error(`surface ref ${field} must match ${SEGMENT.source}: ${JSON.stringify(value)}`);
  return value;
}

export function surfaceContainerRef(ref: Pick<SurfaceConversation, "surface" | "account" | "container">): string {
  return [segment(ref.surface, "surface"), segment(ref.account, "account"), segment(ref.container, "container")].join(
    ":",
  );
}

export function surfaceThreadRef(ref: SurfaceConversation): string {
  const [surface, account, container] = surfaceContainerRef(ref).split(":");
  return [surface, account, KIND_TAG[ref.kind], container, ...(ref.thread ? [segment(ref.thread, "thread")] : [])].join(
    ":",
  );
}

export function surfaceDeliveryTarget(ref: Pick<SurfaceConversation, "container" | "thread">): string {
  return ref.thread
    ? `${segment(ref.container, "container")}:${segment(ref.thread, "thread")}`
    : segment(ref.container, "container");
}

export function parseSurfaceDeliveryTarget(target: string): { container: string; thread?: string } | undefined {
  const [container, thread, ...rest] = target.split(":");
  if (!container || !SEGMENT.test(container) || rest.length || (thread !== undefined && !SEGMENT.test(thread)))
    return undefined;
  return thread ? { container, thread } : { container };
}

export interface SurfaceFileRef {
  channel: string;
  ts: string;
  index: number;
  threadTs?: string;
}

const SLACK_TS = "\\d+\\.\\d+";
const FILE_REF = new RegExp(`^([A-Z0-9]+):(?:(${SLACK_TS})/)?(${SLACK_TS})#(\\d+)$`);

export function formatFileRef(ref: SurfaceFileRef): string {
  return `${ref.channel}:${ref.threadTs && ref.threadTs !== ref.ts ? `${ref.threadTs}/` : ""}${ref.ts}#${ref.index}`;
}

export function parseFileRef(value: string): SurfaceFileRef | undefined {
  const match = FILE_REF.exec(value.trim());
  if (!match) return undefined;
  const index = Number(match[4]);
  if (index < 1) return undefined;
  return { channel: match[1]!, ts: match[3]!, index, ...(match[2] ? { threadTs: match[2] } : {}) };
}

export function namedWithRef(name: string, ref: SurfaceFileRef): string {
  return `${name} [ref ${formatFileRef(ref)}]`;
}
