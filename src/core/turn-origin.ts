import type { TurnOrigin, TurnRequest } from "../types.ts";
export type { TurnOrigin } from "../types.ts";

export const RETIRED_ORIGIN_KEYS = [
  "triggered",
  "unprompted",
  "liveActor",
  "triggerTs",
  "entryTs",
  "securityScreenData",
  "triggerDestination",
  "ownerKeychainUnion",
] as const;

export function isPersonAuthored(kind: TurnOrigin["kind"]): boolean {
  return kind === "human" || kind === "direct";
}

export function spokenByPerson(origin: TurnOrigin): boolean {
  return origin.kind === "human" || (origin.kind === "ambient" && origin.live === true);
}

export function isSessionTurn(input: Pick<TurnRequest, "sessionSenderId" | "delegatingRunId">): boolean {
  return !!input.sessionSenderId || !!input.delegatingRunId;
}

export function sessionTurnOrigin(origin: TurnOrigin | undefined, text: string): TurnOrigin {
  if (!origin || origin.kind === "automation") return { ...origin, kind: "automation", screenData: text };
  if (origin.kind === "human") return { kind: "human" };
  if (origin.kind === "ambient") return { kind: "ambient", ...(origin.live ? { live: true } : {}) };
  return origin;
}

export function desktopClientForTurn(
  input: Partial<
    Pick<TurnRequest, "origin" | "surface" | "desktopClientId" | "proactiveOpener" | "spawned" | "botActor">
  > & { attempt?: number },
): string | undefined {
  return input.origin?.kind === "human" &&
    input.surface === "web" &&
    !input.proactiveOpener &&
    !input.spawned &&
    !input.botActor &&
    (input.attempt ?? 1) <= 1
    ? input.desktopClientId
    : undefined;
}
