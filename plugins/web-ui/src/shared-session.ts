import "./shell.css";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { html, render, type TemplateResult } from "lit";
import { Lock, ArrowUpRight, Check, Copy, File, FileImage } from "lucide";
import { createTranscriptViewport } from "./transcript-viewport";
import { decorateTextCodeBlocks } from "./text-code";
import { markdown } from "./message-markdown";
import { installMarkdownSanitizer } from "./markdown-sanitize";
import { brandName, brandMark, browserRenderableImage, chipBadge, icon, copyText } from "./ui";

interface SharedTranscript {
  createdAt: number;
  audience: "internal" | "external";
  messages: Array<{
    role: "user" | "assistant";
    text: string;
    attachments?: Array<{
      id: string;
      name: string;
      mimetype: string;
      sizeBytes: number;
      inlinePreview?: boolean;
      previewId?: string;
    }>;
  }>;
}

installMarkdownSanitizer({ shared: true });
const transcript: SharedTranscript | null = JSON.parse(document.getElementById("shared-transcript")!.textContent!);
const base = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;
const failedImageSources = new Set<string>();

function sharedConversation(): TemplateResult {
  return html`
    <div class="shared-conversation">
      <header class="chat-topbar session-topbar">
        <a class="shared-brand" href=${base} aria-label=${`Open ${brandName()}`}
          >${brandMark()}<span>${brandName()}</span></a
        >
        <div class="session-heading">
          <span class="session-title">Shared conversation</span
          ><span class="shared-view-badge">${icon(Lock, 12)}Read-only</span>
        </div>
        <div class="topbar-actions">
          <theme-toggle .includeSystem=${true}></theme-toggle
          ><a class="btn compact" href=${base}>Open ${brandName()}${icon(ArrowUpRight, 14)}</a>
        </div>
      </header>
      <main class="chat-scroll readonly-scroll" tabindex="0" aria-label="Conversation">
        <div class="message-stack">
          ${
            transcript
              ? transcript.messages.map(
                  (message) => html`
                    <article class=${`message-row ${message.role}-row`}>
                      <div class=${message.role === "user" ? "message-bubble user-bubble" : "assistant-body"}>
                        <div class=${message.role === "user" ? "pin-content" : "shared-message-content"}>
                          ${markdown(message.text)}
                        </div>
                        ${message.role === "user" ? html`<button class="pin-toggle" type="button" hidden aria-expanded="false">Show more</button>` : ""}
                        ${
                          message.attachments?.length
                            ? html`<div class="message-files">
                                ${message.attachments.map((file) => {
                                  const href = `${location.pathname}/files/${encodeURIComponent(file.id)}`;
                                  const imageSrc = file.previewId
                                    ? `${location.pathname}/files/${encodeURIComponent(file.previewId)}?inline=1`
                                    : `${href}?inline=1`;
                                  const inlineImage =
                                    browserRenderableImage(file.mimetype) &&
                                    (message.role !== "user" ||
                                      (file.inlinePreview === true && Boolean(file.previewId)));
                                  const failedImage = failedImageSources.has(imageSrc);
                                  if (message.role === "user" && inlineImage && !failedImage) {
                                    return html`<a
                                      class="user-image-attachment"
                                      href=${href}
                                      download=${file.name}
                                      rel="noreferrer"
                                      ><img
                                        src=${imageSrc}
                                        alt="Attached image"
                                        loading="lazy"
                                        @error=${() => {
                                          failedImageSources.add(imageSrc);
                                          draw();
                                        }}
                                    /></a>`;
                                  }
                                  if (inlineImage && message.role !== "user" && !failedImage) {
                                    return html`<a
                                      class="file-image"
                                      href=${href}
                                      download=${file.name}
                                      rel="noreferrer"
                                      ><img
                                        src=${imageSrc}
                                        alt=${file.name}
                                        loading="lazy"
                                        @error=${() => {
                                          failedImageSources.add(imageSrc);
                                          draw();
                                        }}
                                    /></a>`;
                                  }
                                  return chipBadge(
                                    inlineImage ? FileImage : File,
                                    file.name,
                                    file.sizeBytes,
                                    inlineImage && !failedImage ? imageSrc : href,
                                    !inlineImage || failedImage,
                                  );
                                })}
                              </div>`
                            : ""
                        }
                        ${message.role === "assistant" ? html`<div class="message-meta"><button class="msg-copy" aria-label="Copy message" title="Copy" @click=${(e: Event) => void copyText(message.text, e.currentTarget as HTMLButtonElement)}>${icon(Copy, 13)}${icon(Check, 13)}</button></div>` : ""}
                      </div>
                      ${message.role === "user" ? html`<div class="message-meta"><button class="msg-copy" aria-label="Copy message" title="Copy" @click=${(e: Event) => void copyText(message.text, e.currentTarget as HTMLButtonElement)}>${icon(Copy, 13)}${icon(Check, 13)}</button></div>` : ""}
                    </article>
                  `,
                )
              : html`<div class="empty-state">
                  <h2>This link is unavailable</h2>
                  <p>The conversation is unavailable or you may not have access.</p>
                </div>`
          }
        </div>
      </main>
      <footer class="shared-conversation-footer">
        ${icon(Lock, 12)}${transcript ? `Shared snapshot · ${new Date(transcript.createdAt).toLocaleDateString()} · ${transcript.audience === "external" ? "Anyone with the link" : "Organization only"}` : "Shared conversation"}
      </footer>
    </div>
  `;
}

function draw(): void {
  render(sharedConversation(), document.getElementById("app")!);
}

draw();

const viewport = createTranscriptViewport();
requestAnimationFrame(() => {
  decorateTextCodeBlocks(document.getElementById("app"));
  viewport.sync(document.querySelector<HTMLElement>(".chat-scroll"));
});
