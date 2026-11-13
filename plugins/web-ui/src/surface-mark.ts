import { html, nothing, svg, type TemplateResult } from "lit";
import { MessagesSquare } from "lucide";
import type { CoreSession } from "./core-bridge.ts";
import { icon } from "./icons.ts";
import { chatSurfaceOf } from "./session-list.ts";
import { slackMark } from "./slack-mark.ts";
import { tip } from "./tooltip.ts";

const BRAND_MARKS: Record<string, (size: number) => TemplateResult> = {
  slack: (size) => slackMark(size, true),
};

function configuredMark(d: string, size: number): TemplateResult {
  return html`<svg
    class="slack-mark"
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
  >
    ${svg`<path d=${d} fill="currentColor" />`}
  </svg>`;
}

export function chatSurfaceMark(
  s: Pick<CoreSession, "surface">,
  size: number,
  className: string,
): TemplateResult | typeof nothing {
  const surface = chatSurfaceOf(s);
  if (!surface) return nothing;
  const mark = surface.mark ? configuredMark(surface.mark, size) : BRAND_MARKS[surface.kind]?.(size);
  return html`<span class=${className} ${tip(surface.label)}>${mark ?? icon(MessagesSquare, size)}</span>`;
}
