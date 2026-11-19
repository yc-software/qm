import { html, nothing, type TemplateResult } from "lit";

export const settingsSection = (
  title: string,
  body: unknown,
  o: { card?: boolean; action?: unknown; note?: unknown; id?: string; hidden?: boolean } = {},
): TemplateResult => html`
  <section class="settings-section" id=${o.id ?? nothing} ?hidden=${!!o.hidden}>
    <div class="settings-section-head">
      <h3>${title}</h3>
      ${o.note ? html`<span>${o.note}</span>` : nothing}${o.action ?? nothing}
    </div>
    ${o.card === false ? body : html`<div class="settings-card">${body}</div>`}
  </section>
`;

export const settingsRow = (title: unknown, note: unknown, control: unknown): TemplateResult => html`
  <div class="settings-row">
    <div class="settings-row-copy">
      <div class="settings-row-title">${title}</div>
      ${note ? html`<div class="settings-row-note">${note}</div>` : nothing}
    </div>
    ${control}
  </div>
`;
