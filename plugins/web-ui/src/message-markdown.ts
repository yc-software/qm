import "./stable-markdown";
import { html, type TemplateResult } from "lit";
import { normalizePlainTextFences } from "./text-code";
import { escapeLoneDollars } from "./markdown-dollars";

export function markdown(text: string, isStreaming = false, streamingBaseline = "", embeds = false): TemplateResult {
  return html`<qm-markdown
    dir="auto"
    .isStreaming=${isStreaming}
    .embeds=${embeds}
    .streamingBaseline=${escapeLoneDollars(normalizePlainTextFences(streamingBaseline))}
    .content=${escapeLoneDollars(normalizePlainTextFences(text))}
  ></qm-markdown>`;
}
