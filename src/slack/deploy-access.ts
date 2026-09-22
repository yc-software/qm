import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { DeploymentAccessRequest } from "../deploy/access-requests.ts";
import type { Directory } from "./directory.ts";
import { parseBlockAction, parseInteractionBody } from "./payloads.ts";
import { updateSlackMessage } from "./messaging.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

const ACTIONS = ["deploy_access_approve", "deploy_access_decline"] as const;
const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function deployAccessMessage(req: DeploymentAccessRequest): {
  text: string;
  blocks: Array<Record<string, unknown>>;
} {
  const label = escape(req.appLabel.slice(0, 150));
  const app = /^https?:\/\//.test(req.appUrl)
    ? `<${req.appUrl.replaceAll("|", "%7C").replaceAll(">", "%3E")}|${label}>`
    : label;
  const who = escape(req.requesterId);
  let status = "";
  if (req.status === "approved") status = `Approved. ${who} can now open ${app}.`;
  if (req.status === "declined") status = `Declined. ${who} was told.`;
  const pending = req.status === "pending";
  const text = pending
    ? `${req.requesterId} is asking for access to your app "${req.appLabel}" (${req.appUrl}).`
    : status.replaceAll(/<[^|>]+\|([^>]+)>/g, "$1");
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: pending
          ? `:key: *Access request.*\n*${who}* is asking to open your app ${app}. They signed in, but it isn't shared with them.`
          : `*${status}*`,
      },
    },
  ];
  if (pending) {
    blocks.push({
      type: "actions",
      block_id: `deploy_access:${req.id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          action_id: ACTIONS[0],
          value: req.id,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Decline" },
          action_id: ACTIONS[1],
          value: req.id,
          style: "danger",
        },
      ],
    });
  }
  return { text, blocks };
}

export function registerDeployAccessActions(
  app: { action(pattern: RegExp, handler: (args: any) => Promise<void>): void },
  deps: { core: SlackCoreClient; directory: Directory },
): void {
  app.action(/^deploy_access_/, async ({ ack, body, action, client }) => {
    await ack();
    const parsed = parseBlockAction(action, ACTIONS);
    const { clickerId, channel, messageTs } = parseInteractionBody(body);
    if (!parsed || !clickerId || !channel || !messageTs || !deps.core.deploymentAccessRequests) return;
    try {
      const actor = await deps.directory.classifyActor(client, clickerId);
      const decision = parsed.actionId === "deploy_access_approve" ? "approve" : "decline";
      const request = await deps.core.deploymentAccessRequests.decide(parsed.value, actor, decision);
      const card = deployAccessMessage(request);
      await updateSlackMessage(client, channel, messageTs, card.text, card.blocks);
    } catch (error) {
      await client.chat
        .postEphemeral({
          channel,
          user: clickerId,
          text: `Couldn't complete that: ${errMessage(error)} You can try the button again.`,
        })
        .catch(swallowAs("slack: app access decision failure", undefined));
    }
  });
}
