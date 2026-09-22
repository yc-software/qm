import { html, nothing } from "lit";
import type { CoreSession } from "./core-bridge.ts";
import { tip } from "./tooltip.ts";

export function sessionStatusMark(status: CoreSession["status"]) {
  return status
    ? html`<span class="session-status" role="img" tabindex="0" aria-label=${status.text} ${tip(status.text)}
        >${status.emoji}</span
      >`
    : nothing;
}
