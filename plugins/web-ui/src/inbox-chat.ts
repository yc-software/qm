import { html, LitElement, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { api, type CoreSession } from "./core-bridge";
import type { Conversation } from "./conv-types";
import { createConversation, disposeConversation, ensureDeliveryStream } from "./conversations";
import { openSessionInto } from "./sessions";
import { appState, can } from "./shell-state";
import type { AssistantSidebarContext } from "./assistant-sidebar";
import { brandName } from "./ui";

class InboxChat extends LitElement {
  static properties = { context: { attribute: false } };
  declare context: AssistantSidebarContext;

  protected updated(): void {
    this.conversation?.redraw();
  }

  private element: HTMLElement | null = null;
  private conversation: Conversation | null = null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  render(): TemplateResult {
    return html`<div class="inbox-index-conversation" ${ref(this.bind)}></div>`;
  }

  private bind = (element: Element | undefined): void => {
    this.element = (element as HTMLElement | undefined) ?? null;
    if (this.element && !this.conversation) queueMicrotask(() => void this.load());
  };

  private async load(): Promise<void> {
    const user = appState.me?.user;
    if (!user || !can("inbox") || !this.element || !this.isConnected || this.conversation) return;
    const conversation = createConversation(
      {
        pane: true,
        ownsUrl: false,
        container: () => this.element,
        claimContainer: () => this.element,
        visible: () => this.isConnected && this.element?.isConnected === true,
        density: () => "full",
        onDensityChange: () => {},
        ensureDeliveryStream,
        inbox: { context: () => this.context },
      },
      { placeholder: `Ask ${brandName()} about your inbox`, runtimeAccount: "company" },
    );
    this.conversation = conversation;
    const current = conversation.mountLoadingPane();
    const threadRef = `web:${user}:inbox`;
    try {
      const { sessions } = await api<{ sessions: CoreSession[] }>("/api/sessions");
      const session = sessions.find((entry) => entry.threadRef === threadRef);
      if (this.conversation !== conversation || !current()) return;
      if (session) await openSessionInto(conversation, session, undefined, undefined, false);
      else conversation.mountContinuable(threadRef, null, null, [], "Inbox");
    } catch {
      if (this.conversation !== conversation || !current()) return;
      conversation.mountLoadError(() => {
        this.release();
        void this.load();
      });
    }
  }

  private release(): void {
    if (this.conversation) disposeConversation(this.conversation);
    this.conversation = null;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.release();
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.updateComplete.then(() => this.load());
  }
}

if (!customElements.get("qm-inbox-chat")) customElements.define("qm-inbox-chat", InboxChat);

export function inboxChat(
  context: AssistantSidebarContext = { kind: "inbox", hasEmail: false, hasSlack: false, hasDrafts: false },
): TemplateResult {
  return html`<qm-inbox-chat
    .context=${context}
    class="inbox-index-chat"
    role="complementary"
    aria-label="Inbox assistant"
  ></qm-inbox-chat>`;
}
