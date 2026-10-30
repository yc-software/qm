import { composerInput, resizeComposerInput } from "./composer-input";
import { ArrowUp } from "lucide";
import { icon } from "./icons";
import { tip } from "./tooltip";
import { LitElement, html, nothing } from "lit";
import { webFetch, withBase } from "./core-bridge";
import "./slack-account";
import "./slack-reply.css";

export class SlackReply extends LitElement {
  static properties = {
    sessionId: {},
    user: {},
    connected: { state: true },
    linkAvailable: { state: true },
    loading: { state: true },
    sending: { state: true },
    error: { state: true },
    text: { state: true },
    label: { state: true },
  };
  sessionId = "";
  user = "";
  private connected = false;
  private linkAvailable = false;
  private loading = true;
  private sending = false;
  private error = "";
  private text = "";
  private label = "";
  private inputObserver: ResizeObserver | null = null;
  private observedInput: HTMLTextAreaElement | null = null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }
  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("focus", this.refresh);
    this.requestUpdate();
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("focus", this.refresh);
    this.inputObserver?.disconnect();
    this.inputObserver = null;
    this.observedInput = null;
  }
  protected updated(): void {
    const input = this.querySelector<HTMLTextAreaElement>(".composer-input");
    if (input !== this.observedInput) {
      this.inputObserver?.disconnect();
      this.inputObserver = null;
      this.observedInput = input;
    }
    if (!input) return;
    resizeComposerInput(input);
    if (!this.inputObserver && typeof ResizeObserver !== "undefined") {
      let width = input.clientWidth;
      this.inputObserver = new ResizeObserver(() => {
        if (width === input.clientWidth) return;
        width = input.clientWidth;
        resizeComposerInput(input);
      });
      this.inputObserver.observe(input);
    }
  }
  protected firstUpdated(): void {
    void this.refresh();
  }
  private refresh = async (): Promise<void> => {
    try {
      const response = await this.request("reply-status");
      const result = await response.json();
      this.connected = response.ok && result.connected === true;
      this.linkAvailable = response.ok;
      this.label = result.user ?? "yourself";
      this.error = response.ok ? "" : (result.message ?? "Could not check your Slack connection.");
      if (!response.ok && result.error === "composio_unavailable")
        this.error = "Slack linking isn’t configured for your account on this deployment.";
    } catch {
      this.connected = false;
      this.linkAvailable = false;
      this.error = "Could not check your Slack connection.";
    } finally {
      this.loading = false;
    }
  };
  private request(action: string, message?: { text: string; clientMessageId: string }): Promise<Response> {
    return webFetch(withBase(`/api/composio/slack/${action}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, ...message }),
      signal: AbortSignal.timeout(60_000),
    });
  }
  private async send(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.connected || this.sending || !this.text.trim()) return;
    this.sending = true;
    this.error = "";
    try {
      const response = await this.request("reply", { text: this.text, clientMessageId: crypto.randomUUID() });
      const result = await response.json();
      if (!response.ok || !result.sent) {
        if (result.connected === false) this.connected = false;
        this.error = result.message ?? "Could not send your Slack message.";
        return;
      }
      this.text = "";
      this.dispatchEvent(new CustomEvent("slack-sent", { bubbles: true }));
    } catch {
      this.error = "The send outcome is unknown. Check Slack before trying again.";
    } finally {
      this.sending = false;
    }
  }
  protected render() {
    if (this.loading)
      return html`<div class="slack-reply-box"><p role="status">Checking your Slack connection…</p></div>`;
    if (this.connected)
      return html`<form class="composer-wrap" @submit=${(e: Event) => void this.send(e)}>
        ${composerInput({
          value: this.text,
          placeholder: `Reply in Slack as ${this.label}`,
          label: `Reply in Slack as ${this.label}`,
          disabled: this.sending,
          maxLength: 4000,
          onInput: (e) => {
            this.text = (e.target as HTMLTextAreaElement).value;
          },
          onKeydown: (e) => {
            if (e.isComposing || e.keyCode === 229 || e.key !== "Enter" || e.shiftKey) return;
            void this.send(e);
          },
        })}
        <div class="composer-toolbar">
          <div class="composer-left"></div>
          <div class="composer-right">
            <button
              class="send-btn"
              type="submit"
              aria-label="Send to Slack"
              ${tip("Send to Slack")}
              ?disabled=${this.sending || !this.text.trim()}
            >
              ${icon(ArrowUp, 16)}
            </button>
          </div>
        </div>
        ${this.error ? html`<div class="composer-error" role="alert">${this.error}</div>` : nothing}
      </form>`;
    return html`<div class="slack-reply-box">
      ${this.linkAvailable ? html`<qm-slack-account .user=${this.user} .reply=${true} @slack-linked=${this.refresh}></qm-slack-account>` : nothing}
      ${this.error ? html`<p class="slack-account-error" role="alert">${this.error} <button class="btn" @click=${this.refresh}>Check connection</button></p>` : nothing}
    </div>`;
  }
}
if (!customElements.get("qm-slack-reply")) customElements.define("qm-slack-reply", SlackReply);
