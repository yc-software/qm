import { orgId } from "../config.ts";
import {
  DISCORD_DM_DELIVERY_TYPE,
  DISCORD_SURFACE,
  discordRevisionThreadRefs,
  parseDiscordThreadRef,
} from "../discord/config.ts";
import { parseSlackThreadRef, slackThreadRefCandidates } from "../slack/message-gating.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { scopeId } from "../types.ts";

interface RevisionScan {
  container: string;
  root?: string;
}

interface RevisionTracking {
  threadRefsFor(event: { container: string; ts: string; sub?: string | null }): string[];
  scansFor(threadRef: string, channelRef: string | undefined): RevisionScan[];
}

export interface SurfaceCapabilities {
  label: string;
  deliveryTypes: readonly string[];
  coreAmbient: boolean;
  approvalCardType: string | null;
  keychainCardInConversation: boolean;
  mentionHint: string;
  revisions: RevisionTracking;
  externalParticipantsAllowed(config: ScopedConfigStore | undefined): Promise<boolean>;
}

const SURFACES: Readonly<Record<string, SurfaceCapabilities>> = {
  slack: {
    label: "Slack",
    deliveryTypes: ["slack", "group", "principal"],
    coreAmbient: true,
    approvalCardType: "principal",
    keychainCardInConversation: true,
    mentionHint:
      " To @-mention on Slack, use `<@U…>` for a person or `<!subteam^S…>` for a user group (ids appear in the conversation roster and in read / search results). A typed `@name` is plain text and pings no one; @here/@channel/@everyone never ping.",
    revisions: {
      threadRefsFor: (e) => slackThreadRefCandidates(e.container, e.ts, e.sub ?? undefined),
      scansFor: (threadRef) => {
        const ref = parseSlackThreadRef(threadRef);
        return ref ? [ref] : [];
      },
    },
    externalParticipantsAllowed: async (config) =>
      config ? config.getExternalSlackParticipantsDurable(scopeId("org", orgId())) : false,
  },
  [DISCORD_SURFACE]: {
    label: "Discord",
    deliveryTypes: [DISCORD_SURFACE, DISCORD_DM_DELIVERY_TYPE],
    coreAmbient: false,
    approvalCardType: DISCORD_DM_DELIVERY_TYPE,
    keychainCardInConversation: false,
    mentionHint:
      " On Discord, `<@123…>` shows a person's name but never pings anyone, and @everyone/@here never ping. React with an emoji character, a :shortcode:, or a custom server emoji as <:name:id> (animated: <a:name:id>), the same spelling reactions show you.",
    revisions: {
      threadRefsFor: (e) => discordRevisionThreadRefs(e.container, e.ts),
      scansFor: (threadRef, channelRef) => {
        const ref = parseDiscordThreadRef(threadRef);
        if (!ref) return [];
        return [{ container: ref.container }, ...(channelRef ? [{ container: channelRef, root: ref.container }] : [])];
      },
    },
    externalParticipantsAllowed: async () => false,
  },
};

export function surfaceCapabilities(surface: string | undefined): SurfaceCapabilities | undefined {
  return surface === undefined ? undefined : SURFACES[surface];
}

export function surfaceForDeliveryType(type: string): string | undefined {
  return Object.entries(SURFACES).find(([, caps]) => caps.deliveryTypes.includes(type))?.[0];
}

export function surfaceToolName(surface: string | undefined, automationDestinationType: string | undefined): string {
  const owner = automationDestinationType === undefined ? undefined : surfaceForDeliveryType(automationDestinationType);
  return owner ?? surface ?? "slack";
}

export function surfaceLabel(surface: string | undefined): string {
  return surfaceCapabilities(surface)?.label ?? surface ?? "Slack";
}
