import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue, withThread } from "../../reach/reach.ts";
import { SLACK_TEXT_LIMIT } from "../../slack/delivery.ts";
import { classifyUser, slackUserTimezone, type SlackIdentityMode, type SlackUser } from "../../slack/identity.ts";
import type { Destination } from "../../types.ts";
import type { Surface, SurfaceUser } from "../contract.ts";

export const SLACK_MENTION_SYNTAX =
  "To @-mention on Slack, use `<@U…>` for a person or `<!subteam^S…>` for a user group (ids appear in the conversation roster and in read / search results). A typed `@name` is plain text and pings no one; @here/@channel/@everyone never ping.";

const DEFAULT_ACCOUNT = "default";

interface SlackAccountIdentity {
  ownTeamId: string;
  identityMode: SlackIdentityMode;
}

export interface SlackNative {
  accounts: Map<string, SlackAccountIdentity>;
  userFrom(user: SlackUser | undefined, account: string): SurfaceUser;
}

export function createSlackSurface(deps: { deliveries: DeliveryStore }): Surface {
  const accounts = new Map<string, SlackAccountIdentity>();
  const slack: SlackNative = {
    accounts,
    userFrom(user, account) {
      const classified = classifyUser(user, accounts.get(account)?.ownTeamId ?? "");
      const email = user?.profile?.email;
      const timezone = slackUserTimezone(user);
      return {
        surface: "slack",
        account,
        id: classified.externalId,
        ...(email ? { email } : {}),
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
        ...(ref.account === DEFAULT_ACCOUNT ? {} : { slackAccountId: ref.account }),
      };
      await reachEnqueue({
        deliveries: deps.deliveries,
        destination: withThread(destination, ref.thread),
        text: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        idempotencyKey,
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
        accounts.get(user.account)?.identityMode,
      );
    },
    mention: (user) => `<@${user.id}>`,
    promptHints: () => ({ surfaceLabel: "Slack", mentionSyntax: SLACK_MENTION_SYNTAX }),
    native: (kind) => (kind === "slack" ? slack : null),
  };
}
