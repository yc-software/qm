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
