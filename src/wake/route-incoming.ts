import { samePerson } from "../directory/person.ts";
import type { Run } from "../runs/run-store.ts";
import type { TurnOrigin } from "../types.ts";

export function isHalt(text: string, selfHandle = ""): boolean {
  const trimmed = text.trim();
  const tag = selfHandle ? `@${selfHandle}` : "";
  const afterTag = tag && trimmed.startsWith(tag) ? trimmed.slice(tag.length) : undefined;
  const rest = afterTag !== undefined && /^\s/.test(afterTag) ? afterTag : trimmed;
  return /^stop[.!]?$/i.test(rest.trim());
}

export interface Incoming {
  origin: TurnOrigin["kind"];
  person: boolean;
  text: string;
  selfHandle?: string;
  hasFiles: boolean;
  actorId: string;
  modelAccount?: string;
  dedupKey?: string;
  routed: boolean;
}

export type LiveTurn =
  | {
      kind: "run";
      origin: TurnOrigin["kind"];
      actorId: string;
      modelAccount?: string;
      dedupKey?: string | null;
      handlesThisMessage: boolean;
    }
  | { kind: "descendants"; actorIds: string[] };

export interface IncomingPrefs {
  midTurn?: "steer" | "queue";
}

type TurnReason =
  | "not-mid-turn"
  | "nothing-live"
  | "only-subagents-live"
  | "duplicate"
  | "account"
  | "automation-live"
  | "unprompted-live"
  | "queue-preference";

export type IncomingRoute =
  { kind: "turn"; reason: TurnReason } | { kind: "steer" } | { kind: "abort" } | { kind: "drop"; reason: "empty" };

export function mayMeetLiveTurn(message: Incoming): boolean {
  return !message.routed && (message.origin === "human" || message.origin === "ambient");
}

export function stopsLiveWork(message: Pick<Incoming, "origin" | "text" | "selfHandle">, fromStarter = false): boolean {
  return (
    (message.origin === "human" || (fromStarter && message.origin === "ambient")) &&
    isHalt(message.text, message.selfHandle)
  );
}

export function liveTurnOf(run: Run, handlesThisMessage = false): LiveTurn {
  return {
    kind: "run",
    origin: run.request.origin.kind,
    actorId: run.request.actor.id,
    ...(run.request.modelAccount ? { modelAccount: run.request.modelAccount } : {}),
    dedupKey: run.dedupKey ?? null,
    handlesThisMessage,
  };
}

export function routeIncoming(message: Incoming, live: LiveTurn | null, prefs: IncomingPrefs): IncomingRoute {
  if (!mayMeetLiveTurn(message)) return { kind: "turn", reason: "not-mid-turn" };
  if (!live) return { kind: "turn", reason: "nothing-live" };
  if (live.kind === "run" && message.dedupKey && message.dedupKey === live.dedupKey)
    return { kind: "turn", reason: "duplicate" };
  const starters = live.kind === "run" ? [live.actorId] : live.actorIds;
  if (
    stopsLiveWork(
      message,
      starters.some((id) => samePerson(message.actorId, id)),
    )
  )
    return { kind: "abort" };
  if (live.kind === "descendants") return { kind: "turn", reason: "only-subagents-live" };
  if (!message.text.trim() && !message.hasFiles) return { kind: "drop", reason: "empty" };
  const sameAccount =
    message.modelAccount !== undefined &&
    message.modelAccount === live.modelAccount &&
    (message.modelAccount === "company" || message.actorId === live.actorId);
  if (!sameAccount) return { kind: "turn", reason: "account" };
  if (!live.handlesThisMessage) {
    if (live.origin === "automation" && message.person && prefs.midTurn !== "steer")
      return { kind: "turn", reason: "automation-live" };
    if (live.origin === "ambient" && message.origin === "human") return { kind: "turn", reason: "unprompted-live" };
    if (prefs.midTurn === "queue") return { kind: "turn", reason: "queue-preference" };
  }
  return { kind: "steer" };
}
