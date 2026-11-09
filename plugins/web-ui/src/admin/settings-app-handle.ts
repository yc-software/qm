import { html } from "lit";
import { APP_HANDLE_CHARS, APP_HANDLE_MAX, isAppHandleShape } from "../../../chassis/src/dns-label.ts";
import { cardClass, saveFooter } from "./setting-controls.ts";
import type { SettingsState } from "./settings.ts";

const APP_HANDLE_RULE = `Use ${APP_HANDLE_CHARS}.`;

export function appHandleError(handle: string): string | undefined {
  return isAppHandleShape(handle) ? undefined : APP_HANDLE_RULE;
}

export function appHandleCard(s: SettingsState) {
  return html`<section class=${cardClass(s, "sv-customize", { "setting-row": true })} id="card-app-handle">
    <div class="head">
      <h2>App handle</h2>
      <p>
        Published apps are served at <code>&lt;handle&gt;-&lt;app&gt;</code> on the apps domain. ${APP_HANDLE_RULE}
        Changing it moves every app to a new address.
      </p>
    </div>
    <div class="body">
      <label for="app-handle">Handle</label>
      <input
        type="text"
        id="app-handle"
        style="max-width: 240px"
        maxlength=${APP_HANDLE_MAX}
        autocapitalize="off"
        spellcheck="false"
        .value=${s.draft.handle || ""}
        @input=${(e: Event) => s.change("handle", (e.target as HTMLInputElement).value)}
      />
    </div>
    ${saveFooter(s)}
  </section>`;
}
