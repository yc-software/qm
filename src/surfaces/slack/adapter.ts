import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue, withThread } from "../../reach/reach.ts";
import { classifyUser, slackUserTimezone, type SlackIdentityMode, type SlackUser } from "../../slack/identity.ts";
import type { Destination } from "../../types.ts";
import type { ExternalAudienceAccess, Surface, SurfaceUser, TurnSurfaceOrigin } from "../contract.ts";

interface SlackNative {
  userFrom(
    user: SlackUser | undefined,
    account: { id: string; ownTeamId: string; identityMode: SlackIdentityMode },
  ): SurfaceUser;
}

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
    kind: "slack",
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
    principalFor: (user) => user.principal,
    mention: (user) => `<@${user.id}>`,
    native: (kind) => (kind === "slack" ? slack : null),
  };
}
