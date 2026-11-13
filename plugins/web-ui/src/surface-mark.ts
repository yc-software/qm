import { html, nothing, type TemplateResult } from "lit";
import { MessagesSquare } from "lucide";
import type { CoreSession } from "./core-bridge.ts";
import { icon } from "./icons.ts";
import { chatSurfaceOf } from "./session-list.ts";
import { slackMark } from "./slack-mark.ts";
import { tip } from "./tooltip.ts";

const BRAND_MARKS: Record<string, (size: number) => TemplateResult> = {
  slack: (size) => slackMark(size, true),
};

export function chatSurfaceMark(
  s: Pick<CoreSession, "surface">,
  size: number,
  className: string,
): TemplateResult | typeof nothing {
  const surface = chatSurfaceOf(s);
  if (!surface) return nothing;
  return html`<span class=${className} ${tip(surface.label)}
    >${BRAND_MARKS[surface.kind]?.(size) ?? icon(MessagesSquare, size)}</span
  >`;
}
