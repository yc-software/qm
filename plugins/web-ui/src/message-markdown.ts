import "./stable-markdown";
import { html, type TemplateResult } from "lit";
import { normalizePlainTextFences } from "./text-code";
import { escapeLoneDollars } from "./markdown-dollars";

export function markdown(text: string): TemplateResult {
  return html`<qm-markdown dir="auto" .content=${escapeLoneDollars(normalizePlainTextFences(text))}></qm-markdown>`;
}
