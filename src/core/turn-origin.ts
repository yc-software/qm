import type { Destination, TurnOrigin, TurnRequest } from "../types.ts";
export type { TurnOrigin } from "../types.ts";

export function isPersonAuthored(kind: TurnOrigin["kind"]): boolean {
  return kind === "human" || kind === "direct";
}

export function spokenByPerson(origin: TurnOrigin): boolean {
  return origin.kind === "human" || (origin.kind === "ambient" && origin.live === true);
}

export function isSessionTurn(input: Pick<TurnRequest, "sessionSenderId" | "delegatingRunId">): boolean {
  return !!input.sessionSenderId || !!input.delegatingRunId;
}

export function midTurnSessionMessage(message: string, fromParent: boolean): string {
  const sender = fromParent ? "your parent session" : "another session";
  return `A message from ${sender} arrived while you were working. Address it as you continue this turn; it is not a new task.\n${message}`;
}

export function sessionTurnOrigin(origin: TurnOrigin | undefined, text: string): TurnOrigin {
  if (!origin) return { kind: "automation", screenData: text };
  if (origin.kind === "automation") {
    const { fire: _fire, ...relayed } = origin;
    return { ...relayed, screenData: text };
  }
  if (origin.kind === "human") return { kind: "human" };
  if (origin.kind === "ambient") return { kind: "ambient", ...(origin.live ? { live: true } : {}) };
  return origin;
}

export function mayDriveDesktop(
  input: Pick<TurnRequest, "origin" | "botActor" | "proactiveOpener" | "surfaceOrigin">,
): boolean {
  return (
    input.origin?.kind === "human" &&
    !input.botActor &&
    !input.proactiveOpener &&
    input.surfaceOrigin?.audience !== "external"
  );
}

export function desktopClientForTurn(
  input: Partial<
    Pick<
      TurnRequest,
      "origin" | "surface" | "desktopClientId" | "proactiveOpener" | "spawned" | "botActor" | "surfaceOrigin"
    >
  > & { attempt?: number },
): string | undefined {
  return mayDriveDesktop(input) && input.surface === "web" && !input.spawned && (input.attempt ?? 1) <= 1
    ? input.desktopClientId
    : undefined;
}

export function introducesUser(
  origin: TurnOrigin,
  input: Pick<TurnRequest, "sessionSenderId" | "delegatingRunId" | "surfaceOrigin">,
): boolean {
  return (
    (isPersonAuthored(origin.kind) || spokenByPerson(origin)) &&
    !isSessionTurn(input) &&
    input.surfaceOrigin?.audience !== "external"
  );
}

export function automationDestination(request: Pick<TurnRequest, "origin" | "surfaceTools">): Destination | undefined {
  return request.origin?.kind === "automation" && !request.surfaceTools ? request.origin.destination : undefined;
}
