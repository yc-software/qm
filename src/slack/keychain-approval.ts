import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { Destination } from "../types.ts";
import type { Directory } from "./directory.ts";
import { clip } from "./util.ts";
import { swallowAs } from "../util/errors.ts";

export type KeychainAskActionId = "keychain_ask_allow_once" | "keychain_ask_allow_standing" | "keychain_ask_deny";

type KeychainAskPrompt = NonNullable<Destination["keychainAsk"]>;

export interface KeychainApprovalMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

function actionButton(
  text: string,
  actionId: KeychainAskActionId,
  value: string,
  style?: "primary" | "danger",
): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

function credentialLabel(prompt: KeychainAskPrompt): string {
  return prompt.accountLabel ? `${prompt.service} (${prompt.accountLabel})` : prompt.service;
}

function slackFallbackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function keychainApprovalMessage(prompt: KeychainAskPrompt, now = Date.now()): KeychainApprovalMessage {
  const requester = prompt.requesterName ?? "A teammate";
  const credential = credentialLabel(prompt);
  const hours = Math.max(1, Math.ceil((prompt.expiresAt - now) / 3_600_000));
  const text = slackFallbackText(
    `${requester} is asking to use your ${credential} credential in ${prompt.scopeLabel} for: ${prompt.purpose}`,
  );
  return {
    text: clip(text, 500),
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Credential access requested" },
      },
      {
        type: "section",
        text: {
          type: "plain_text",
          text: clip(`${requester} wants to use your ${credential} credential in ${prompt.scopeLabel}.`, 900),
        },
      },
      {
        type: "section",
        text: { type: "plain_text", text: clip(`Purpose: ${prompt.purpose}`, 900) },
      },
      {
        type: "context",
        elements: [
          {
            type: "plain_text",
            text: `Always allow here stays limited to this credential and Slack conversation. Expires in ${hours}h if unanswered.`,
          },
        ],
      },
      {
        type: "actions",
        block_id: `keychain_ask:${prompt.id}`.slice(0, 255),
        elements: [
          actionButton(
            "Allow once",
            "keychain_ask_allow_once",
            prompt.id,
            prompt.requestedMode === "standing" ? undefined : "primary",
          ),
          actionButton(
            "Always allow here",
            "keychain_ask_allow_standing",
            prompt.id,
            prompt.requestedMode === "standing" ? "primary" : undefined,
          ),
          actionButton("Deny", "keychain_ask_deny", prompt.id, "danger"),
        ],
      },
    ],
  };
}

function decisionFor(actionId: KeychainAskActionId): "once" | "standing" | "deny" {
  if (actionId === "keychain_ask_allow_once") return "once";
  if (actionId === "keychain_ask_allow_standing") return "standing";
  return "deny";
}

function resolutionText(status: "approved" | "declined" | "expired", mode?: "once" | "standing"): string {
  if (status === "declined") return "Denied. The requesting agent will continue without this credential.";
  if (status === "expired") return "This credential request expired. Ask the agent to send a new request.";
  if (mode === "standing") {
    return "Always allowed here. This credential is available in this Slack conversation for the stated purpose until you revoke it in Keychain.";
  }
  return "Allowed once. The requesting agent is continuing now.";
}

function failureText(status: number | undefined): string {
  if (status === 403) return "Only the owner of this credential can approve or deny this request.";
  if (status === 404 || status === 410) {
    return "That credential request is no longer available. Ask the agent to send a new one.";
  }
  return "I couldn't update that credential permission just now. Try again in a moment.";
}

export function createKeychainApprovals(deps: { core: SlackCoreClient; directory: Directory }): {
  registerActions(app: { action(pattern: RegExp, handler: (args: any) => Promise<void>): void }): void;
} {
  async function handleAction({ ack, body, action, client }: any): Promise<void> {
    await ack();
    const actionId = String(action?.action_id ?? "") as KeychainAskActionId;
    if (
      actionId !== "keychain_ask_allow_once" &&
      actionId !== "keychain_ask_allow_standing" &&
      actionId !== "keychain_ask_deny"
    ) {
      return;
    }
    const askId = String(action?.value ?? "");
    const clickerId = String(body?.user?.id ?? "");
    const channel = String(body?.channel?.id ?? "");
    const messageTs = typeof body?.message?.ts === "string" ? body.message.ts : undefined;
    if (!askId || !clickerId || !channel) return;
    let text: string;
    try {
      const actor = await deps.directory.classifyActor(client, clickerId);
      if (actor.isExternalGuest) throw Object.assign(new Error("internal account required"), { status: 403 });
      const resolution = await deps.core.resolveKeychainAsk(askId, actor.externalId, decisionFor(actionId));
      const status = resolution.status === "pending" ? "expired" : resolution.status;
      text = resolutionText(status, resolution.mode);
    } catch (err) {
      const status = (err as { status?: number }).status;
      text = failureText(status);
      await client.chat
        .postEphemeral({ channel, user: clickerId, text })
        .catch(swallowAs("slack: keychain approval postEphemeral", undefined));
      return;
    }
    if (messageTs) {
      try {
        await client.chat.update({
          channel,
          ts: messageTs,
          text,
          blocks: [{ type: "section", text: { type: "plain_text", text } }],
        });
      } catch {
        await client.chat
          .postEphemeral({
            channel,
            user: clickerId,
            text: `${text} I couldn't refresh the original card, but the permission decision was saved.`,
          })
          .catch(swallowAs("slack: keychain approval refresh failure", undefined));
      }
    }
  }

  return {
    registerActions(app) {
      app.action(/^keychain_ask_/, handleAction);
    },
  };
}
