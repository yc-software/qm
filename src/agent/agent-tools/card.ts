import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errMessage } from "../../util/errors.ts";
import { isObj } from "../../util/objects.ts";
import type { SelfApiResponse } from "../../tools/self-api.ts";
import { text, type ToolKit } from "./kit.ts";

export type CardKind = "apps" | "add_to_slack" | "link_slack";
type CardDisplay = { kind: CardKind; toolkit?: string };
type Check = { card: CardDisplay; note: string } | { error: string } | { done: string };

const ADD_TO_SLACK_HINT =
  "If this person is an org admin, offer the add_to_slack card; otherwise tell them an admin must add QM to Slack first.";

function failure(response: SelfApiResponse, what: string): string {
  const body = isObj(response.body) ? response.body : {};
  const message = [body.message, body.error].find((value) => typeof value === "string") ?? "";
  return `Couldn't check ${what} (HTTP ${response.status}${message ? `: ${message}` : ""}). Don't show a card; tell them what failed.`;
}

export async function checkCard(
  get: (path: string) => Promise<SelfApiResponse>,
  kind: CardKind,
  toolkit?: string,
): Promise<Check> {
  if (kind === "apps") {
    if (toolkit === "slack")
      return { error: "Slack has its own card: use link_slack for personal Slack access, add_to_slack to install QM." };
    const response = await get(`/v1/composio/toolkits${toolkit ? `?${new URLSearchParams({ toolkit })}` : ""}`);
    if (response.status !== 200) return { error: failure(response, "the app catalog") };
    const items = isObj(response.body) && Array.isArray(response.body.items) ? response.body.items : [];
    if (!toolkit) return { card: { kind }, note: "The app picker is shown with your reply." };
    const found = items.find(
      (item): item is { id: string; name?: string } => isObj(item) && typeof item.id === "string",
    );
    if (!found)
      return {
        error: `No connectable app has the id "${toolkit}". Look up the exact id in GET /v1/composio/toolkits, or call card with kind "apps" and no toolkit to show the picker.`,
      };
    return {
      card: { kind, toolkit: found.id },
      note: `The ${found.name ?? found.id} connect card is shown with your reply.`,
    };
  }
  if (kind === "add_to_slack") {
    const response = await get("/v1/admin/slack-installation");
    if (response.status === 403 || response.status === 401)
      return {
        error:
          "Only an org admin can add QM to the company's Slack, and this person isn't one. Tell them an admin needs to add it; don't show a card.",
      };
    if (response.status !== 200) return { error: failure(response, "Slack installation") };
    if (isObj(response.body) && response.body.configured === true)
      return {
        error:
          "QM is already in the company's Slack workspace. To give this person personal Slack access, use link_slack instead.",
      };
    return { card: { kind }, note: "The Add to Slack card is shown with your reply." };
  }
  const response = await get("/v1/composio/slack");
  if (response.status !== 200) return { error: failure(response, "Slack setup") };
  const status = isObj(response.body) ? response.body : {};
  if (status.workspaceInstalled !== true)
    return {
      error: `QM isn't in the company's Slack workspace yet, so there is no account to link. ${ADD_TO_SLACK_HINT}`,
    };
  if (status.connected === true) {
    const who = [status.user, status.workspace].filter((part) => typeof part === "string" && part).join(" in ");
    return { done: `Their Slack account is already linked${who ? ` (${who})` : ""}. No card needed.` };
  }
  return { card: { kind }, note: "The Link your Slack account card is shown with your reply." };
}

export function cardTool(kit: ToolKit) {
  const { ref, recordCall, recordResult } = kit;
  return defineTool({
    name: "card",
    label: "Card",
    description:
      "Show a setup card with your web chat reply. QM checks the real state first and returns an error instead of a card that couldn't work; act on that error. " +
      "kind apps: the app picker, or with toolkit (an exact id from GET /v1/composio/toolkits) a single connect card for that app. " +
      "add_to_slack: install QM in the company's Slack (org admins only, before it is installed). " +
      "link_slack: link this person's own Slack account (after QM is installed).",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("apps"), Type.Literal("add_to_slack"), Type.Literal("link_slack")]),
      toolkit: Type.Optional(Type.String({ pattern: "^[a-z0-9_-]{1,100}$", description: "apps only: one app's id." })),
    }),
    async execute(callId, params: { kind: CardKind; toolkit?: string }) {
      const selfApi = ref.current?.selfApi;
      await recordCall(callId, { tool: "card", ...params });
      if (!selfApi)
        return recordResult(
          callId,
          { tool: "card", ...params, error: "unavailable" },
          text("[error] Cards aren't available on this turn. Use the skill's link-based path instead."),
          true,
        );
      let check: Check;
      try {
        check = await checkCard(
          (path) => selfApi("GET", path, undefined, ref.abortSignal),
          params.kind,
          params.kind === "apps" ? params.toolkit : undefined,
        );
      } catch (error) {
        check = { error: `Couldn't check whether the card would work (${errMessage(error)}). Don't show a card.` };
      }
      if ("error" in check)
        return recordResult(
          callId,
          { tool: "card", ...params, error: check.error },
          text(`[error] ${check.error}`),
          true,
        );
      if ("done" in check) return recordResult(callId, { tool: "card", ...params }, text(check.done));
      return recordResult(callId, { tool: "card", display: check.card }, text(check.note));
    },
  });
}
