import { html, nothing, type TemplateResult } from "lit";

export const settingsSection = (
  title: string,
  body: unknown,
  o: { card?: boolean; note?: unknown; action?: unknown; id?: string } = {},
): TemplateResult => html`
  <section class="settings-section" id=${o.id ?? nothing}>
    <div class="settings-section-head">
      <h3>${title}</h3>
      ${o.note ? html`<span>${o.note}</span>` : nothing}${o.action ?? nothing}
    </div>
    ${o.card === false ? body : html`<div class="settings-card">${body}</div>`}
  </section>
`;
