import { surfaceHas } from "../surfaces/surface.ts";
import type { TurnRequest } from "../types.ts";

export const PROACTIVE_OPENER_PROMPT =
  "The user just opened the app for the first time and has not typed yet. Greet them by their sign-in name as their AI teammate in a sentence or two, say the first step is connecting their tools, and ask whether to start. Do not ask their name, role, preferred voice, or what they are working on, and do not research their work yet. Follow the onboarding skill. Do not mention Slack bot setup in this automatic greeting; wait for their reply before reading admin-only status. On that human-started turn, handle connections first as the onboarding skill describes. Offer Slack bot setup only to a verified org admin with a confirmed missing bot; silently skip existing, disabled, deferred, or unknown setup. For personal connections, discover authorized access using its existing skill and reuse connected accounts. An empty direct OAuth list does not rule out Composio. Never ask regular users to create OAuth apps or supply project keys; if no source is available to them or setup is deferred, skip connections and continue onboarding.";

export function isIdeasConversation(input: {
  surface?: string;
  conversation: Pick<TurnRequest["conversation"], "kind" | "threadRef">;
}): boolean {
  return (
    surfaceHas(input.surface, "sidebar") &&
    input.conversation.kind === "dm" &&
    /^web:.+:ideas:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.conversation.threadRef,
    )
  );
}
