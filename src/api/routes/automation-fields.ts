import type { AutomationPatch } from "../../triggers/automation-store.ts";

export interface AutomationFields {
  title?: string;
  action?: string;
  task?: string;
  enabled?: boolean;
  archived?: boolean;
}

export function isAutomationFields(body: Record<string, unknown>): body is Record<string, unknown> & AutomationFields {
  return (
    ["title", "action", "task"].every((key) => body[key] === undefined || typeof body[key] === "string") &&
    ["enabled", "archived"].every((key) => body[key] === undefined || typeof body[key] === "boolean")
  );
}

export function automationFields(body: AutomationFields): AutomationPatch {
  const action = body.action ?? body.task;
  return {
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(action !== undefined ? { action } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.archived !== undefined ? { archived: body.archived } : {}),
  };
}
