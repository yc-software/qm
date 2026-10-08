import { html, nothing, render } from "lit";
import { X } from "lucide";
import { webFetch } from "./core-bridge";
import { icon } from "./ui";
import { markdown } from "./message-markdown";
import { installMarkdownSanitizer } from "./markdown-sanitize";
import { errMessage } from "../../chassis/src/errors";
import type { filePreviewKind } from "./file-open";

const PREVIEW_LIMIT = 2 * 1024 * 1024;

export function openFileViewer(
  name: string,
  href: string,
  kind: NonNullable<ReturnType<typeof filePreviewKind>>,
  mimetype = "",
): void {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "project-dialog file-viewer";
  dialog.setAttribute("aria-label", name);
  const request = new AbortController();
  const content = document.createElement("div");
  content.className = "file-viewer-content";
  let destroyEditor: (() => void) | undefined;
  let text: string | null = null;
  let notice = "";
  let error = "";
  let copied = false;
  const close = () => dialog.close();
  dialog.addEventListener("close", () => {
    request.abort();
    destroyEditor?.();
    render(nothing, content);
    render(nothing, dialog);
    dialog.remove();
    if (opener?.isConnected) opener.focus();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      close();
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text ?? "");
      copied = true;
    } catch {
      error = "Couldn't copy. Select the text to copy it manually.";
    }
    if (!request.signal.aborted) draw();
  };
  const draw = () =>
    render(
      html` <header class="file-viewer-head">
          <strong dir="auto">${name}</strong
          ><button class="icon-btn" aria-label="Close preview" @click=${close}>${icon(X, 18)}</button>
        </header>
        <div class="file-viewer-toolbar">
          <a class="btn" href=${href} download=${name}>Download</a
          ><button class="btn" ?disabled=${text === null} @click=${copy}>${copied ? "Copied" : "Copy"}</button>
        </div>
        ${notice ? html`<p class="file-viewer-notice muted" role="status">${notice}</p>` : nothing}
        ${error ? html`<p class="file-viewer-notice" role="alert">${error}</p>` : nothing} ${content}`,
      dialog,
    );
  installMarkdownSanitizer();
  document.body.append(dialog);
  render(html`<p class="muted">Loading…</p>`, content);
  draw();
  dialog.showModal();
  void (async () => {
    try {
      const response = await webFetch(href, { signal: request.signal });
      if (!response.ok) throw new Error(`Couldn't load this file (${response.status}).`);
      const blob = await response.blob();
      text = await blob.text();
      if (request.signal.aborted) return;
      if (blob.size > PREVIEW_LIMIT) {
        notice = "Files over 2 MB are shown as plain text.";
        render(html`<pre class="file-viewer-text">${text}</pre>`, content);
      } else if (kind === "markdown") {
        render(markdown(text), content);
      } else if (kind === "csv" || kind === "tsv") {
        const { default: Papa } = await import("papaparse");
        if (request.signal.aborted) return;
        const result = Papa.parse<string[]>(text, {
          delimiter: kind === "tsv" ? "\t" : ",",
          preview: 1001,
          skipEmptyLines: true,
        });
        if (result.meta.truncated || result.data.length > 1000 || result.data.some((row) => row.length > 100))
          notice = "Preview limited to 1,000 rows and 100 columns. Download for the full file.";
        if (result.errors.length)
          notice = [notice, "This file contains CSV formatting errors. Some cells may not display as intended."]
            .filter(Boolean)
            .join(" ");
        render(
          html`<table class="file-viewer-table">
            <tbody>
              ${result.data.slice(0, 1000).map(
                (row) =>
                  html`<tr>
                    ${row.slice(0, 100).map((cell) => html`<td>${cell}</td>`)}
                  </tr>`,
              )}
            </tbody>
          </table>`,
          content,
        );
      } else {
        const { mountFileEditor } = await import("./file-editor");
        if (request.signal.aborted) return;
        render(nothing, content);
        content.classList.add("file-viewer-editor");
        destroyEditor = await mountFileEditor(content, text, name, mimetype.split(";", 1)[0]);
        if (request.signal.aborted) destroyEditor();
      }
    } catch (err) {
      if (request.signal.aborted) return;
      error = errMessage(err, "Couldn't load this file.");
      render(text === null ? nothing : html`<pre class="file-viewer-text">${text}</pre>`, content);
    }
    if (!request.signal.aborted) draw();
  })();
}
