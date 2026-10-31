import type { ConversationKind } from "../types.ts";
import type { SurfaceRef } from "./contract.ts";

const KIND_TAG: Record<ConversationKind, string> = { dm: "dm", channel: "ch", group: "grp" };
const TAG_KIND = new Map(Object.entries(KIND_TAG).map(([kind, tag]) => [tag, kind as ConversationKind]));

const isSegment = (value: string | undefined): value is string =>
  value !== undefined && value !== "" && !value.includes(":");

function segment(value: string, field: string): string {
  if (!isSegment(value))
    throw new Error(`surface ref ${field} must be non-empty without ":": ${JSON.stringify(value)}`);
  return value;
}

export function surfaceContainerRef(ref: Pick<SurfaceRef, "surface" | "account" | "container">): string {
  return [segment(ref.surface, "surface"), segment(ref.account, "account"), segment(ref.container, "container")].join(
    ":",
  );
}

export function surfaceThreadRef(ref: SurfaceRef): string {
  const [surface, account, container] = surfaceContainerRef(ref).split(":");
  return [surface, account, KIND_TAG[ref.kind], container, ...(ref.thread ? [segment(ref.thread, "thread")] : [])].join(
    ":",
  );
}

export function parseSurfaceThreadRef(threadRef: string): SurfaceRef | undefined {
  const [surface, account, tag, container, thread, ...rest] = threadRef.split(":");
  const kind = tag === undefined ? undefined : TAG_KIND.get(tag);
  if (!kind || rest.length || !isSegment(surface) || !isSegment(account) || !isSegment(container)) return undefined;
  if (thread !== undefined && !isSegment(thread)) return undefined;
  return { surface, account, kind, container, ...(thread ? { thread } : {}) };
}
