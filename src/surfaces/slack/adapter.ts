import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue, withThread } from "../../reach/reach.ts";
import { classifyUser, slackUserTimezone, type SlackIdentityMode, type SlackUser } from "../../slack/identity.ts";
import type { Destination } from "../../types.ts";
import type { ExternalAudienceAccess, Surface, SurfaceUser, TurnSurfaceOrigin } from "../contract.ts";
import { SLACK } from "../registry.ts";

interface SlackNative {
  userFrom(
    user: SlackUser | undefined,
    account: { id: string; ownTeamId: string; identityMode: SlackIdentityMode },
  ): SurfaceUser;
}

const SLACK_PROMPT_HINTS = {
  mentionSyntax:
    "To @-mention on Slack, use `<@U…>` for a person or `<!subteam^S…>` for a user group (ids appear in the conversation roster and in read / search results). A typed `@name` is plain text and pings no one; @here/@channel/@everyone never ping.",
  linkSyntax: "Use Markdown text; Slack-style links are also supported: `<https://example.com|label>`.",
  autonomousStyle:
    "You're on Slack: keep each posted message to at most two sentences unless asked for more. You see only a recent window here; use the `slack` tool's read actions (or `POST $AGENT_API_URL/v1/surface-context`) to reach further back and into other channels.",
  conversationStyle:
    "- This is Slack: keep each reply to a couple of sentences unless they ask for more.\n- Each Slack thread or DM is its own session, so `history` only searches this one. If someone refers to something you can't find here (an earlier request, a file, a brief), read the Slack history with `POST $AGENT_API_URL/v1/surface-context` (no body reads this conversation, including the DM above a thread; use `before`/`match` to page) before asking them to repeat it.",
};

export function slackSurfaceOrigin(source: {
  accountId: string;
  teamId: string;
  userId: string;
  policyNamespace?: string;
  replyThreadTs?: string;
  external?: ExternalAudienceAccess;
}): TurnSurfaceOrigin {
  return {
    author: { surface: "slack", account: source.accountId, id: source.userId },
    workspace: source.teamId,
    ...(source.policyNamespace ? { policyNamespace: source.policyNamespace } : {}),
    ...(source.replyThreadTs ? { replyThread: source.replyThreadTs } : {}),
    ...(source.external
      ? {
          audience: "external",
          access: {
            companyDomains: source.external.companyDomains,
            companyTeamIds: source.external.companyTeamIds,
            serviceCredentials: source.external.serviceCredentials,
          },
        }
      : { audience: "internal" }),
  };
}

export function createSlackSurface(deps: { deliveries: DeliveryStore }): Surface<SlackNative> {
  const slack: SlackNative = {
    userFrom(user, account) {
      const timezone = slackUserTimezone(user);
      return {
        surface: "slack",
        account: account.id,
        id: String(user?.id ?? ""),
        principal: classifyUser(user, account.ownTeamId, account.identityMode),
        ...(timezone ? { timezone } : {}),
      };
    },
  };
  return {
    kind: SLACK,
    label: "Slack",
    capabilities: {
      mirrored: true,
      liveReplies: true,
      nativeActor: true,
      externalParticipants: true,
      textOnly: false,
    },
    promptHints: SLACK_PROMPT_HINTS,
    async post(ref, message, idempotencyKey) {
      if (idempotencyKey.startsWith("run:"))
        throw new Error(`slack surface post: reserved idempotency key ${idempotencyKey}`);
      const destination: Destination = {
        type: "slack",
        target: ref.container,
        account: {
          id: ref.account,
          ...(ref.workspace ? { workspace: ref.workspace } : {}),
          ...(ref.policyNamespace ? { policyNamespace: ref.policyNamespace } : {}),
        },
      };
      await reachEnqueue({
        deliveries: deps.deliveries,
        destination: withThread(destination, ref.thread),
        text: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        idempotencyKey,
        provenance: message.provenance,
      });
    },
    containerOf: (target) => target.split(":")[0]!,
    principalFor: (user) => user.principal,
    mention: (user) => `<@${user.id}>`,
    native: (kind) => (kind === "slack" ? slack : null),
  };
}
