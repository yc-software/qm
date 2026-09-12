import { html, nothing, render, type TemplateResult } from "lit";
import { CheckCheck, Paperclip } from "lucide";
import { api, ApiError, fileContentUrl } from "./core-bridge";
import type { EmailDraftRef } from "./email-draft";
import { toInboxItem, type InboxItem, type LedgerItem } from "./inbox";
import { formatBytes, icon, relTime } from "./ui";

export class EmailDraftCard extends HTMLElement {
  ref!: EmailDraftRef;
  private item: InboxItem | null = null;
  private status: "loading" | "ready" | "gone" | "hidden" = "loading";
  private busy = false;
  private notice: string | null = null;

  connectedCallback(): void {
    this.classList.add("email-draft");
    void this.load();
  }

  private path(): string {
    return `/api/loops/${encodeURIComponent(this.ref.loopId)}/items/${encodeURIComponent(this.ref.itemId)}`;
  }

  private async load(): Promise<void> {
    try {
      const { item } = await api<{ item: LedgerItem }>(this.path());
      this.item = toInboxItem(item);
      this.status = "ready";
    } catch (e) {
      const code = e instanceof ApiError ? e.status : 0;
      if (code === 404) this.status = "gone";
      else if (code === 403) this.status = "hidden";
      else {
        this.status = "ready";
        this.notice = `Couldn't load the draft: ${e instanceof Error ? e.message : e}`;
      }
    }
    this.draw();
  }

  private async act(kind: "send" | "dismiss"): Promise<void> {
    this.busy = true;
    this.notice = null;
    this.draw();
    try {
      const init = { method: "POST", body: JSON.stringify({ kind }) };
      const { item } = await api<{ item: LedgerItem }>(`${this.path()}/action`, init);
      this.item = toInboxItem(item);
    } catch (e) {
      this.notice = `${kind === "send" ? "Send failed" : "Couldn't discard"}: ${e instanceof Error ? e.message : e}`;
      if (e instanceof ApiError && e.status === 409) await this.load();
    }
    this.busy = false;
    this.draw();
  }

  private draw(): void {
    render(this.tpl(), this);
  }

  private tpl(): TemplateResult | typeof nothing {
    if (this.status === "hidden") return nothing;
    if (this.status === "loading") return html`<div class="email-draft-meta">Loading the email draft…</div>`;
    const item = this.item;
    if (!item)
      return html`<div class="email-draft-meta">${this.notice ?? "This email draft is no longer available."}</div>`;
    const draft = item.draft ?? { body: "" };
    const to = (draft.to ?? []).join(", ");
    if (item.status === "sent") {
      return html`<div class="email-draft-meta">
        ${icon(CheckCheck, 14)}<span>Sent to ${to}${item.sentAt ? ` · ${relTime(item.sentAt)}` : ""}</span>
      </div>`;
    }
    if (item.status !== "open") return html`<div class="email-draft-meta">Email draft discarded</div>`;
    const files = draft.attachments ?? [];
    return html`
      <div class="email-draft-head">
        <span>To</span><span>${to}</span>
        ${draft.cc?.length ? html`<span>Cc</span><span>${draft.cc.join(", ")}</span>` : nothing}
        <span>Subject</span><span>${draft.subject?.trim() || "(no subject)"}</span>
      </div>
      <div class="email-draft-body">${draft.body}</div>
      ${
        files.length
          ? html`<div class="email-draft-attachments">
              ${files.map(
              (f) =>
                html`<a class="file-chip" href=${fileContentUrl(f.artifactId, f.name)} target="_blank" rel="noreferrer">
                  ${icon(Paperclip, 13)}<span>${f.name}</span><small>${formatBytes(f.sizeBytes)}</small>
                </a>`,
            )}
            </div>`
          : nothing
      }
      <div class="approval-actions">
        <button type="button" class="approval-btn primary" ?disabled=${this.busy} @click=${() => void this.act("send")}>
          Send
        </button>
        <button type="button" class="approval-btn" ?disabled=${this.busy} @click=${() => void this.act("dismiss")}>
          Discard
        </button>
      </div>
      ${this.notice ? html`<div class="email-draft-notice">${this.notice}</div>` : nothing}
    `;
  }
}

customElements.define("email-draft-card", EmailDraftCard);
