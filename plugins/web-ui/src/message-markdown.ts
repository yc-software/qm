import "./marked-dedupe";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "@mariozechner/mini-lit/dist/CodeBlock.js";
import { html, type TemplateResult } from "lit";
import { normalizePlainTextFences } from "./text-code";
import { escapeLoneDollars } from "./markdown-dollars";

export function markdown(text: string): TemplateResult {
  return html`<markdown-block
    dir="auto"
    .content=${escapeLoneDollars(normalizePlainTextFences(text))}
  ></markdown-block>`;
}
