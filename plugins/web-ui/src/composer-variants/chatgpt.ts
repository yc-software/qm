import { html } from "lit";
import type { ComposerVariantModule } from "../composer-parts";

export const chatgpt: ComposerVariantModule = {
  render: (p) => html`
    <form class="composer-wrap" data-composer="chatgpt" @submit=${p.onSubmit}>
      ${p.header} ${p.slashMenu} ${p.upgradeNotice} ${p.attachments} ${p.approvals} ${p.textarea}
      <div class="composer-toolbar">
        <div class="composer-left">${p.fileInput}</div>
        <div class="composer-right">${p.defaultButtons} ${p.settingsMenu} ${p.sendControls}</div>
      </div>
      ${p.notice}
    </form>
    ${p.pasteDialog}
  `,
};
