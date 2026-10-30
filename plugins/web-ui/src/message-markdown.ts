import "./stable-markdown";
import { html, type TemplateResult } from "lit";
import { normalizePlainTextFences } from "./text-code";

export function markdown(text: string, isStreaming = false, streamingBaseline = ""): TemplateResult {
  return html`<qm-markdown
    dir="auto"
    .isStreaming=${isStreaming}
    .streamingBaseline=${normalizePlainTextFences(streamingBaseline)}
    .content=${normalizePlainTextFences(text)}
  ></qm-markdown>`;
}
