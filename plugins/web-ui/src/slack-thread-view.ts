import { splitLinks } from "./linkify";
import { html, nothing, type TemplateResult } from "lit";
import { ExternalLink } from "lucide";
import { charForName } from "./emoji-picker";
import { icon } from "./icons";
import { projectIconTpl } from "./project-icon";
import { slackMark } from "./slack-mark";
import { FORWARD_PREFIX, splitOnce, splitSlackWire, withEmoji } from "./slack-text";
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

function textLink(href: string, label: string): TemplateResult {
  return html`<a class="inbox-text-link" href=${href} target="_blank" rel="noreferrer noopener">${label}</a>`;
}

function slackWireText(text: string, self: string): TemplateResult {
  const segments = splitSlackWire(text).map((seg) => {
    if (seg.kind === "mention")
      return html`<span class="slack-mention ${seg.handle.toLowerCase() === self ? "self" : ""}">@${seg.handle}</span>`;
    if (seg.kind === "link") return textLink(seg.href, seg.label);
    return splitLinks(seg.text).map((part) =>
      part.kind === "link" ? textLink(part.href, part.href) : withEmoji(part.text, charForName),
    );
  });
  return html`<div class="slack-wire-text" dir="auto">${segments}</div>`;
}
