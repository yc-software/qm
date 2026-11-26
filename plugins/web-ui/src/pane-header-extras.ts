import type { TemplateResult } from "lit";

const extras = new Map<string, { key: string; tpl: TemplateResult }>();
let listener: () => void = () => {};

export function setPaneHeaderExtra(sessionId: string, key: string, tpl: TemplateResult): void {
  if (extras.get(sessionId)?.key === key) return;
  extras.set(sessionId, { key, tpl });
  queueMicrotask(() => listener());
}

export function paneHeaderExtra(sessionId: string | undefined): TemplateResult | undefined {
  return sessionId ? extras.get(sessionId)?.tpl : undefined;
}

export function paneHeaderExtraKey(sessionId: string | undefined): string {
  return sessionId ? (extras.get(sessionId)?.key ?? "") : "";
}

export function onPaneHeaderExtrasChange(fn: () => void): void {
  listener = fn;
}
