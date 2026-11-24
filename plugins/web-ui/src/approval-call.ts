import type { PendingApproval } from "./core-bridge.ts";

// The default reason a tool gives when it declares approval for every call. It says nothing about the call itself.
export const BOILERPLATE_APPROVAL_REASON = "this tool asks for approval before each call";

export interface ApprovalField {
  label: string;
  value: string;
  long: boolean;
}

export interface ApprovalCallView {
  title: string;
  via: string | null;
  fields: ApprovalField[];
  raw: string;
}

const CATALOG_KEYS = new Set(["operation", "tool", "arguments"]);
const NESTED_ARG_KEYS = new Set(["args", "arguments", "params", "input"]);
const WORDS: Record<string, string> = { api: "API", id: "ID", ids: "IDs", url: "URL", dm: "DM" };

export function humanize(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase());
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v !== "object" || v === null)) return value.join(", ");
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fieldsOf(args: Record<string, unknown>): ApprovalField[] {
  const out: ApprovalField[] = [];
  const push = (key: string, value: unknown): void => {
    const text = display(value);
    out.push({ label: humanize(key), value: text, long: text.includes("\n") || text.length > 70 });
  };
  for (const [key, value] of Object.entries(args)) {
    if (key === "purpose") continue;
    if (NESTED_ARG_KEYS.has(key) && isRecord(value)) {
      for (const [inner, v] of Object.entries(value)) push(inner, v);
    } else push(key, value);
  }
  return out;
}

/** Reads a tool-call approval's command text (`<label> <canonical JSON>`) into plain labelled rows. */
export function approvalCallView(a: Pick<PendingApproval, "command">): ApprovalCallView | null {
  const brace = a.command.indexOf("{");
  if (brace <= 0) return null;
  const label = a.command.slice(0, brace).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(a.command.slice(brace));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !label) return null;
  const raw = JSON.stringify(parsed, null, 2);
  if (
    typeof parsed.tool === "string" &&
    isRecord(parsed.arguments) &&
    Object.keys(parsed).every((k) => CATALOG_KEYS.has(k))
  )
    return { title: humanize(parsed.tool), via: label, fields: fieldsOf(parsed.arguments), raw };
  if (label === "mcp_call" && typeof parsed.tool === "string")
    return {
      title: humanize(parsed.tool),
      via: typeof parsed.server === "string" ? parsed.server : null,
      fields: fieldsOf(isRecord(parsed.args) ? parsed.args : {}),
      raw,
    };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(label);
  if (mcp) return { title: humanize(mcp[2]!), via: mcp[1]!, fields: fieldsOf(parsed), raw };
  return { title: humanize(label), via: null, fields: fieldsOf(parsed), raw };
}

/** One short line for a collapsed batch row: the call's most telling argument. */
export function approvalCallLine(view: ApprovalCallView): string {
  const pick =
    view.fields.find((f) => /^(text|message|body|subject)$/i.test(f.label)) ??
    view.fields.find((f) => /^(channel|users|to|recipient|email)$/i.test(f.label)) ??
    view.fields[0];
  return pick ? `${pick.label}: ${pick.value.split("\n")[0]}` : view.title;
}

export function realApprovalReason(reason: string | undefined): string | undefined {
  return reason && reason !== BOILERPLATE_APPROVAL_REASON ? reason : undefined;
}

export function allowLabel(a: Pick<PendingApproval, "grantModes">): string {
  return a.grantModes?.session === false && a.grantModes?.always === false ? "Allow" : "Allow once";
}
