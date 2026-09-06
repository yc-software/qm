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

export function decorateTextCodeBlocks(root: ParentNode | null): void {
  if (!root) return;
  for (const block of root.querySelectorAll<HTMLElement>('code-block[language="text"]')) {
    const body = block.querySelector<HTMLElement>(":scope > div > div:last-child");
    const footer = block.querySelector<HTMLElement>(":scope > div > div:first-child");
    const pre = body?.querySelector("pre");
    if (!body || !footer || !pre) continue;
    body.classList.add("text-code-body");
    footer.classList.add("text-code-footer");
    if (footer.querySelector(".text-code-toggle") || pre.scrollHeight <= 76) continue;
    const button = block.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "text-code-toggle";
    const update = (expanded: boolean) => {
      block.dataset.expanded = String(expanded);
      button.textContent = expanded ? "Show less" : "Show more";
      button.setAttribute("aria-expanded", String(expanded));
    };
    button.addEventListener("click", () => update(block.dataset.expanded !== "true"));
    footer.insertBefore(button, footer.lastElementChild);
    block.classList.add("text-code-collapsible");
    update(block.dataset.expanded === "true");
  }
}
