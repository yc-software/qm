import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { saveFooter } from "./setting-controls.ts";
import type { SettingsState } from "./settings.ts";

export function brandingCard(s: SettingsState) {
  return html`<section
    class=${classMap({ card: true, "sv-customize": true, "setting-row": true, hidden: !s.available, dirty: s.dirty })}
    id="card-branding"
  >
    <div class="head">
      <h2>Branding</h2>
      <p>
        How this org's surfaces look. Accent is the highlight color across the web UI, admin, and portal; icon is the
        square image beside the name in the top left; mark is a 1–2 character badge drawn over that icon instead; label
        is the assistant's name everywhere it introduces itself; organization name is how the assistant refers to this
        org. Leave a field blank to use the deployment default.
      </p>
    </div>
    <div class="body">
      <label for="branding-accent">Accent color</label>
      <input
        type="text"
        id="branding-accent"
        style="max-width: 200px"
        placeholder="#4f46e5"
        .value=${s.draft.accent || ""}
        @input=${(e: Event) => s.change("accent", (e.target as HTMLInputElement).value)}
      />
      <label for="branding-mark-url" style="margin-top: 12px">Brand icon (https image URL)</label>
      <input
        type="url"
        id="branding-mark-url"
        style="max-width: 420px"
        maxlength="500"
        placeholder="https://example.com/icon.png"
        .value=${s.draft.markUrl || ""}
        @input=${(e: Event) => s.change("markUrl", (e.target as HTMLInputElement).value)}
      />
      <label for="branding-mark" style="margin-top: 12px">Brand mark (1–2 chars)</label>
      <input
        type="text"
        id="branding-mark"
        style="max-width: 200px"
        maxlength="2"
        placeholder="A"
        .value=${s.draft.mark || ""}
        @input=${(e: Event) => s.change("mark", (e.target as HTMLInputElement).value)}
      />
      <label for="branding-self-label" style="margin-top: 12px">Assistant label</label>
      <input
        type="text"
        id="branding-self-label"
        style="max-width: 320px"
        maxlength="40"
        placeholder="Agent"
        .value=${s.draft.selfLabel || ""}
        @input=${(e: Event) => s.change("selfLabel", (e.target as HTMLInputElement).value)}
      />
      <label for="branding-org-name" style="margin-top: 12px">Organization name</label>
      <input
        type="text"
        id="branding-org-name"
        style="max-width: 320px"
        maxlength="40"
        placeholder="Acme Corp"
        .value=${s.draft.orgName || ""}
        @input=${(e: Event) => s.change("orgName", (e.target as HTMLInputElement).value)}
      />
    </div>
    ${saveFooter(s)}
  </section>`;
}
