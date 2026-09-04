import type { Destination } from "../types.ts";
import { principalDestination } from "../reach/reach.ts";

function composeConsentNotice(args: { triggerId: string; what: string; ownerName?: string }): string {
  const who = args.ownerName ?? "A teammate";
  return (
    `${who} set up ${args.what} to be delivered to you. It won't start until you accept.\n` +
    `Tell me "accept" to start receiving it, or "decline" to keep it off — you can stop it anytime. (ref: ${args.triggerId})`
  );
}

export async function sendConsentNotice(
  enqueue: (input: { destination: Destination; text: string; idempotencyKey: string }) => Promise<unknown>,
  args: { triggerId: string; recipientId: string; ownerId: string; ownerName?: string; what: string },
): Promise<void> {
  await enqueue({
    destination: principalDestination(args.recipientId, args.ownerId),
    text: composeConsentNotice(args),
    idempotencyKey: `consent-notice:${args.triggerId}`,
  });
}
