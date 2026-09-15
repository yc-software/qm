import { Agent } from "@earendil-works/pi-agent-core";
import type { Attachment } from "@earendil-works/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { ref } from "lit/directives/ref.js";
import { createChatSurface } from "./chat";
import { createComposerSurface, type ComposerOptions } from "./composer";
import type { ConvCtx, ConvHost } from "./conv-types";
import { storedDraft } from "./drafts";

const staged = new Map<string, Attachment[]>();

function rememberStaged(key: string, attachments: Attachment[]): void {
  staged.delete(key);
  if (attachments.length) staged.set(key, [...attachments]);
  while (staged.size > 30) staged.delete(staged.keys().next().value!);
}

class EmbeddedComposer extends AsyncDirective {
  private ctx: ConvCtx | null = null;
  private key = "";
  private options: ComposerOptions | null = null;
  private element: HTMLElement | null = null;
  private agent: Agent | null = null;

  render(
    key: string,
    options: ComposerOptions & { submit: NonNullable<ComposerOptions["submit"]> },
    compact = false,
  ): TemplateResult {
    if (!this.ctx || this.key !== key) {
      this.release();
      this.key = key;
      const host: ConvHost = {
        pane: compact,
        ownsUrl: false,
        container: () => this.element,
        claimContainer: () => this.element,
        visible: () => this.isConnected,
        density: () => "full" as const,
        onDensityChange: () => {},
        ensureDeliveryStream: () => {},
      };
      const ctx = { ...host } as ConvCtx;
      const composerOptions = { ...options, preferenceKey: key };
      this.options = composerOptions;
      ctx.chat = createChatSurface(ctx);
      ctx.chat.drawActiveChat = () => {
        if (this.ctx !== ctx || !this.isConnected) {
          rememberStaged(key, ctx.composer.state.attachments);
          return;
        }
        this.redraw();
      };
      ctx.composer = createComposerSurface(ctx, composerOptions);
      this.agent = new Agent();
      ctx.chat.state.agent = this.agent;
      ctx.chat.state.host = this.element;
      ctx.chat.state.threadRef = key;
      ctx.composer.state.draft = storedDraft(key);
      ctx.composer.state.attachments = staged.get(key) ?? [];
      staged.delete(key);
      this.ctx = ctx;
      this.listen();
      queueMicrotask(() => {
        if (this.ctx === ctx) void ctx.composer.refreshRuntimeSelection(null, this.agent!);
      });
    }
    this.ctx.pane = compact;
    this.options!.submit = options.submit;
    return this.template();
  }

  private bind = (element: Element | undefined): void => {
    this.element = (element as HTMLElement | undefined) ?? null;
    if (this.ctx) {
      this.ctx.chat.state.host = this.element;
      this.ctx.composer.resizeComposer();
    }
  };

  private template(): TemplateResult {
    const ctx = this.ctx!;
    return html`<div
      class="embedded-composer"
      ${ref(this.bind)}
      @composer-submit=${(event: CustomEvent<string>) => void ctx.composer.submit(event.detail)}
      @dragenter=${(event: DragEvent) => ctx.composer.onDragEnter(event)}
      @dragover=${(event: DragEvent) => ctx.composer.onDragOver(event)}
      @dragleave=${(event: DragEvent) => ctx.composer.onDragLeave(event)}
      @drop=${(event: DragEvent) => void ctx.composer.onDrop(event, this.agent!)}
    >
      ${ctx.composer.composerForm(this.agent!)}
    </div>`;
  }

  private redraw(): void {
    if (!this.ctx || !this.isConnected) return;
    this.setValue(this.template());
    this.ctx.composer.resizeComposer();
  }

  private closeMenus = (event: Event): void => {
    if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
    if (this.ctx?.composer.closeMenus()) this.redraw();
  };

  private listen(): void {
    document.addEventListener("click", this.closeMenus);
    document.addEventListener("keydown", this.closeMenus);
  }

  private unlisten(): void {
    document.removeEventListener("click", this.closeMenus);
    document.removeEventListener("keydown", this.closeMenus);
  }

  private release(): void {
    this.unlisten();
    if (!this.ctx) return;
    rememberStaged(this.key, this.ctx.composer.state.attachments);
    this.ctx.composer.dispose();
    this.ctx.chat.dispose();
    // An in-flight submit can still fail after navigation; restore its draft under the original key.
    this.ctx.chat.state.threadRef = this.key;
    this.ctx = null;
  }

  protected disconnected(): void {
    this.unlisten();
    if (this.ctx) rememberStaged(this.key, this.ctx.composer.state.attachments);
    this.ctx?.composer.dispose();
    // Remove chat's connector hook without destroying the composer's draft.
    const ctx = this.ctx;
    const threadRef = ctx?.chat.state.threadRef;
    ctx?.chat.dispose();
    if (ctx) {
      ctx.chat.state.threadRef = threadRef ?? this.key;
      ctx.chat.state.agent = this.agent;
      ctx.chat.state.host = this.element;
    }
  }

  protected reconnected(): void {
    this.listen();
    if (this.ctx) this.ctx.chat.state.host = this.element;
    this.redraw();
  }
}

export const embeddedComposer = directive(EmbeddedComposer);
