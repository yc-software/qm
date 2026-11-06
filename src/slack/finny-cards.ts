import { escapeSlackText } from "./mrkdwn.ts";
import { clip } from "./util.ts";

export interface FinnySlackCard {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

export interface FinnyPlanPhase {
  name: string;
  owner: string;
  dependencies: readonly string[];
}

export interface FinnyPlanCardInput {
  requestId: string;
  title: string;
  summary?: string;
  phases: readonly FinnyPlanPhase[];
  certification: string;
  deliverable: string;
  destination: string;
}

export interface FinnyClarificationOption {
  id: string;
  label: string;
  description?: string;
}

export interface FinnyClarificationCardInput {
  requestId: string;
  question: string;
  recommendedOptionId: string;
  options: readonly FinnyClarificationOption[];
}

export const FINNY_PLAN_ACTION_IDS = {
  approve: "finny_plan_approve",
  reject: "finny_plan_reject",
  requestChange: "finny_plan_request_change",
} as const;

const FINNY_CLARIFICATION_OPTION_ACTION_PREFIX = "finny_clarification_option:";
export const FINNY_CLARIFICATION_OTHER_ACTION_ID = "finny_clarification_other";
const SLACK_ACTION_ID_MAX = 255;
const SLACK_ACTION_ELEMENTS_MAX = 25;
const SLACK_BLOCKS_MAX = 50;
const SLACK_BUTTON_TEXT_MAX = 75;
const SLACK_HEADER_TEXT_MAX = 150;
const SLACK_SECTION_TEXT_MAX = 3000;
const SLACK_BUTTON_VALUE_MAX = 2000;
const SLACK_FALLBACK_TEXT_MAX = 4000;

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : clip(text, limit - 1);
}

function required(value: string, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function requestValue(requestId: string): string {
  required(requestId, "requestId");
  if (requestId.length > SLACK_BUTTON_VALUE_MAX)
    throw new Error(`requestId exceeds Slack's ${SLACK_BUTTON_VALUE_MAX}-character button value limit`);
  return requestId;
}

function header(text: string): Record<string, unknown> {
  return {
    type: "header",
    text: { type: "plain_text", text: bounded(text, SLACK_HEADER_TEXT_MAX) },
  };
}

function section(text: string): Record<string, unknown> {
  return {
    type: "section",
    text: { type: "mrkdwn", text: bounded(text, SLACK_SECTION_TEXT_MAX) },
  };
}

function button(text: string, actionId: string, value: string, style?: "primary" | "danger"): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text: bounded(text, SLACK_BUTTON_TEXT_MAX) },
    action_id: actionId,
    value,
    ...(style ? { style } : {}),
  };
}

function escaped(value: string): string {
  return escapeSlackText(value);
}

function phaseBlock(phase: FinnyPlanPhase, index: number): Record<string, unknown> {
  const dependencies = phase.dependencies.length ? phase.dependencies.map(escaped).join(", ") : "None";
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: bounded(`*Phase ${index + 1}* · ${escaped(phase.name)}`, SLACK_SECTION_TEXT_MAX),
    },
    fields: [
      { type: "mrkdwn", text: bounded(`*Owner*\n${escaped(phase.owner)}`, 2000) },
      { type: "mrkdwn", text: bounded(`*Depends on*\n${dependencies}`, 2000) },
    ],
  };
}

function ensureBlockCount(blocks: readonly Record<string, unknown>[]): void {
  if (blocks.length > SLACK_BLOCKS_MAX) throw new Error(`Card exceeds Slack's ${SLACK_BLOCKS_MAX}-block message limit`);
}

function fallback(title: string, status: string): string {
  return bounded(`${status}: ${title}`, SLACK_FALLBACK_TEXT_MAX);
}

export function finnyPlanCard(input: FinnyPlanCardInput): FinnySlackCard {
  const value = requestValue(input.requestId);
  required(input.title, "title");
  const blocks: Array<Record<string, unknown>> = [header(`Finny plan · ${input.title}`)];
  if (input.summary) blocks.push(section(escaped(input.summary)));
  blocks.push(section("*Phases*"));
  if (input.phases.length) blocks.push(...input.phases.map(phaseBlock));
  else blocks.push(section("_No phases specified_"));
  blocks.push(
    section(`*Certification*\n${escaped(input.certification)}`),
    section(`*Deliverable*\n${escaped(input.deliverable)}`),
    section(`*Destination*\n${escaped(input.destination)}`),
    {
      type: "actions",
      elements: [
        button("Approve", FINNY_PLAN_ACTION_IDS.approve, value, "primary"),
        button("Reject", FINNY_PLAN_ACTION_IDS.reject, value, "danger"),
        button("Request change", FINNY_PLAN_ACTION_IDS.requestChange, value),
      ],
    },
  );
  ensureBlockCount(blocks);
  return { text: fallback(input.title, "Plan approval needed"), blocks };
}

export function finnyClarificationOptionActionId(optionId: string): string {
  required(optionId, "Clarification option identifier");
  const actionId = `${FINNY_CLARIFICATION_OPTION_ACTION_PREFIX}${optionId}`;
  if (actionId.length > SLACK_ACTION_ID_MAX)
    throw new Error(
      `Clarification option identifier makes action_id exceed Slack's ${SLACK_ACTION_ID_MAX}-character limit`,
    );
  return actionId;
}

export function finnyClarificationCard(input: FinnyClarificationCardInput): FinnySlackCard {
  const value = requestValue(input.requestId);
  required(input.question, "question");
  if (input.options.length + 1 > SLACK_ACTION_ELEMENTS_MAX)
    throw new Error(`Slack actions allow ${SLACK_ACTION_ELEMENTS_MAX} elements including Other`);
  for (const option of input.options) {
    if (!option.label.trim()) throw new Error("Clarification option label is required");
  }
  const ids = new Set(input.options.map((option) => option.id));
  if (ids.size !== input.options.length) throw new Error("Clarification option identifiers must be unique");
  if (!ids.has(input.recommendedOptionId))
    throw new Error("Recommended option must match a provided option identifier");
  const optionBlocks = input.options.map((option) => {
    const marker = option.id === input.recommendedOptionId ? " · _Recommended_" : "";
    const description = option.description ? `\n${escaped(option.description)}` : "";
    return section(`• *${escaped(option.label)}*${marker}${description}`);
  });
  const elements = input.options.map((option) => {
    const recommended = option.id === input.recommendedOptionId;
    return button(
      recommended ? `${option.label} · Recommended` : option.label,
      finnyClarificationOptionActionId(option.id),
      value,
      recommended ? "primary" : undefined,
    );
  });
  elements.push(button("Other", FINNY_CLARIFICATION_OTHER_ACTION_ID, value));
  return {
    text: fallback(input.question, "Clarification needed"),
    blocks: [
      header("Finny needs a clarification"),
      section(`*${escaped(input.question)}*`),
      ...optionBlocks,
      { type: "actions", elements },
    ],
  };
}

export type FinnyDecision = "approved" | "rejected" | "request_change";

export interface FinnyDecisionCardInput {
  title: string;
  decision: FinnyDecision;
  detail?: string;
}

const DECISION_PRESENTATION: Record<FinnyDecision, { label: string; icon: string }> = {
  approved: { label: "Approved", icon: ":white_check_mark:" },
  rejected: { label: "Rejected", icon: ":no_entry:" },
  request_change: { label: "Changes requested", icon: ":pencil2:" },
};

export function finnyDecisionCard(input: FinnyDecisionCardInput): FinnySlackCard {
  required(input.title, "title");
  const presentation = DECISION_PRESENTATION[input.decision];
  const blocks = [
    header(`Finny plan · ${presentation.label}`),
    section(`${presentation.icon} *${presentation.label}*\n${escaped(input.title)}`),
    ...(input.detail ? [section(escaped(input.detail))] : []),
  ];
  return {
    text: fallback(input.title, presentation.label),
    blocks,
  };
}

export type FinnyResultStatus = "passed" | "blocked" | "failed";

export interface FinnyResultCardInput {
  title: string;
  status: FinnyResultStatus;
  summary: string;
  deliverable?: string;
  destination?: string;
}

const RESULT_PRESENTATION: Record<FinnyResultStatus, { label: string; icon: string }> = {
  passed: { label: "Completed", icon: ":white_check_mark:" },
  blocked: { label: "Blocked", icon: ":octagonal_sign:" },
  failed: { label: "Failed", icon: ":x:" },
};

export function finnyResultCard(input: FinnyResultCardInput): FinnySlackCard {
  required(input.title, "title");
  const presentation = RESULT_PRESENTATION[input.status];
  const blocks = [
    header(`Finny result · ${presentation.label}`),
    section(`${presentation.icon} *${escaped(input.title)}*`),
    section(escaped(input.summary)),
    ...(input.deliverable ? [section(`*Deliverable*\n${escaped(input.deliverable)}`)] : []),
    ...(input.destination ? [section(`*Destination*\n${escaped(input.destination)}`)] : []),
  ];
  return {
    text: fallback(input.title, presentation.label),
    blocks,
  };
}
