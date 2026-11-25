import { html, nothing, type TemplateResult } from "lit";
import { ExternalLink } from "lucide";
import { charForName } from "./emoji-picker";
import { icon } from "./icons";
import { projectIconTpl } from "./project-icon";
import { slackMark } from "./slack-mark";
import { FORWARD_PREFIX, slackWireToMarkdown, splitOnce } from "./slack-text";
import { escapeHtml } from "./html-escape";
import { marked } from "marked";
import { markdown } from "./message-markdown";
import { appState } from "./shell";
import { tip } from "./tooltip";

export function appTag(): TemplateResult {
  return html`<span class="slack-app-tag">APP</span>`;
}

export function reactionChips(tally: Map<string, string[]> | undefined): TemplateResult | typeof nothing {
  if (!tally?.size) return nothing;
  return html`<div class="slack-reactions">
    ${[...tally].map(
      ([emoji, people]) =>
        html`<span class="slack-reaction" ${tip(`${people.join(", ")} reacted with :${emoji}:`)}
          >${charForName(emoji) ?? projectIconTpl({ kind: "custom", name: emoji }, 16)}<b>${people.length}</b></span
        >`,
    )}
  </div>`;
}

export function slackTitle(channel: string, leaf: string | undefined): TemplateResult {
  return html`<span class="slack-where-chan">${channel}</span>${
      leaf ? html`<span class="slack-where-slash">/</span><span class="slack-where-leaf">${leaf}</span>` : nothing
    }`;
}

export function openInSurface(href: string | null, surface: string | undefined): TemplateResult | typeof nothing {
  if (!href || !surface) return nothing;
  return html`<a
    class="open-in-surface"
    href=${href}
    target="_blank"
    rel="noreferrer"
    aria-label=${`Open in ${surface}`}
    >${slackMark(12)}<span>Open in ${surface}</span>${icon(ExternalLink, 12)}</a
  >`;
}

export function slackWireBubble(text: string): TemplateResult {
  const at = text.indexOf(FORWARD_PREFIX);
  if (at < 0) return html`<div class="slack-wire-text">${markdown(slackWireToMarkdown(text, charForName))}</div>`;
  const rest = text.slice(at + FORWARD_PREFIX.length);
  const close = rest.indexOf("] ");
  const [author, where] = splitOnce(close < 0 ? rest : rest.slice(0, close), " in ");
  const lead = text.slice(0, at).trim();
  return html`${lead ? slackWireBubble(lead) : nothing}
    <div class="slack-forward">
      <div class="slack-forward-head"><b>${author}</b>${where ? html`<span>${where}</span>` : nothing}</div>
      ${slackWireBubble(close < 0 ? "" : rest.slice(close + 2))}
    </div>`;
}

function viewerHandle(): string {
  const me = appState.me?.user ?? "";
  return (me.split("@")[0] || me).trim().toLowerCase();
}

marked.use({
  extensions: [
    {
      name: "slackMention",
      level: "inline",
      start: (src: string) => {
        const at = src.indexOf("<@");
        return at < 0 ? undefined : at;
      },
      tokenizer(src: string) {
        if (!src.startsWith("<@")) return undefined;
        const end = src.indexOf(">");
        const handle = end < 0 ? "" : src.slice(2, end);
        if (!handle || handle.includes("<") || handle.includes("\n")) return undefined;
        return { type: "slackMention", raw: src.slice(0, end + 1), handle };
      },
      renderer(token) {
        const handle = String(token.handle);
        return `<span class="slack-mention${handle.toLowerCase() === viewerHandle() ? " self" : ""}">@${escapeHtml(handle)}</span>`;
      },
    },
  ],
});
