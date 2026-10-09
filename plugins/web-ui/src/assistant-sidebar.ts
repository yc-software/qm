import { html, nothing, type TemplateResult } from "lit";
import type { DirectiveResult } from "lit/directive.js";
import { Send } from "lucide";
import { markdown } from "./message-markdown";
import { icon } from "./ui";
import { tip } from "./tooltip";

type Content = TemplateResult | DirectiveResult | typeof nothing;

export type AssistantSidebarContext =
  | { kind: "thread"; source: string; hasDraft: boolean; sent: boolean; resolved: boolean }
  | { kind: "inbox"; hasEmail: boolean; hasSlack: boolean; hasDrafts: boolean };

export function assistantPrompts(context: AssistantSidebarContext): readonly string[] {
  if (context.kind === "inbox") {
    const prompts = [context.hasEmail && !context.hasSlack ? "Summarize my recent emails" : "Summarize my inbox"];
    prompts.push(context.hasDrafts ? "Which drafts should I review first?" : "What needs my attention?");
    return prompts;
  }
  if (context.sent) return ["Summarize this email", "What should I follow up on?"];
  if (context.source === "generic") return ["Explain the proposal", "What needs my input?"];
  if (context.resolved) return ["Summarize this thread", "Does this still need a reply?"];
  if (context.hasDraft) return ["Make it shorter", "Make it more friendly", "Remove the salutations"];
  return ["Summarize this thread", "Help me write a reply"];
}

export function assistantMessage(options: {
  role: "human" | "agent" | "system";
  text?: string;
  content?: Content;
  before?: Content;
  after?: Content;
  meta?: Content;
  index?: number;
  entrySeqs?: string;
  streaming?: boolean;
}): TemplateResult {
  const human = options.role === "human";
  return html`<article
    class="inbox-chat-msg ${options.role} ${options.meta && options.meta !== nothing ? "message-row" : ""} ${options.streaming ? "streaming" : ""}"
    data-index=${options.index ?? nothing}
    data-entry-seqs=${options.entrySeqs ?? nothing}
  >
    ${options.before ?? nothing}
    ${
      human || options.role === "system"
        ? html`<span class="inbox-chat-text" ?hidden=${human && !options.text?.trim()}>${options.text ?? ""}</span>`
        : html`<div class="assistant-body">${options.content ?? markdown(options.text ?? "")}</div>`
    }
    ${options.after ?? nothing} ${options.meta ?? nothing}
  </article>`;
}

export function assistantSidebar(options: {
  context: AssistantSidebarContext;
  messages: Content;
  composer: Content;
  showPrompts: boolean;
  busy?: boolean;
  status?: Content;
  toolbar?: Content;
  send?: { disabled: boolean; run: (event: MouseEvent) => void };
  onPrompt: (prompt: string, event: MouseEvent) => void;
  overlay?: Content;
  onDragEnter?: (event: DragEvent) => void;
  onDragOver?: (event: DragEvent) => void;
  onDragLeave?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
}): TemplateResult {
  return html`<div
    class="inbox-chat assistant-sidebar"
    @dragenter=${options.onDragEnter}
    @dragover=${options.onDragOver}
    @dragleave=${options.onDragLeave}
    @drop=${options.onDrop}
  >
    ${options.overlay ?? nothing}
    <section class="chat-scroll inbox-chat-log" tabindex="0" aria-label="Conversation">
      <div class="message-stack">${options.messages}</div>
    </section>
    ${options.status ?? nothing}
    <div class="chat-bottom-dock">
      ${options.toolbar ?? nothing}
      ${
        options.send || options.showPrompts
          ? html`<div class="inbox-chat-suggestions">
              ${options.send ? html`<button class="inbox-suggest-chip primary" type="button" ?disabled=${options.send.disabled} ${tip("Send the draft with your instructions")} @click=${options.send.run}>${icon(Send, 12)}<span>Send it</span></button>` : nothing}
              <div class="inbox-edit-suggestions">
                ${(options.showPrompts ? assistantPrompts(options.context) : []).map((prompt) => html`<button class="inbox-suggest-chip inbox-chat-suggestion" type="button" ?disabled=${options.busy} @click=${(event: MouseEvent) => options.onPrompt(prompt, event)}>${prompt}</button>`)}
              </div>
            </div>`
          : nothing
      }
      <div class="inbox-chat-composer">${options.composer}</div>
    </div>
  </div>`;
}
