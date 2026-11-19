import { html, type TemplateResult } from "lit";

export const settingsSection = (title: string, body: unknown, o: { card?: boolean } = {}): TemplateResult => html`
  <section class="settings-section">
    <div class="settings-section-head">
      <h3>${title}</h3>
    </div>
    ${o.card === false ? body : html`<div class="settings-card">${body}</div>`}
  </section>
`;
