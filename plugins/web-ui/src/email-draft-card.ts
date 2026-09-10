import { html, nothing, render, type TemplateResult } from "lit";
import { CheckCheck, Eye, PenLine, Send, Undo2 } from "lucide";
import { api, ApiError } from "./core-bridge";
import type { EmailDraftRef } from "./email-draft";
import { toInboxItem, type InboxDraft, type InboxItem, type LedgerItem } from "./inbox";
import { appState } from "./shell-state";
import { icon, initials, relTime } from "./ui";

interface DraftState {
  ref: EmailDraftRef;
  host: HTMLElement;
  item: InboxItem | null;
  loading: boolean;
  mode: "preview" | "edit";
  edit: (InboxDraft & { basedOnAt?: number }) | null;
  busy: boolean;
  notice: string | null;
}

const states = new Map<string, DraftState>();

function itemPath(ref: EmailDraftRef): string {
  return `/api/loops/${encodeURIComponent(ref.loopId)}/items/${encodeURIComponent(ref.itemId)}`;
}

export function refreshEmailDraft(itemId: string): void {
  const state = states.get(itemId);
  if (state && !state.busy) void load(state);
}

export function emailDraftCard(ref: EmailDraftRef): HTMLElement {
  let state = states.get(ref.itemId);
  if (!state) {
    const host = document.createElement("section");
    host.className = "email-draft";
    state = { ref, host, item: null, loading: false, mode: "preview", edit: null, busy: false, notice: null };
    states.set(ref.itemId, state);
    void load(state);
  }
  draw(state);
  return state.host;
}

async function load(state: DraftState): Promise<void> {
  if (state.loading) return;
  state.loading = true;
  draw(state);
  try {
    const { item } = await api<{ item: LedgerItem }>(itemPath(state.ref));
    state.item = toInboxItem(item);
    if (state.edit && state.item.draftAt !== undefined) state.edit.basedOnAt = state.item.draftAt;
  } catch (e) {
    state.notice = `Couldn't load the draft: ${e instanceof Error ? e.message : e}`;
  } finally {
    state.loading = false;
    draw(state);
  }
}

function draft(state: DraftState): InboxDraft {
  if (state.edit) {
    const { basedOnAt: _basedOnAt, ...edited } = state.edit;
    return edited;
  }
  return state.item?.draft ?? { body: "" };
}

function sameDraft(a: InboxDraft | undefined, b: InboxDraft): boolean {
  return (
    a !== undefined &&
    a.body === b.body &&
    (a.subject ?? "") === (b.subject ?? "") &&
    (a.to ?? []).join(",") === (b.to ?? []).join(",") &&
    (a.cc ?? []).join(",") === (b.cc ?? []).join(",")
  );
}

function splitAddresses(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function patchDraft(state: DraftState, patch: Partial<InboxDraft>): void {
  const basedOnAt = state.edit?.basedOnAt ?? state.item?.draftAt;
  state.edit = { ...draft(state), ...patch, ...(basedOnAt !== undefined ? { basedOnAt } : {}) };
  state.notice = null;
  draw(state);
}

async function postAction(state: DraftState, kind: string, args?: Record<string, unknown>): Promise<void> {
  const { item } = await api<{ item: LedgerItem }>(`${itemPath(state.ref)}/action`, {
    method: "POST",
    body: JSON.stringify({ kind, ...(args ? { args } : {}) }),
  });
  state.item = toInboxItem(item);
}

function proposalArgs(state: DraftState): Record<string, unknown> {
  const basedOnAt = state.edit?.basedOnAt ?? state.item?.draftAt;
  return { proposal: draft(state), ...(basedOnAt !== undefined ? { expectedProposalAt: basedOnAt } : {}) };
}

function isDraftConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && /draft changed/i.test(e.message);
}

async function withBusy(state: DraftState, work: () => Promise<void>, failure: string): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  state.notice = null;
  draw(state);
  try {
    await work();
  } catch (e) {
    if (isDraftConflict(e)) {
      await load(state);
      state.notice = "The agent changed this draft while you were looking. Review the new version, then try again.";
    } else {
      state.notice = `${failure}: ${e instanceof Error ? e.message : e}`;
    }
  } finally {
    state.busy = false;
    draw(state);
  }
}

async function persist(state: DraftState): Promise<void> {
  if (!state.edit || !state.item) return;
  if (sameDraft(state.item.draft, draft(state))) {
    state.edit = null;
    return;
  }
  await withBusy(
    state,
    async () => {
      await postAction(state, "edit", proposalArgs(state));
      state.edit = null;
    },
    "Couldn't save the draft",
  );
}

function setMode(state: DraftState, mode: DraftState["mode"]): void {
  if (state.mode === mode) return;
  state.mode = mode;
  if (mode === "preview") void persist(state);
  draw(state);
}

function send(state: DraftState): Promise<void> {
  const current = draft(state);
  if (!current.body.trim()) {
    state.notice = "Nothing to send. The draft is empty.";
    draw(state);
    return Promise.resolve();
  }
  if (!current.to?.length) {
    state.notice = "Add at least one recipient before sending.";
    draw(state);
    return Promise.resolve();
  }
  return withBusy(
    state,
    async () => {
      await postAction(state, "send", proposalArgs(state));
      state.edit = null;
      state.mode = "preview";
    },
    "Send failed",
  );
}

function draw(state: DraftState): void {
  render(cardTpl(state), state.host);
}

function paragraphs(body: string): TemplateResult[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => html`<p>${p}</p>`);
}

function recipientsLine(current: InboxDraft): string {
  const to = current.to?.length ? `to ${current.to.join(", ")}` : "no recipient yet";
  return current.cc?.length ? `${to} · cc ${current.cc.join(", ")}` : to;
}

function cardTpl(state: DraftState): TemplateResult {
  const item = state.item;
  if (!item) {
    return html`<div class="email-draft-meta">
      ${state.notice ?? (state.loading ? "Loading the email draft…" : "The email draft is not available.")}
    </div>`;
  }
  if (item.status === "sent") return receiptTpl(state, item);
  if (item.status !== "open") return dismissedTpl(state, item);
  const current = draft(state);
  const edited = state.edit !== null || item.draftEdited === true;
  return html`
    <div class="email-draft-meta">
      <span class="email-draft-pill ${edited ? "edited" : ""}">
        ${edited ? "Edited" : html`${icon(CheckCheck, 12)}Ready to send`}
      </span>
      <span class="email-draft-recipients">${recipientsLine(current)}</span>
      <span class="email-draft-seg" role="tablist" aria-label="Draft view">
        <button
          type="button"
          class=${state.mode === "preview" ? "on" : ""}
          @click=${() => setMode(state, "preview")}
        >
          ${icon(Eye, 12)}Preview
        </button>
        <button type="button" class=${state.mode === "edit" ? "on" : ""} @click=${() => setMode(state, "edit")}>
          ${icon(PenLine, 12)}Edit
        </button>
      </span>
    </div>
    <div class="email-draft-paper">${state.mode === "edit" ? editTpl(state, current) : previewTpl(current)}</div>
    <div class="email-draft-foot">
      <button
        type="button"
        class="approval-btn"
        ?disabled=${state.busy}
        @click=${() => void withBusy(state, () => postAction(state, "dismiss"), "Couldn't discard the draft")}
      >
        Discard
      </button>
      <button type="button" class="approval-btn primary email-draft-send" ?disabled=${state.busy} @click=${() => void send(state)}>
        ${icon(Send, 13)}${state.busy ? "Working…" : "Send"}
      </button>
    </div>
    ${state.notice ? html`<div class="email-draft-notice">${state.notice}</div>` : nothing}
  `;
}

function signedInUser(): string {
  return appState.me?.user ?? "";
}

function previewTpl(current: InboxDraft): TemplateResult {
  const from = signedInUser();
  return html`
    <div class="email-draft-from">
      <span class="email-draft-avatar">${initials(from)}</span>
      <span class="email-draft-who"><b>${from}</b><span>${recipientsLine(current)}</span></span>
    </div>
    <h3 class="email-draft-subject">${current.subject?.trim() || "(no subject)"}</h3>
    <div class="email-draft-rule"></div>
    <div class="email-draft-body">${paragraphs(current.body)}</div>
  `;
}

function editTpl(state: DraftState, current: InboxDraft): TemplateResult {
  const field = (label: string, value: string, apply: (raw: string) => Partial<InboxDraft>): TemplateResult =>
    html`<label class="email-draft-field">
      <span>${label}</span>
      <input
        type="text"
        .value=${value}
        @input=${(e: Event) => patchDraft(state, apply((e.currentTarget as HTMLInputElement).value))}
        @blur=${() => void persist(state)}
      />
    </label>`;
  return html`
    <div class="email-draft-fields">
      <div class="email-draft-field"><span>From</span><span class="email-draft-static">${signedInUser()}</span></div>
      ${field("To", (current.to ?? []).join(", "), (raw) => ({ to: splitAddresses(raw) }))}
      ${field("Cc", (current.cc ?? []).join(", "), (raw) => ({ cc: splitAddresses(raw) }))}
      ${field("Subject", current.subject ?? "", (raw) => ({ subject: raw }))}
    </div>
    <textarea
      class="email-draft-textarea"
      .value=${current.body}
      @input=${(e: Event) => patchDraft(state, { body: (e.currentTarget as HTMLTextAreaElement).value })}
      @blur=${() => void persist(state)}
    ></textarea>
  `;
}

function receiptTpl(state: DraftState, item: InboxItem): TemplateResult {
  const sent = item.draft ?? draft(state);
  return html`<div class="email-draft-receipt">
    <span class="ok">${icon(CheckCheck, 15)}</span>
    <span>Sent <b>${sent.subject?.trim() || "(no subject)"}</b> to ${(sent.to ?? []).join(", ")}</span>
    <span class="meta">${sent.cc?.length ? `cc ${sent.cc.join(", ")} · ` : ""}${item.sentAt ? relTime(item.sentAt) : ""}</span>
  </div>`;
}

function dismissedTpl(state: DraftState, item: InboxItem): TemplateResult {
  return html`<div class="email-draft-receipt">
    <span class="meta">Email draft discarded${item.dismissedAt ? ` ${relTime(item.dismissedAt)}` : ""}</span>
    <button
      type="button"
      class="approval-btn"
      ?disabled=${state.busy}
      @click=${() => void withBusy(state, () => postAction(state, "reopen"), "Couldn't reopen the draft")}
    >
      ${icon(Undo2, 13)}Reopen
    </button>
    ${state.notice ? html`<span class="email-draft-notice">${state.notice}</span>` : nothing}
  </div>`;
}
