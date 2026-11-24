import { html, type TemplateResult } from "lit";
import { marked } from "marked";
import { escapeHtml } from "./html-escape";
import { onPeople, person } from "./people";
import { appState } from "./shell-state";
import { splitSlackWire, type SlackMention } from "./slack-text";
import { tip } from "./tooltip";

interface Pill {
  label: string;
  state: string;
  title: string;
}

function pillFor(mention: SlackMention): Pill {
  const me = appState.me?.user;
  const selfHandle = (me?.split("@")[0] ?? "").trim().toLowerCase();
  if (mention.broadcast)
    return {
      label: mention.handle,
      state: "broadcast",
      title:
        mention.handle === "here" ? "Notifies everyone online in this channel" : "Notifies everyone in this channel",
    };
  if (mention.group) return { label: mention.handle, state: "", title: "Slack user group" };
  if (!mention.user)
    return { label: mention.handle, state: mention.handle.toLowerCase() === selfHandle ? "self" : "", title: "" };
  const labelled = mention.handle !== mention.user;
  const who = person(mention.user);
  if (who === undefined) return { label: labelled ? mention.handle : "…", state: labelled ? "" : "pending", title: "" };
  if (who === null) return { label: mention.handle, state: labelled ? "" : "unknown", title: "" };
  return {
    label: labelled ? mention.handle : who.displayName,
    state: who.principalId === me ? "self" : "",
    title: who.isBot ? `${who.displayName} · App` : who.principalId,
  };
}

export function mentionPill(mention: SlackMention): TemplateResult {
  const pill = pillFor(mention);
  return html`<span class="slack-mention ${pill.state}" ${tip(pill.title)}>@${pill.label}</span>`;
}

function mentionOf(raw: string): SlackMention | null {
  const segments = splitSlackWire(raw);
  const segment = segments[0];
  if (segments.length !== 1 || segment?.kind !== "mention") return null;
  return segment.user || segment.broadcast || segment.group ? segment : null;
}

function paintPill(element: HTMLElement, mention: SlackMention): void {
  const pill = pillFor(mention);
  element.className = `slack-mention ${pill.state}`.trim();
  element.textContent = `@${pill.label}`;
  if (pill.title) element.title = pill.title;
}

let installed = false;

export function installSlackMentions(): void {
  if (installed) return;
  installed = true;
  marked.use({
    extensions: [
      {
        name: "slackMention",
        level: "inline",
        start(src: string) {
          const at = src.search(/<[@!]/);
          return at < 0 ? undefined : at;
        },
        tokenizer(src: string) {
          const raw = src.slice(0, src.indexOf(">") + 1);
          return raw.startsWith("<") && mentionOf(raw) ? { type: "slackMention", raw } : undefined;
        },
        renderer(token) {
          const mention = mentionOf(token.raw)!;
          const pill = pillFor(mention);
          const title = pill.title ? ` title="${escapeHtml(pill.title)}"` : "";
          return `<span class="${`slack-mention ${pill.state}`.trim()}" data-slack-mention="${escapeHtml(token.raw)}"${title}>@${escapeHtml(pill.label)}</span>`;
        },
      },
    ],
  });
  onPeople(() => {
    for (const element of document.querySelectorAll<HTMLElement>("span[data-slack-mention]")) {
      const mention = mentionOf(element.dataset.slackMention ?? "");
      if (mention) paintPill(element, mention);
    }
  });
}
