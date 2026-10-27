import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import { ArrowUpRight, CheckCheck, Undo2, X } from "lucide";
import { embeddedComposer } from "./embedded-composer";
import { charForName } from "./emoji-picker";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { appState } from "./shell-state";
import { openSession, sessionsState } from "./sessions";
import { brandName, avatarTpl, relTime, workingWave } from "./ui";
import { icon } from "./icons";
import { assistantSidebar, threadMessage } from "./assistant-sidebar";
import { type InboxDraft, type InboxItem, redrawInbox } from "./inbox-model";
import { itemPath } from "./inbox-feed";
import {
  draftConflicts,
  acting,
  chatting,
  inboxItemById,
  draftSubject,
  effectiveDraft,
  editDraft,
  addressHeaderList,
  persistDraft,
  setItemStatus,
  askAgent,
} from "./inbox-actions";
import { fmtClock, participantName, participantKey, slackTextTpl } from "./inbox-people";

function subjectTpl(item: InboxItem): TemplateResult {
  return html`<section class="inbox-subject" aria-label="Item">
    <ul>
      <li>
        <span class="inbox-subject-key">${item.source === "generic" ? item.sourceKey : item.from}</span>
        <span class="inbox-subject-text">${item.snippet || item.title}</span>
        <span class="inbox-subject-at" title=${fmtClock(item.receivedAt)}>${relTime(item.receivedAt)}</span>
        ${item.externalUrl ? html`<a class="inbox-external-link" href=${item.externalUrl} target="_blank" rel="noopener noreferrer" aria-label="Open source">${icon(ArrowUpRight, 12)}</a>` : nothing}
      </li>
    </ul>
  </section>`;
}

export function reviewTpl(item: InboxItem, withChat = true): TemplateResult {
  if (!item.detailLoaded) return html`<div class="empty compact">Loading review…</div>`;
  return html`<div class="inbox-generic-review">
    ${subjectTpl(item)}
    ${item.proposalData ? html`<pre class="inbox-proposal-data">${JSON.stringify(item.proposalData, null, 2)}</pre>` : nothing}
    ${withChat ? chatTpl(item) : nothing}
  </div>`;
}

function openDraftSession(e: MouseEvent, sessionId: string): void {
  e.preventDefault();
  const session = sessionsState.list.find((s) => s.id === sessionId);
  if (session) void openSession(session);
  else window.location.assign(deepLinkPath(UI_BASE, "chats", sessionId));
}

function itemImagesTpl(item: InboxItem, urls: string[] | undefined, ctxIndex: number): TemplateResult | typeof nothing {
  if (!urls?.length) return nothing;
  const base = `${UI_BASE}${itemPath(item.cronId, item.id, "/image")}`;
  return html`<div class="inbox-images">
    ${urls.map((_u, j) => {
      const src = `${base}?ctx=${ctxIndex}&i=${j}`;
      return html`<a href=${src} target="_blank" rel="noreferrer noopener"
        ><img class="inbox-image" src=${src} loading="lazy" alt="attached image"
      /></a>`;
    })}
  </div>`;
}

const CONTEXT_TAIL = 6;

const CONTEXT_PAGE = 20;

const revealedContext = new Map<string, number>();

function revealEarlier(item: InboxItem, marker: Element): void {
  const scroller = marker.closest<HTMLElement>(".inbox-scroll");
  const before = scroller ? scroller.scrollHeight - scroller.scrollTop : 0;
  revealedContext.set(item.id, (revealedContext.get(item.id) ?? 0) + CONTEXT_PAGE);
  redrawInbox();
  if (scroller) scroller.scrollTop = scroller.scrollHeight - before;
}

const watchedEarlier = new WeakSet<Element>();

function watchEarlier(item: InboxItem, el: Element | undefined): void {
  const scroller = el?.closest<HTMLElement>(".inbox-scroll");
  if (!el || !scroller || watchedEarlier.has(el) || typeof IntersectionObserver === "undefined") return;
  watchedEarlier.add(el);
  let userScrolled = false;
  const markScrolled = (): void => void (userScrolled = true);
  scroller.addEventListener("wheel", markScrolled, { passive: true });
  scroller.addEventListener("touchmove", markScrolled, { passive: true });
  const observer = new IntersectionObserver((entries) => {
    if (!el.isConnected) return observer.disconnect();
    if (!userScrolled || !entries.some((entry) => entry.isIntersecting)) return;
    revealEarlier(item, el);
  });
  observer.observe(el);
}

export function contextTpl(item: InboxItem): TemplateResult | typeof nothing {
  const context = (item.context ?? []).map((message, index) => ({ ...message, imageIndex: index }));
  const rows = item.sourceContextFetched
    ? context
    : [
        ...context.filter((m) => !item.slack || m.nearby === true),
        {
          author: item.from,
          authorId: item.slack?.userId ?? (item.source === "slack" ? item.participants?.[0]?.key : undefined),
          at: item.receivedAt,
          text: item.snippet,
          images: item.images,
          imageIndex: -1,
          reply: false,
          nearby: false,
        },
      ];
  const hidden = Math.max(0, rows.length - CONTEXT_TAIL - (revealedContext.get(item.id) ?? 0));
  return html`<div class="inbox-context">
    ${
      hidden
        ? html`<button
            class="inbox-source-notice inbox-earlier"
            ${ref((el) => watchEarlier(item, el))}
            @click=${(event: MouseEvent) => revealEarlier(item, event.currentTarget as Element)}
          >
            ${hidden === 1 ? "1 earlier message" : `${hidden} earlier messages`}
          </button>`
        : nothing
    }
    ${item.sourceRefreshError ? html`<div class="inbox-source-notice" role="status">${item.sourceRefreshError}</div>` : nothing}
    ${item.sourceContextPartial ? html`<div class="inbox-source-notice">Showing part of this conversation. Open in Slack for the full history.</div>` : nothing}
    ${rows.slice(hidden).map((m) => {
      const participant = item.source === "slack" ? item.participants?.find((p) => p.key === m.authorId) : undefined;
      const author = participant?.name ?? m.author;
      const name = participantName(author) || author;
      const avatarUrl = participant ? participant.avatarUrl : m.avatarUrl;
      return html`
        <div class="inbox-context-msg ${m.reply ? "inbox-thread-reply" : ""} ${m.nearby ? "inbox-nearby-context" : ""}">
          ${avatarTpl({ key: m.authorId ?? participantKey(m.author), name, avatarUrl: item.source === "slack" ? avatarUrl : undefined })}
          <div class="inbox-context-body">
            <div class="inbox-context-head">
              <span class="inbox-context-author">${name}</span>
              ${m.nearby ? html`<span class="inbox-context-at">Nearby in channel</span>` : nothing}
              ${m.at ? html`<span class="inbox-context-at">${relTime(m.at)}</span>` : nothing}
            </div>
            <div class="inbox-context-text">${slackTextTpl(item, m.text)}</div>
            ${itemImagesTpl(item, m.images, m.imageIndex)}
          </div>
        </div>
      `;
    })}
  </div>`;
}

export function chatTpl(item: InboxItem, compact = false): TemplateResult {
  const busy = chatting.has(item.id);
  const submit = (event: MouseEvent, instruction: string): void => {
    const composer = (event.currentTarget as HTMLElement).closest(".inbox-chat")?.querySelector(".embedded-composer");
    composer?.dispatchEvent(new CustomEvent("composer-submit", { detail: instruction }));
  };
  return assistantSidebar({
    context: {
      kind: "thread",
      source: item.source,
      hasDraft: Boolean(item.draft),
      sent: Boolean(item.sentChat),
      resolved: Boolean(item.probablyResolved),
    },
    messages: html`${item.thread.map(threadMessage)}`,
    busy,
    status: busy ? html`<div class="inbox-chat-working">${workingWave()}<span>Thinking…</span></div>` : nothing,
    showPrompts: item.status === "open" && item.thread.length === 0,
    send:
      item.status === "open" && item.source !== "generic" && (!item.sentChat || item.draft)
        ? { disabled: busy || acting.has(item.id), run: (event) => submit(event, "Send it") }
        : undefined,
    onPrompt: (prompt, event) => submit(event, prompt),
    composer: embeddedComposer(
      `inbox:${appState.me?.user ?? "anon"}:${item.cronId}:${item.id}`,
      {
        placeholder: `Ask ${brandName()} for something`,
        prepareSubmit: () => {
          const snapshot = {
            draft: effectiveDraft(inboxItemById(item.id) ?? item),
            conflictRevision: draftConflicts.get(item.id) ?? 0,
          };
          return async (text, options) => {
            if (!(await askAgent(item, text, options, snapshot)))
              throw new Error("Could not complete the request. Your message has been kept.");
          };
        },
      },
      compact,
    ),
  });
}

export function draftMessageTpl(item: InboxItem): TemplateResult | typeof nothing {
  if (item.status !== "open" || item.source === "generic" || (item.sentChat && !item.draft)) return nothing;
  const busy = chatting.has(item.id);
  const draft = effectiveDraft(item);
  const gmail = item.source === "gmail";
  const peek = [(draft.to ?? []).join(", "), draftSubject(item, draft)].filter(Boolean).join(" · ");
  const showCc = gmail && ((draft.cc?.length ?? 0) > 0 || (item.gmail?.cc?.length ?? 0) > 0);
  const field = (label: string, value: string, patch: (value: string) => Partial<InboxDraft>, placeholder?: string) =>
    html`<label class="inbox-field">
      <span>${label}</span>
      <input
        type="text"
        ?disabled=${busy}
        .value=${live(value)}
        placeholder=${placeholder ?? nothing}
        @input=${(e: Event) => editDraft(item, patch((e.currentTarget as HTMLInputElement).value))}
        @blur=${() => void persistDraft(item)}
      />
    </label>`;
  return html`
    <div class="inbox-draft ${gmail ? "email" : "slack"}">
      <div class="inbox-draft-head">
        <span class="inbox-draft-label">Draft reply</span>
        ${
          item.draftSessionId
            ? html`<a
                class="inbox-session-link"
                href=${deepLinkPath(UI_BASE, "chats", item.draftSessionId)}
                title="See how the agent arrived at this draft"
                @click=${(e: MouseEvent) => openDraftSession(e, item.draftSessionId!)}
              >
                ${icon(ArrowUpRight, 12)}<span>Open agent session</span>
              </a>`
            : nothing
        }
        ${
          item.externalUrl
            ? html`<a class="inbox-external-link" href=${item.externalUrl} target="_blank" rel="noreferrer noopener">
                ${icon(ArrowUpRight, 12)}<span>Open in ${gmail ? "Gmail" : "Slack"}</span>
              </a>`
            : nothing
        }
      </div>
      ${
        gmail
          ? html`
              <details class="inbox-draft-headers">
                <summary><span class="inbox-draft-headers-peek">${peek || "Recipients and subject"}</span></summary>
                <div class="inbox-draft-headers-fields">
                  ${field("To", (draft.to ?? []).join(", "), (v) => ({ to: addressHeaderList(v) }), "who@example.com")}
                  ${showCc ? field("Cc", (draft.cc ?? []).join(", "), (v) => ({ cc: addressHeaderList(v) })) : nothing}
                  ${field("Subject", draftSubject(item, draft), (subject) => ({ subject }))}
                </div>
              </details>
            `
          : nothing
      }
      <div class="inbox-draft-body-wrap">
        <textarea
          class="inbox-draft-body"
          aria-label="Draft reply"
          ?disabled=${busy}
          rows=${gmail ? 7 : 3}
          placeholder=${item.draft ? "" : "No draft yet. The next sync writes one, or write your own."}
          .value=${live(draft.body)}
          @input=${(e: Event) => editDraft(item, { body: (e.currentTarget as HTMLTextAreaElement).value })}
          @blur=${() => void persistDraft(item)}
        ></textarea>
      </div>
      ${
        !gmail && item.reactions?.length
          ? html`<div class="inbox-reactions">${item.reactions.map(reactionChipTpl)}</div>`
          : nothing
      }
    </div>
  `;
}

function reactionChipTpl(name: string): TemplateResult {
  return html`<span class="inbox-reaction-chip" title=${`:${name}:`}>${charForName(name) ?? `:${name}:`}</span>`;
}

function handledStateLabel(item: InboxItem): string {
  if (item.status === "sent") return "Sent";
  if (item.status === "replied") return "Replied";
  return item.noReplyNeeded ? "No reply needed" : "Dismissed";
}

export function itemSideMark(item: InboxItem, handled: boolean): TemplateResult | typeof nothing {
  if (handled) return html`<span class="inbox-item-state">${handledStateLabel(item)}</span>`;
  if (item.draft)
    return html`<span class="inbox-item-drafted" title="A reply is drafted and ready">${icon(CheckCheck, 12)}</span>`;
  return nothing;
}

function reopenButtonTpl(item: InboxItem): TemplateResult {
  return html`<button class="btn inbox-reopen" type="button" @click=${() => void setItemStatus(item, "open")}>
    ${icon(Undo2, 13)}<span>Reopen</span>
  </button>`;
}

export function handledNoteTpl(item: InboxItem): TemplateResult {
  if (item.status === "sent") {
    return html`<div class="inbox-handled-note">
      ${icon(CheckCheck, 13)}<span>Reply sent ${item.sentAt ? relTime(item.sentAt) : ""}</span>
    </div>`;
  }
  if (item.status === "replied") {
    const where = item.source === "slack" ? "Slack" : "Gmail";
    return html`<div class="inbox-handled-note inbox-replied-note">
      <div class="inbox-handled-line">
        ${icon(CheckCheck, 13)}<span>You replied in ${where} ${item.repliedAt ? relTime(item.repliedAt) : ""}</span>
        ${reopenButtonTpl(item)}
      </div>
      ${item.externalReplyText ? html`<div class="inbox-replied-text">${slackTextTpl(item, item.externalReplyText)}</div>` : nothing}
    </div>`;
  }
  const label = `${handledStateLabel(item)} ${item.dismissedAt ? relTime(item.dismissedAt) : ""}`;
  if (item.noReplyNeeded?.reason)
    return html`<div class="inbox-handled-note inbox-replied-note">
      <div class="inbox-handled-line">${icon(X, 13)}<span>${label}</span> ${reopenButtonTpl(item)}</div>
      <div class="inbox-replied-text">${item.noReplyNeeded.reason}</div>
    </div>`;
  return html`<div class="inbox-handled-note">
    ${icon(X, 13)}<span>${label}</span>
    ${reopenButtonTpl(item)}
  </div>`;
}

export function dismissItemTpl(item: InboxItem): TemplateResult | typeof nothing {
  if (item.status !== "open") return nothing;
  return html`<button
    class="inbox-dismiss"
    type="button"
    ?disabled=${chatting.has(item.id) || acting.has(item.id)}
    @click=${() => void setItemStatus(item, "dismissed")}
  >
    Dismiss
  </button>`;
}
