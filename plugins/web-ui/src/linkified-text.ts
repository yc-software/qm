import { html, type TemplateResult } from "lit";
import { splitLinks } from "./linkify.ts";

export function linkifiedText(text: string): TemplateResult {
  return html`${splitLinks(text).map((seg) =>
    seg.kind === "link"
      ? html`<a href=${seg.href} target="_blank" rel="noreferrer noopener" @click=${(e: Event) => e.stopPropagation()}
          >${seg.href}</a
        >`
      : seg.text,
  )}`;
}
