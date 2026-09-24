import { parseDeployAccess } from "../deploy/access-request.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import { type Destination } from "../types.ts";
import type { Directory } from "./directory.ts";
import { parseBlockAction, parseInteractionBody } from "./payloads.ts";
import { updateSlackMessage } from "./messaging.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

const ACTIONS = ["deploy_access_approve", "deploy_access_decline"] as const;
type Request = NonNullable<Destination["deploymentAccess"]>;

export function deployAccessMessage(
  request: Request,
  text: string,
): { text: string; blocks: Array<Record<string, unknown>> } {
  const value = JSON.stringify(request);
  parseDeployAccess(value);
  return {
    text,
    blocks: [
      { type: "section", text: { type: "plain_text", text: text.slice(0, 3000) } },
      {
        type: "actions",
        elements: ACTIONS.map((action_id, i) => ({
          type: "button",
          action_id,
          value,
          text: { type: "plain_text", text: i === 0 ? "Approve" : "Decline" },
          style: i === 0 ? "primary" : "danger",
        })),
      },
    ],
  };
}

export function registerDeployAccessActions(
  app: { action(pattern: RegExp, handler: (args: any) => Promise<void>): void },
  deps: { core: SlackCoreClient; directory: Directory },
): void {
  app.action(/^deploy_access_/, async ({ ack, body, action, client }) => {
    await ack();
    const parsed = parseBlockAction(action, ACTIONS);
    const { clickerId, channel, messageTs } = parseInteractionBody(body);
    if (!parsed || !clickerId || !channel || !messageTs) return;
    try {
      const actor = await deps.directory.classifyActor(client, clickerId);
      const text = await deps.core.decideDeploymentAccess(parsed.value, actor, parsed.actionId === ACTIONS[0]);
      await updateSlackMessage(client, channel, messageTs, text, [
        { type: "section", text: { type: "plain_text", text } },
      ]);
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
