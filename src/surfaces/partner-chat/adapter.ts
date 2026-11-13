import type { DeliveryStore } from "../../delivery/delivery-store.ts";
import { reachEnqueue } from "../../reach/reach.ts";
import type { ActorAssertion } from "../../types.ts";
import type { Surface, SurfacePromptHints } from "../contract.ts";
import type { SurfaceCache } from "../../surface-cache/types.ts";
import {
  PARTNER_CHAT,
  partnerChatContainer,
  partnerChatMessageIdSchema,
  partnerChatMessageId,
  partnerChatRef,
  parsePartnerChatRef,
  type PartnerChatUser,
} from "./protocol.ts";

const DEFAULT_LABEL = "Partner chat";

const DEFAULT_PROMPT_HINTS: SurfacePromptHints = {
  mentionSyntax:
    "To @-mention someone here, write `@` followed by their name exactly as it appears in the chat roster, e.g. `@Jane Doe`.",
  linkSyntax: "Use Markdown links: `[label](https://example.com)`.",
  autonomousStyle:
    "You're in a group chat: keep each posted message to at most two sentences unless asked for more. You see only a recent window here; use the `partner-chat` tool's read actions (or `POST $AGENT_API_URL/v1/surface-context`) to reach further back.",
  conversationStyle:
    "- This is a group chat: keep each reply to a couple of sentences unless they ask for more.\n- Each chat or thread is its own session, so `history` only searches this one. If someone refers to something you can't find here (an earlier request, a file, a brief), read the chat history with `POST $AGENT_API_URL/v1/surface-context` (no body reads this conversation; use `before`/`match` to page) before asking them to repeat it.",
};

export function partnerChatPrincipal(user: PartnerChatUser, internal: boolean): ActorAssertion {
  const email = user.email?.trim().toLowerCase();
  const name = user.name?.trim();
  return {
    externalId: email?.includes("@") ? email : `partner-chat:${user.id}`,
    ...(internal && email?.includes("@") ? {} : { isExternalGuest: true }),
    ...(user.bot ? { isBot: true } : {}),
    ...(name ? { displayName: name } : {}),
  };
}

export function createPartnerChatSurface(deps: {
  deliveries: DeliveryStore;
  surfaceCache: Pick<SurfaceCache, "readMessages">;
  label?: string;
}): Surface<null> {
  return {
    kind: PARTNER_CHAT,
    label: deps.label ?? DEFAULT_LABEL,
    capabilities: {
      mirrored: true,
      liveReplies: false,
      nativeActor: true,
      externalParticipants: false,
      textOnly: true,
    },
    promptHints: DEFAULT_PROMPT_HINTS,
    async post(ref, message, idempotencyKey) {
      if (idempotencyKey.startsWith("run:"))
        throw new Error(`partner-chat surface post: reserved idempotency key ${idempotencyKey}`);
      await reachEnqueue({
        deliveries: deps.deliveries,
        destination: {
          type: PARTNER_CHAT,
          target: partnerChatRef({
            account: ref.account,
            kind: ref.kind === "dm" ? "dm" : "group",
            chat: ref.container,
            ...(ref.thread ? { thread: ref.thread } : {}),
          }),
        },
        text: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        idempotencyKey,
        provenance: message.provenance,
      });
    },
    async threadTarget(target, threadTs) {
      const ref = parsePartnerChatRef(target);
      const id = partnerChatMessageId(threadTs);
      if (!ref || !partnerChatMessageIdSchema.safeParse(id).success)
        throw new Error(`can't reply under ${threadTs} in ${target}`);
      const [parent] = await deps.surfaceCache.readMessages(partnerChatContainer(target), {
        surface: PARTNER_CHAT,
        timestamps: [threadTs],
        limit: 1,
        noFallback: true,
      });
      return partnerChatRef({ ...ref, thread: parent?.sub ?? id });
    },
    containerOf: partnerChatContainer,
    principalFor: (user) => user.principal,
    mention: (user) => `@${user.principal.displayName ?? user.id}`,
    native: () => null,
  };
}
