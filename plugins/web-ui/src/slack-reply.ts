import { LitElement, html, nothing } from "lit";
import { api, withBase, type CoreAttachment } from "./core-bridge";
import { embeddedComposer } from "./embedded-composer";
import type { MentionRow } from "./emoji-completion";
import { reportHandledError } from "./browser-errors.ts";
import "./slack-account";
import { onSpeakerAvatars, speakerAvatar } from "./speaker-avatars";
import { avatarTpl } from "./ui";
import "./slack-reply.css";
import { toSlackWire } from "./mention-wire";
import type { SlackSending } from "./slack-outbox";

const FOCUS_REFRESH_MS = 60_000;
const KNOWN_KEY = "qm-slack-reply-known";
type Known = { user: string; connected: boolean; label: string };
type Participant = { name: string; id: string };
const SLACK_USER = /^[UW][A-Z0-9]{6,}$/;
const BROADCASTS = ["here", "channel"];

function remembered(user: string): Known | null {
  try {
    const known = JSON.parse(localStorage.getItem(KNOWN_KEY) ?? "null") as Known | null;
    return known?.user === user ? known : null;
  } catch {
    return null;
  }
}
function remember(known: Known): void {
  try {
    localStorage.setItem(KNOWN_KEY, JSON.stringify(known));
  } catch {
    return;
  }
}

export class SlackReply extends LitElement {
  static properties = {
    sessionId: {},
    user: {},
    participants: { attribute: false },
    connected: { state: true },
    linkAvailable: { state: true },
    error: { state: true },
    text: { state: true },
    label: { state: true },
  };
  sessionId = "";
  user = "";
  participants: Participant[] = [];
  private wires = new Map<string, string>();
  private connected: boolean | null = null;
  private linkAvailable = false;
  private checkedAt = 0;
  private error = "";
  private text = "";
  private label = "";
  private stopAvatars: (() => void) | null = null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("focus", this.refreshOnFocus);
    this.stopAvatars = onSpeakerAvatars(() => this.requestUpdate());
    this.requestUpdate();
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("focus", this.refreshOnFocus);
    this.stopAvatars?.();
    this.stopAvatars = null;
  }
  protected willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("user") || this.connected !== null) return;
    const known = remembered(this.user);
    if (known) {
      this.connected = known.connected;
      this.linkAvailable = !known.connected;
      this.label = known.label;
    }
  }
  protected firstUpdated(): void {
    void this.check(false);
  }
  private refreshOnFocus = (): void => {
    if (Date.now() - this.checkedAt >= FOCUS_REFRESH_MS) void this.check(false);
  };
  private refresh = (): Promise<void> => this.check(true);
  private async check(explicit: boolean): Promise<void> {
    this.checkedAt = Date.now();
    try {
      const response = await this.request("reply-status");
      const result = await response.json();
      if (response.ok) {
        this.connected = result.connected === true;
        this.linkAvailable = true;
        this.label = result.user ?? "yourself";
        this.error = "";
        remember({ user: this.user, connected: this.connected, label: this.label });
      } else if (result.error === "composio_unavailable") {
        this.connected = false;
        this.linkAvailable = false;
        this.error = "Slack linking isn’t configured for your account on this deployment.";
      } else if (explicit) this.error = result.message ?? "Could not check your Slack connection.";
    } catch (error) {
      reportHandledError("web:slack_reply_status", error);
      if (explicit) this.error = "Could not check your Slack connection.";
    }
  }
  private request(
    action: string,
    message?: { text: string; clientMessageId: string; attachments?: CoreAttachment[] },
  ): Promise<Response> {
    return fetch(withBase(`/api/composio/slack/${action}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, ...message }),
      signal: AbortSignal.timeout(60_000),
    });
  }
  private mentions = async (query: string): Promise<MentionRow[]> => {
    const q = query.toLowerCase();
    const rows = new Map<string, MentionRow & { wire: string }>();
    const add = (label: string, wire: string, key: string, avatar?: string) => {
      if (!label.toLowerCase().includes(q) || rows.has(label)) return;
      const lead = BROADCASTS.includes(label) ? "📣" : avatarTpl({ key, name: label, avatarUrl: avatar });
      rows.set(label, { key, label, lead, wire });
    };
    for (const p of this.participants) if (SLACK_USER.test(p.id)) add(p.name, `<@${p.id}>`, p.id, speakerAvatar(p.id));
    if (q)
      try {
        const found = await api<{ matches?: Array<{ displayName: string; slackId?: string; avatarUrl?: string }> }>(
          `/api/directory/resolve?q=${encodeURIComponent(q)}`,
        );
        for (const m of found.matches ?? [])
          if (m.slackId) add(m.displayName, `<@${m.slackId}>`, m.slackId, m.avatarUrl);
      } catch (error) {
        reportHandledError("web:slack_mention_search", error);
      }
    for (const b of BROADCASTS) add(b, `<!${b}>`, b);
    for (const row of rows.values()) this.wires.set(row.label, row.wire);
    return [...rows.values()];
  };

  private submit =
    () =>
    async (draft: string, options: { attachments?: CoreAttachment[] }): Promise<void> => {
      const text = toSlackWire(draft, this.wires);
      const id = crypto.randomUUID();
      this.error = "";
      const sending: SlackSending = {
        id,
        sessionId: this.sessionId,
        text: text || options.attachments?.map((a) => a.name).join(", ") || "",
        speaker: this.label || this.user,
        speakerId: this.user,
      };
      this.dispatchEvent(new CustomEvent("slack-sending", { bubbles: true, detail: sending }));
      let message = "The send outcome is unknown. Check Slack before trying again.";
      try {
        const response = await this.request("reply", {
          text,
          clientMessageId: id,
          ...(options.attachments ? { attachments: options.attachments } : {}),
        });
        const result = await response.json();
        if (response.ok && result.sent) {
          this.dispatchEvent(new CustomEvent("slack-sent", { bubbles: true, detail: { id, ts: result.ts } }));
          return;
        }
        if (result.connected === false) {
          this.connected = false;
          this.linkAvailable = true;
          remember({ user: this.user, connected: false, label: this.label });
        }
        message = result.message ?? "Could not send your Slack message.";
      } catch (error) {
        reportHandledError("web:slack_reply_send", error);
      }
      this.dispatchEvent(new CustomEvent("slack-failed", { bubbles: true, detail: { id } }));
      throw new Error(message);
    };

  protected render() {
    if (this.connected !== false)
      return html`<div class="slack-reply-box">
        ${embeddedComposer(`slack-reply:${this.sessionId}`, {
          prepareSubmit: this.submit,
          slack: {
            label: this.label || "yourself",
            mentions: this.mentions,
            avatar: () =>
              avatarTpl({ key: this.user, name: this.label || this.user, avatarUrl: speakerAvatar(this.user) }),
          },
        })}
        ${this.error ? html`<div class="composer-error" role="alert">${this.error}</div>` : nothing}
      </div>`;
    return html`<div class="slack-reply-box">
      ${this.linkAvailable ? html`<qm-slack-account .user=${this.user} .reply=${true} @slack-linked=${this.refresh}></qm-slack-account>` : nothing}
      ${this.error ? html`<p class="slack-account-error" role="alert">${this.error} <button class="btn" @click=${this.refresh}>Check connection</button></p>` : nothing}
    </div>`;
  }
}
if (!customElements.get("qm-slack-reply")) customElements.define("qm-slack-reply", SlackReply);
