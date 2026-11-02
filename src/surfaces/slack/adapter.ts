import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue, withThread } from "../../reach/reach.ts";
import { classifyUser, slackUserTimezone, type SlackIdentityMode, type SlackUser } from "../../slack/identity.ts";
import type { Destination } from "../../types.ts";
import type { Surface, SurfaceUser } from "../contract.ts";

export interface SlackNative {
  userFrom(
    user: SlackUser | undefined,
    account: { id: string; ownTeamId: string; identityMode: SlackIdentityMode },
  ): SurfaceUser;
}

declare module "../contract.ts" {
  interface SurfaceNatives {
    slack: SlackNative;
  }
}

export function createSlackSurface(deps: { deliveries: DeliveryStore }): Surface {
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
        slackAccountId: ref.account,
        ...(ref.workspace ? { slackTeamId: ref.workspace } : {}),
        ...(ref.policyNamespace ? { slackPolicyNamespace: ref.policyNamespace } : {}),
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
