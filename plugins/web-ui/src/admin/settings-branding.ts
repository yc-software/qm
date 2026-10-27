import { html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { cardClass, saveFooter } from "./setting-controls.ts";
import type { SettingsState } from "./settings.ts";

const fields = [
  ["accent", "branding-accent", "Accent color", "200px", "", "#4f46e5"],
  ["markUrl", "branding-mark-url", "Brand icon (https image URL)", "420px", "", "https://example.com/icon.png"],
  ["mark", "branding-mark", "Brand mark (1–2 chars)", "200px", "2", "A"],
  ["selfLabel", "branding-self-label", "Assistant label", "320px", "", "Agent"],
  ["orgName", "branding-org-name", "Organization name", "320px", "", "Acme Corp"],
];

export function brandingCard(s: SettingsState) {
  return html`<section class=${cardClass(s, "sv-customize", { "setting-row": true })} id="card-branding">
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
      ${fields.map(
        ([key, id, label, width, max, placeholder], i) =>
          html`<label for=${id} style=${ifDefined(i ? "margin-top: 12px" : undefined)}>${label}</label>
            <input
              type=${key === "markUrl" ? "url" : "text"}
              id=${id}
              style=${"max-width: " + width}
              maxlength=${ifDefined(max || undefined)}
              placeholder=${placeholder}
              .value=${s.draft[key] || ""}
              @input=${(e: Event) => s.change(key, (e.target as HTMLInputElement).value)}
            /> `,
      )}
    </div>
    ${saveFooter(s)}
  </section>`;
}
