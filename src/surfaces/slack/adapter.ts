import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue, withThread } from "../../reach/reach.ts";
import { SLACK_TEXT_LIMIT } from "../../slack/delivery.ts";
import { classifyUser, slackUserTimezone } from "../../slack/identity.ts";
import type { Destination } from "../../types.ts";
import type { SlackNative, Surface } from "../contract.ts";

export const SLACK_MENTION_SYNTAX =
  "To @-mention on Slack, use `<@U…>` for a person or `<!subteam^S…>` for a user group (ids appear in the conversation roster and in read / search results). A typed `@name` is plain text and pings no one; @here/@channel/@everyone never ping.";

export function createSlackSurface(deps: { deliveries: DeliveryStore }): Surface {
  const slack: SlackNative = {
    userFrom(user, account) {
      const classified = classifyUser(user, account.ownTeamId, account.identityMode);
      const id = String(user?.id ?? "");
      const timezone = slackUserTimezone(user);
      return {
        surface: "slack",
        account: account.id,
        id,
        ...(classified.externalId === id ? {} : { email: classified.externalId }),
        ...(classified.displayName ? { displayName: classified.displayName } : {}),
        ...(classified.isBot ? { bot: true } : {}),
        ...(classified.isExternalGuest ? { guest: true } : {}),
        ...(timezone ? { timezone } : {}),
      };
    },
  };
  return {
    kind: "slack",
    label: "Slack",
    capabilities: {
      threads: true,
      edits: true,
      reactions: "rw",
      privateReply: true,
      cards: true,
      history: true,
      format: "mrkdwn",
      maxChars: SLACK_TEXT_LIMIT,
    },
    async post(ref, message, idempotencyKey) {
      const destination: Destination = {
        type: "slack",
        target: ref.container,
        slackAccountId: ref.account,
      };
      await reachEnqueue({
        deliveries: deps.deliveries,
        destination: withThread(destination, ref.thread),
        text: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        idempotencyKey,
        ...(message.provenance ? { provenance: message.provenance } : {}),
      });
    },
    principalFor(user) {
      const displayName = user.displayName || user.id;
      return {
        externalId: user.email ?? user.id,
        isExternalGuest: Boolean(user.guest),
        ...(user.bot ? { isBot: true } : {}),
        ...(displayName ? { displayName } : {}),
      };
    },
    mention: (user) => `<@${user.id}>`,
    native: (kind) => (kind === "slack" ? slack : null),
  };
}
