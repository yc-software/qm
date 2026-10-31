import type { ConversationKind } from "../types.ts";
import type { SurfaceRef } from "./contract.ts";

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const KIND_TAG: Record<ConversationKind, string> = { dm: "dm", channel: "ch", group: "grp" };
const TAG_KIND = new Map(Object.entries(KIND_TAG).map(([kind, tag]) => [tag, kind as ConversationKind]));

function segment(value: string, field: string): string {
  if (!SEGMENT.test(value))
    throw new Error(`surface ref ${field} must match ${SEGMENT.source}: ${JSON.stringify(value)}`);
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
  if (!kind || rest.length) return undefined;
  if (![surface, account, container].every((part) => part !== undefined && SEGMENT.test(part))) return undefined;
  if (thread !== undefined && !SEGMENT.test(thread)) return undefined;
  return { surface: surface!, account: account!, kind, container: container!, ...(thread ? { thread } : {}) };
}
