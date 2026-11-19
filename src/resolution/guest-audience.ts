import type { TurnRequest } from "../types.ts";

const GUEST_NAMESPACE = "guests";

export function guestRef(ref: string): string {
  return `${GUEST_NAMESPACE}:${ref}`;
}

export function inGuestNamespace(ref: string | undefined): boolean {
  return ref?.startsWith(`${GUEST_NAMESPACE}:`) ?? false;
}

export function guestRequestAllowed(
  request: Pick<TurnRequest, "surfaceOrigin"> & {
    conversation: Pick<TurnRequest["conversation"], "kind" | "channelRef" | "threadRef">;
  },
): boolean {
  const origin = request.surfaceOrigin;
  if (origin?.audience !== "external" || !origin.guests) return false;
  const { companyDomains, companyTeamIds, serviceCredentials } = origin.access;
  const own = guestRef(`${origin.author.surface}:${origin.author.account}:`);
  return (
    request.conversation.kind !== "dm" &&
    origin.workspace === origin.author.account &&
    !companyDomains.length &&
    !companyTeamIds.length &&
    !serviceCredentials.length &&
    [request.conversation.channelRef, request.conversation.threadRef].every((ref) => !ref || ref.startsWith(own))
  );
}
