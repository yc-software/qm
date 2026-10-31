import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { SurfaceCoreClient } from "../api/surface-core-client.ts";
import type { KeychainApprovalView } from "../credentials/keychain-approval.ts";
import { APPROVAL_SUMMARY_MAX, INLINE_COMMAND_MAX } from "../surfaces/approval-limits.ts";
import { conversationWebUrl } from "../util/conversation-links.ts";
import type { Delivery } from "../types.ts";
import { uuidSchema } from "../util/ids.ts";
import { DISCORD_MESSAGE_LIMIT } from "./format.ts";
import type { OutboundMessage } from "./sender.ts";

export type CardKind = "cmd" | "key" | "dep";
const CARD_ACTIONS = {
  cmd: ["once", "session", "always", "deny"],
  key: ["once", "standing", "deny"],
  dep: ["approve", "decline"],
} as const;
export const APPROVAL_EXPIRED_TEXT = "That approval request is no longer pending.";
const LABELS: Record<CardKind, Record<string, [string, ButtonStyle]>> = {
  cmd: {
    once: ["Allow once", ButtonStyle.Success],
    session: ["Allow for this session", ButtonStyle.Primary],
    always: ["Always allow", ButtonStyle.Primary],
    deny: ["Deny", ButtonStyle.Danger],
  },
  key: {
    once: ["Allow once", ButtonStyle.Success],
    standing: ["Always allow", ButtonStyle.Primary],
    deny: ["Deny", ButtonStyle.Danger],
  },
  dep: { approve: ["Approve", ButtonStyle.Success], decline: ["Decline", ButtonStyle.Danger] },
};

export function cardCustomId(kind: CardKind, action: string, deliveryId: string): string {
  return `qm:${kind}:${action}:${deliveryId}`;
}

export function parseCardCustomId(customId: string): { kind: CardKind; action: string; deliveryId: string } | null {
  const [prefix, kind, action, deliveryId] = customId.split(":");
  if (prefix !== "qm" || !kind || !action || !deliveryId || !uuidSchema.safeParse(deliveryId).success) return null;
  if (!(kind in CARD_ACTIONS)) return null;
  const actions: readonly string[] = CARD_ACTIONS[kind as CardKind];
  return actions.includes(action) ? { kind: kind as CardKind, action, deliveryId } : null;
}

function card(kind: CardKind, actions: readonly string[], deliveryId: string, content: string): OutboundMessage {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    actions.map((a) => {
      const [label, style] = LABELS[kind][a]!;
      return new ButtonBuilder()
        .setCustomId(cardCustomId(kind, a, deliveryId))
        .setLabel(label)
        .setStyle(style);
    }),
  );
  return { content: content.slice(0, DISCORD_MESSAGE_LIMIT), components: [row] };
}

type StoredApprovalView = NonNullable<Awaited<ReturnType<SurfaceCoreClient["getApproval"]>>>;

function commandCard(deliveryId: string, a: StoredApprovalView, webUiPublicUrl: string | undefined): OutboundMessage {
  const title = a.kind === "input" ? "**Release screened output?**" : "**Approval needed**";
  const summary = a.summary?.slice(0, APPROVAL_SUMMARY_MAX) ?? "";
  const body = [title, summary, "```", a.command, "```", a.reason ?? ""].filter(Boolean).join("\n");
  if (a.command.length > INLINE_COMMAND_MAX || body.length > DISCORD_MESSAGE_LIMIT) {
    const place = (a.sessionId && conversationWebUrl(webUiPublicUrl, a.sessionId)) || "this conversation in QM";
    const link = [
      title,
      summary,
      `This is too long to show in Discord. Open ${place} on the web to review and decide.`,
      a.reason ?? "",
    ]
      .filter(Boolean)
      .join("\n");
    return card("cmd", ["deny"], deliveryId, link);
  }
  const actions = CARD_ACTIONS.cmd.filter(
    (x) => !(x === "session" && a.grantModes?.session === false) && !(x === "always" && a.grantModes?.always === false),
  );
  return card("cmd", actions, deliveryId, body);
}

export function keychainSettleText(view: KeychainApprovalView): string {
  if (view.ask.status === "approved") {
    return view.mode === "standing" ? "Always allowed." : "Allowed once.";
  }
  if (view.ask.status === "declined") return "Denied.";
  return APPROVAL_EXPIRED_TEXT;
}

function keychainCard(deliveryId: string, v: KeychainApprovalView): OutboundMessage {
  if (v.ask.status !== "pending") return { content: keychainSettleText(v) };
  const account = v.accountLabel ? ` (${v.accountLabel})` : "";
  return card(
    "key",
    CARD_ACTIONS.key,
    deliveryId,
    `**${v.service}${account}** — access requested from ${v.conversation}`,
  );
}

export function createCardRenderer(
  core: Pick<SurfaceCoreClient, "getApproval" | "keychainApprovals">,
  webUiPublicUrl?: string,
): (d: Delivery) => Promise<OutboundMessage | null> {
  return async (d) => {
    const dest = d.destination;
    if (dest.commandApprovalId) {
      const approval = await core.getApproval(dest.commandApprovalId);
      return approval ? commandCard(d.id, approval, webUiPublicUrl) : { content: APPROVAL_EXPIRED_TEXT };
    }
    if (dest.keychainAskId) {
      const view = await core.keychainApprovals?.get(dest.keychainAskId, dest.target);
      return view ? keychainCard(d.id, view) : { content: APPROVAL_EXPIRED_TEXT };
    }
    if (dest.deploymentAccess) return card("dep", CARD_ACTIONS.dep, d.id, d.text);
    return null;
  };
}
