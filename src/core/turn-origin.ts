import type { DeliveryWebhook, Destination, TurnOrigin, TurnRequest } from "../types.ts";
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

export function liveAutomationDestination(
  request: Pick<Partial<TurnRequest>, "surfaceTools" | "origin">,
): Destination | undefined {
  return request.surfaceTools && request.origin?.kind === "automation" ? request.origin.destination : undefined;
}

export function boundWebhook(
  request: Pick<Partial<TurnRequest>, "deliveryWebhook" | "deliveryTarget" | "approval" | "origin">,
): { webhook: DeliveryWebhook; target: string } | undefined {
  if (request.deliveryWebhook && request.deliveryTarget)
    return { webhook: request.deliveryWebhook, target: request.deliveryTarget };
  const destination = request.origin?.kind === "automation" ? request.origin.destination : undefined;
  if (destination?.type !== "webhook" || !destination.webhook) return undefined;
  if (!request.approval && request.deliveryTarget !== destination.target) return undefined;
  return { webhook: destination.webhook, target: destination.target };
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
