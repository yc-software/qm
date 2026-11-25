import { html, nothing, type TemplateResult } from "lit";
import { composerInput } from "./composer-input";
import type { MentionSource } from "./emoji-completion";

export interface SlackSkin {
  avatar: () => TemplateResult;
  label: string;
  mentions: MentionSource;
}

export function slackComposerForm(
  view: SlackSkin & {
    draft: string;
    status: string;
    error: string;
    attachments: TemplateResult | typeof nothing;
    send: TemplateResult;
    pasteView: TemplateResult | typeof nothing;
    onSubmit: (event: Event) => void;
    onInput: (event: InputEvent) => void;
    onKeydown: (event: KeyboardEvent) => void;
    onPaste: (event: ClipboardEvent) => void;
  },
): TemplateResult {
  let notice: TemplateResult | typeof nothing = nothing;
  if (view.status) notice = html`<div class="composer-note">${view.status}</div>`;
  else if (view.error) notice = html`<div class="composer-error" role="alert">${view.error}</div>`;
  return html`<form class="slack-reply-pill" @submit=${view.onSubmit}>
      ${view.attachments} ${view.avatar()}
      ${composerInput({
        value: view.draft,
        placeholder: "Reply in thread…",
        disabled: false,
        label: `Reply in Slack as ${view.label}`,
        maxLength: 4000,
        mentions: view.mentions,
        onInput: view.onInput,
        onKeydown: view.onKeydown,
        onPaste: view.onPaste,
      })}
      <div class="slack-reply-actions">${view.send}</div>
      ${notice}
    </form>
    ${view.pasteView}`;
}
