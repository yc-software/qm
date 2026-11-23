import { html, nothing, type TemplateResult } from "lit";
import { ExternalLink } from "lucide";
import { charForName } from "./emoji-picker";
import { icon } from "./icons";
import { formatMessageTime } from "./message-time.ts";
import { projectIconTpl } from "./project-icon";
import { slackMark } from "./slack-mark";
import { FORWARD_PREFIX, splitOnce, splitSlackWire, withEmoji } from "./slack-text";
import { tip } from "./tooltip";

export type SlackRow = {
  index: number;
  entrySeqs: string;
  name: string;
  app: boolean;
  avatar: TemplateResult;
  timestamp: number | undefined;
  continued: boolean;
  sending: boolean;
  reactions: Map<string, string[]> | undefined;
  body: TemplateResult;
};

export function slackRow(row: SlackRow): TemplateResult {
  return html`<article
    class="message-row slack-m ${row.continued ? "slack-m-continued" : ""} ${row.sending ? "slack-m-sending" : ""}"
    data-index=${row.index}
    data-entry-seqs=${row.entrySeqs}
  >
    <div class="slack-m-avatar">${row.continued ? nothing : row.avatar}</div>
    <div class="slack-m-main">
      ${
        row.continued
          ? nothing
          : html`<div class="slack-m-head">
              <b>${row.name}</b>${row.app ? html`<span class="slack-app-tag">APP</span>` : nothing}${
                row.timestamp === undefined ? nothing : html`<time>${formatMessageTime(row.timestamp)}</time>`
              }
            </div>`
      }
      <div class="slack-m-body">${row.body}</div>
      ${reactionChips(row.reactions)}
    </div>
  </article>`;
}

function reactionChips(tally: Map<string, string[]> | undefined): TemplateResult | typeof nothing {
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

export type SlackBar = {
  channel: string;
  leaf: string | undefined;
  participants: TemplateResult | typeof nothing;
  people: string;
  href: string | null;
  surface: string | undefined;
};

export function slackBar(bar: SlackBar): TemplateResult {
  return html`<header class="chat-topbar slack-bar">
    <div class="slack-where">
      <span class="slack-where-chan">${bar.channel}</span>${
        bar.leaf
          ? html`<span class="slack-where-slash">/</span><span class="slack-where-leaf" dir="auto">${bar.leaf}</span>`
          : nothing
      }
    </div>
    ${bar.people ? html`<div class="slack-people">${bar.participants}<span>${bar.people}</span></div>` : nothing}
    ${
      bar.href && bar.surface
        ? html`<a class="open-in-surface" href=${bar.href} target="_blank" rel="noreferrer"
            >${slackMark(12)}Open in ${bar.surface}${icon(ExternalLink, 12)}</a
          >`
        : nothing
    }
  </header>`;
}

export function slackWireBubble(text: string, self: string): TemplateResult {
  const at = text.indexOf(FORWARD_PREFIX);
  if (at < 0) return slackWireText(text, self);
  const rest = text.slice(at + FORWARD_PREFIX.length);
  const close = rest.indexOf("] ");
  const [author, where] = splitOnce(close < 0 ? rest : rest.slice(0, close), " in ");
  const lead = text.slice(0, at).trim();
  return html`${lead ? slackWireText(lead, self) : nothing}
    <div class="slack-forward">
      <div class="slack-forward-head"><b>${author}</b>${where ? html`<span>${where}</span>` : nothing}</div>
      ${slackWireBubble(close < 0 ? "" : rest.slice(close + 2), self)}
    </div>`;
}

function slackWireText(text: string, self: string): TemplateResult {
  const segments = splitSlackWire(text).map((seg) => {
    if (seg.kind === "mention")
      return html`<span class="slack-mention ${seg.handle.toLowerCase() === self ? "self" : ""}">@${seg.handle}</span>`;
    if (seg.kind === "link")
      return html`<a class="inbox-text-link" href=${seg.href} target="_blank" rel="noreferrer noopener"
        >${seg.label}</a
      >`;
    return withEmoji(seg.text, charForName);
  });
  return html`<div class="slack-wire-text" dir="auto">${segments}</div>`;
}
