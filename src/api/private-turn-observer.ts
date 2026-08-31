import { createHash } from "node:crypto";
import { types } from "node:util";
import type { Conversation, Principal, ScopeId, TurnOrigin } from "../types.ts";

export interface PrivateTurnObservation {
  source: "slack_dm" | "web_chat";
  eventRef: string;
  conversationRef: string;
  principalRef: string;
  audienceRef: ScopeId;
  workspaceRef: ScopeId;
  observedAt: string;
  inputSha256: string;
}

export interface PrivateTurnObservationSink {
  observe(
    input: PrivateTurnObservation,
    options?: { signal?: AbortSignal },
  ): Promise<"accepted" | "duplicate" | "unconfirmed">;
}

const OBSERVATION_FIELDS = [
  "source",
  "eventRef",
  "conversationRef",
  "principalRef",
  "audienceRef",
  "workspaceRef",
  "observedAt",
  "inputSha256",
] as const;
const SAFE_REF = /^[^\u0000-\u001F\u007F]{1,512}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export function snapshotPrivateTurnObservation(value: unknown): PrivateTurnObservation {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError("private turn observation must be a plain record");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("private turn observation must be a plain record");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== OBSERVATION_FIELDS.length ||
    OBSERVATION_FIELDS.some((field) => !Object.hasOwn(descriptors, field))
  ) {
    throw new TypeError("private turn observation has unexpected or missing fields");
  }
  const read = (field: (typeof OBSERVATION_FIELDS)[number]): unknown => {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`private turn observation ${field} must be an enumerable data property`);
    }
    return descriptor.value;
  };
  const source = read("source");
  if (source !== "slack_dm" && source !== "web_chat") {
    throw new TypeError("private turn observation source is invalid");
  }
  const ref = (field: "eventRef" | "conversationRef" | "principalRef" | "audienceRef" | "workspaceRef") => {
    const candidate = read(field);
    if (typeof candidate !== "string" || !SAFE_REF.test(candidate)) {
      throw new TypeError(`private turn observation ${field} is invalid`);
    }
    return candidate;
  };
  const observedAt = read("observedAt");
  if (
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(observedAt).toISOString() !== observedAt
  ) {
    throw new TypeError("private turn observation observedAt is invalid");
  }
  const inputSha256 = read("inputSha256");
  if (typeof inputSha256 !== "string" || !DIGEST.test(inputSha256)) {
    throw new TypeError("private turn observation inputSha256 is invalid");
  }
  return Object.freeze({
    source,
    eventRef: ref("eventRef"),
    conversationRef: ref("conversationRef"),
    principalRef: ref("principalRef"),
    audienceRef: ref("audienceRef") as ScopeId,
    workspaceRef: ref("workspaceRef") as ScopeId,
    observedAt,
    inputSha256,
  });
}

export function privateTurnObservation(input: {
  surface: string;
  origin: TurnOrigin;
  actor: Principal;
  conversation: Conversation;
  workspaceRef: ScopeId;
  acceptedRunRef: string;
  acceptedAt: number;
  text: string;
}): PrivateTurnObservation | null {
  if (input.origin.kind !== "human" || input.conversation.kind !== "dm") return null;
  let source: PrivateTurnObservation["source"] | null = null;
  if (input.surface === "slack") source = "slack_dm";
  if (input.surface === "web") source = "web_chat";
  if (!source) return null;
  let sourceEventRef = input.acceptedRunRef;
  let observedAt = input.acceptedAt;
  if (source === "slack_dm") {
    sourceEventRef = input.origin.kind === "human" ? (input.origin.messageTs ?? input.origin.entryTs ?? "") : "";
    if (!/^[0-9]{1,13}\.[0-9]{1,6}$/u.test(sourceEventRef)) return null;
    observedAt = Math.trunc(Number(sourceEventRef) * 1_000);
  }
  if (!sourceEventRef || !Number.isSafeInteger(observedAt) || observedAt < 0 || observedAt > 8_640_000_000_000_000) {
    return null;
  }
  const eventRef = `qm-private-turn:${createHash("sha256")
    .update(source)
    .update("\0")
    .update(input.conversation.threadRef)
    .update("\0")
    .update(sourceEventRef)
    .digest("hex")}`;
  return snapshotPrivateTurnObservation({
    source,
    eventRef,
    conversationRef: input.conversation.threadRef,
    principalRef: input.actor.id,
    audienceRef: `personal:${input.actor.id}`,
    workspaceRef: input.workspaceRef,
    observedAt: new Date(observedAt).toISOString(),
    inputSha256: createHash("sha256").update(input.text, "utf8").digest("hex"),
  });
}

export async function observePrivateTurn(
  sink: PrivateTurnObservationSink,
  observation: PrivateTurnObservation,
  timeoutMs: number,
): Promise<"accepted" | "duplicate" | "unconfirmed"> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve()
    .then(() => sink.observe(observation, { signal: controller.signal }))
    .then((outcome) => (outcome === "accepted" || outcome === "duplicate" ? outcome : ("unconfirmed" as const)))
    .catch(() => "unconfirmed" as const);
  const deadline = new Promise<"unconfirmed">((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve("unconfirmed");
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
