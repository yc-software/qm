import { escapeSlackText, toSlackMrkdwn } from "./mrkdwn.ts";
import { clip } from "./util.ts";

export type GenerativeUIElement =
  | HeaderElement
  | SectionElement
  | DividerElement
  | FieldsElement
  | ActionsElement
  | ContextElement
  | TableElement
  | ProgressCardElement;

export interface HeaderElement {
  type: "header";
  text: string;
}

export interface SectionElement {
  type: "section";
  text: string;
}

export interface DividerElement {
  type: "divider";
}

export interface FieldsElement {
  type: "fields";
  fields: Array<{ title: string; value: string }>;
}

export interface ActionButton {
  label: string;
  actionId: string;
  value: string;
  style?: "primary" | "danger";
}

export interface ActionsElement {
  type: "actions";
  buttons: ActionButton[];
}

export interface ContextElement {
  type: "context";
  elements: string[];
}

export interface TableElement {
  type: "table";
  headers: string[];
  rows: string[][];
}

export interface ProgressCardElement {
  type: "progress";
  title: string;
  status: "queued" | "in_progress" | "complete" | "failed";
  step?: string;
  percentage?: number;
}

export interface GenerativeUISpec {
  fallbackText?: string;
  elements: GenerativeUIElement[];
}

const SLACK_HEADER_TEXT_MAX = 150;
const SLACK_SECTION_TEXT_MAX = 3000;
const SLACK_BUTTON_TEXT_MAX = 75;
const SLACK_BLOCKS_MAX = 50;
export function renderGenerativeUI(spec: GenerativeUISpec): {
  text: string;
  blocks: Array<Record<string, unknown>>;
} {
  const blocks: Array<Record<string, unknown>> = [];

  for (const element of spec.elements) {
    if (blocks.length >= SLACK_BLOCKS_MAX) break;

    switch (element.type) {
      case "header": {
        const text =
          element.text.length <= SLACK_HEADER_TEXT_MAX ? element.text : clip(element.text, SLACK_HEADER_TEXT_MAX - 1);
        blocks.push({
          type: "header",
          text: {
            type: "plain_text",
            text,
            emoji: true,
          },
        });
        break;
      }
      case "section": {
        const rendered = toSlackMrkdwn(element.text);
        const text = rendered.length <= SLACK_SECTION_TEXT_MAX ? rendered : clip(rendered, SLACK_SECTION_TEXT_MAX - 1);
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text,
          },
        });
        break;
      }
      case "divider": {
        blocks.push({ type: "divider" });
        break;
      }
      case "fields": {
        const fields = element.fields.slice(0, 10).map((f) => {
          const raw = `*${escapeSlackText(f.title)}*\n${toSlackMrkdwn(f.value)}`;
          return {
            type: "mrkdwn",
            text: raw.length <= 2000 ? raw : clip(raw, 1999),
          };
        });
        blocks.push({ type: "section", fields });
        break;
      }
      case "actions": {
        const elements = element.buttons.slice(0, 25).map((btn) => {
          const label =
            btn.label.length <= SLACK_BUTTON_TEXT_MAX ? btn.label : clip(btn.label, SLACK_BUTTON_TEXT_MAX - 1);
          return {
            type: "button",
            text: {
              type: "plain_text",
              text: label,
              emoji: true,
            },
            action_id: btn.actionId,
            value: btn.value,
            ...(btn.style ? { style: btn.style } : {}),
          };
        });
        if (elements.length > 0) {
          blocks.push({ type: "actions", elements });
        }
        break;
      }
      case "context": {
        const elements = element.elements.slice(0, 10).map((text) => {
          const rendered = toSlackMrkdwn(text);
          return {
            type: "mrkdwn",
            text: rendered.length <= 2000 ? rendered : clip(rendered, 1999),
          };
        });
        if (elements.length > 0) {
          blocks.push({ type: "context", elements });
        }
        break;
      }
      case "table": {
        const headerLine = `| ${element.headers.join(" | ")} |`;
        const sepLine = `| ${element.headers.map(() => "---").join(" | ")} |`;
        const bodyLines = element.rows.map((row) => `| ${row.join(" | ")} |`);
        const tableMarkdown = [headerLine, sepLine, ...bodyLines].join("\n");
        const rendered = toSlackMrkdwn(tableMarkdown);
        const text = rendered.length <= SLACK_SECTION_TEXT_MAX ? rendered : clip(rendered, SLACK_SECTION_TEXT_MAX - 1);
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text,
          },
        });
        break;
      }
      case "progress": {
        let icon = "⏸️";
        if (element.status === "complete") icon = "✅";
        else if (element.status === "failed") icon = "❌";
        else if (element.status === "in_progress") icon = "⏳";
        const progressLine =
          element.percentage !== undefined ? ` [${Math.min(100, Math.max(0, Math.round(element.percentage)))}%]` : "";
        const stepLine = element.step ? `\n_${escapeSlackText(element.step)}_` : "";
        const raw = `${icon} *${escapeSlackText(element.title)}*${progressLine}${stepLine}`;
        const text = raw.length <= SLACK_SECTION_TEXT_MAX ? raw : clip(raw, SLACK_SECTION_TEXT_MAX - 1);
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text,
          },
        });
        break;
      }
    }
  }

  const fallback = spec.fallbackText || "Slack card update";
  return {
    text: fallback,
    blocks,
  };
}
export function parseGenerativeUISpec(content: string): GenerativeUISpec | null {
  try {
    const trimmed = content.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed.schema !== "generative-ui.v1" || !Array.isArray(parsed.elements)) return null;
    return parsed as unknown as GenerativeUISpec;
  } catch {
    return null;
  }
}
