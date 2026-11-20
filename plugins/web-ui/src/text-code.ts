import { markdownFence, type MarkdownFence } from "./streaming-markdown.ts";

export function normalizePlainTextFences(text: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const normalized: string[] = [];
  let opener: (MarkdownFence & { index: number; plainText: boolean }) | null = null;

  for (const line of lines) {
    const fence = markdownFence(line);
    if (!opener) {
      normalized.push(line);
      const language = fence?.info.split(/[ \t]+/u, 1)[0]?.toLowerCase();
      if (fence) opener = { ...fence, index: normalized.length - 1, plainText: !language || language === "text" };
      continue;
    }
    if (fence && fence.marker === opener.marker && fence.length >= opener.length && !fence.info) {
      if (opener.plainText) {
        while (normalized.length > opener.index + 1 && /^[ \t]*$/u.test(normalized.at(-1) ?? "")) normalized.pop();
      }
      normalized.push(line);
      opener = null;
      continue;
    }
    if (opener.plainText && normalized.length === opener.index + 1 && /^[ \t]*$/u.test(line)) continue;
    normalized.push(line);
  }

  return normalized.join(newline);
}

export function decorateCodeBlocks(root: ParentNode | null): void {
  if (!root) return;
  for (const block of root.querySelectorAll<HTMLElement>("code-block")) {
    const frame = block.querySelector<HTMLElement>(":scope > div");
    const toolbar = frame?.querySelector<HTMLElement>(":scope > div:first-child");
    const body = frame?.querySelector<HTMLElement>(":scope > div:nth-child(2)");
    const pre = body?.querySelector("pre");
    if (!frame || !toolbar || !body || !pre) continue;
    toolbar.classList.add("code-block-toolbar");
    body.classList.add("code-block-body");
    if (frame.querySelector(".code-block-toggle") || pre.scrollHeight <= 120) continue;
    const button = block.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "code-block-toggle";
    const update = (expanded: boolean) => {
      block.dataset.expanded = String(expanded);
      button.textContent = expanded ? "Show less" : "Show more";
      button.setAttribute("aria-expanded", String(expanded));
    };
    button.addEventListener("click", () => update(block.dataset.expanded !== "true"));
    frame.append(button);
    block.classList.add("code-block-collapsible");
    update(block.dataset.expanded === "true");
  }
}
