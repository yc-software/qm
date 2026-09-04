import { button } from "./approval-cards.ts";
import { extractDirectives } from "./directives.ts";

export type AgentRequestActionId = "agent_request_run" | "agent_request_deny";

export interface AgentRequestDirective {
  targetUserId: string;
  task: string;
}

export interface SlackAgentRequest {
  requestId: string;
  originAgentLabel: string;
  targetAgentLabel: string;
  task: string;
}

export interface SlackAgentRequestMessage {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

const AGENT_REQUEST_BLOCK_PREFIX = "agent_request:";

function truncateForSlack(text: string, max = 900): string {
  const safe = text.replace(/\s+/g, " ").trim();
  return `${safe.slice(0, max)}${safe.length > max ? "..." : ""}`;
}

export function agentRequestMessage(req: SlackAgentRequest): SlackAgentRequestMessage {
  const task = truncateForSlack(req.task);
  return {
    text: `${req.originAgentLabel} is asking ${req.targetAgentLabel} to run a personal-scope task.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${req.originAgentLabel} → ${req.targetAgentLabel}*\n${task}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "This runs in your personal agent context. The result can be posted back to the original thread.",
          },
        ],
      },
      {
        type: "actions",
        block_id: `${AGENT_REQUEST_BLOCK_PREFIX}${req.requestId}`.slice(0, 255),
        elements: [
          button("Run with my setup", "agent_request_run", req.requestId, "primary"),
          button("Decline", "agent_request_deny", req.requestId, "danger"),
        ],
      },
    ],
  };
}

export const AGENT_REQUEST_INSTRUCTION =
  "In a shared Slack channel, you may need a specific person's personal agent because the needed " +
  "resource, login, environment variable, or private setup belongs to that person and cannot be " +
  "borrowed by the channel agent. Do not claim you know what's in their personal setup unless the " +
  "conversation says so. Instead, ask that person's personal agent by writing a directive somewhere " +
  "in your reply: `[[ask-agent: <@USERID> | task for their personal agent]]`. Use the Slack user id " +
  "shown in the People here line, for example `<@U123>`. The task should say exactly what the " +
  "personal agent should try and what result is safe to share back to this thread; never ask it to " +
  "reveal secrets. The plugin strips this directive from what humans see, DMs that person for " +
  "approval, runs their personal agent only if they approve, and posts the result back here with " +
  "clear agent labels. If you do not know which person to ask, ask the channel who should be involved. " +
  "This is only for a person's private setup: another agent already in the channel (shown as `agent` in " +
  "the People here line) is a colleague, not a personal agent to hand off to — just @mention it in your " +
  "normal reply using its `<@…>` id and it will answer here in the thread.";

const AGENT_REQUEST_DIRECTIVE = /\[\[ask-agent:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\]\]/gi;
const TRAILING_OPEN_AGENT_REQUEST_DIRECTIVE = /\[\[ask-agent:[\s\S]*$/i;
const SLACK_USER_REF = /^(?:<@([A-Z0-9]+)(?:\|[^>]*)?>|@?([A-Z0-9]+))$/i;

function parseSlackUserRef(ref: string): string | undefined {
  const m = SLACK_USER_REF.exec(ref.trim());
  return m?.[1] ?? m?.[2]?.toUpperCase();
}

export function extractAgentRequests(reply: string): { text: string; requests: AgentRequestDirective[] } {
  const { text, matches } = extractDirectives(
    reply,
    AGENT_REQUEST_DIRECTIVE,
    TRAILING_OPEN_AGENT_REQUEST_DIRECTIVE,
    ([targetRef, taskRaw]) => {
      const targetUserId = parseSlackUserRef(targetRef ?? "");
      const task = (taskRaw ?? "").trim();
      return targetUserId && task ? { targetUserId, task } : undefined;
    },
  );
  return { text, requests: matches };
}

export function stripAgentRequestDirectives(partial: string): string {
  if (!partial) return partial ?? "";
  return partial.replace(AGENT_REQUEST_DIRECTIVE, "").replace(TRAILING_OPEN_AGENT_REQUEST_DIRECTIVE, "");
}
