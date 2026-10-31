import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue, withThread } from "../../reach/reach.ts";
import { SLACK_TEXT_LIMIT } from "../../slack/delivery.ts";
import { classifyUser, slackUserTimezone } from "../../slack/identity.ts";
import type { Destination } from "../../types.ts";
import type { SlackNative, Surface } from "../contract.ts";

export const SLACK_MENTION_SYNTAX =
  "To @-mention on Slack, use `<@U…>` for a person or `<!subteam^S…>` for a user group (ids appear in the conversation roster and in read / search results). A typed `@name` is plain text and pings no one; @here/@channel/@everyone never ping.";

const LABEL = "Slack";

export function createSlackSurface(deps: { deliveries: DeliveryStore }): Surface {
  const slack: SlackNative = {
    userFrom(user, account) {
      const classified = classifyUser(user, account.ownTeamId, account.identityMode);
      const timezone = slackUserTimezone(user);
      return {
        surface: "slack",
        account: account.id,
        id: String(user?.id ?? ""),
        ...(classified.externalId.includes("@") ? { email: classified.externalId } : {}),
        ...(classified.displayName ? { displayName: classified.displayName } : {}),
        ...(classified.isBot ? { bot: true } : {}),
        ...(classified.isExternalGuest ? { guest: true } : {}),
        ...(timezone ? { timezone } : {}),
      };
    },
  };
  return {
    kind: "slack",
    label: LABEL,
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
      return classifyUser(
        {
          id: user.id,
          ...(user.guest ? { is_restricted: true } : {}),
          ...(user.bot ? { is_bot: true } : {}),
          profile: {
            ...(user.displayName ? { display_name: user.displayName } : {}),
            ...(user.email ? { email: user.email } : {}),
          },
        },
        "",
        user.email ? "email" : "slack-id",
      );
    },
    mention: (user) => `<@${user.id}>`,
    promptHints: () => ({ surfaceLabel: LABEL, mentionSyntax: SLACK_MENTION_SYNTAX }),
    native: (kind) => (kind === "slack" ? slack : null),
  };
}
