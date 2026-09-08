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
  for (const block of root.querySelectorAll<HTMLElement>("code-block")) {
    if (block.getAttribute("language") === "text") collapsePlainTextBlock(block);
    else numberCodeLines(block);
  }
}

function collapsePlainTextBlock(block: HTMLElement): void {
  const body = block.querySelector<HTMLElement>(":scope > div > div:last-child");
  const footer = block.querySelector<HTMLElement>(":scope > div > div:first-child");
  const pre = body?.querySelector("pre");
  if (!body || !footer || !pre) return;
  body.classList.add("text-code-body");
  footer.classList.add("text-code-footer");
  if (footer.querySelector(".text-code-toggle") || pre.scrollHeight <= 76) return;
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

function numberCodeLines(block: HTMLElement): void {
  const pre = block.querySelector("pre");
  const code = pre?.querySelector("code");
  if (!pre || !code) return;
  const lines = (code.textContent ?? "").replace(/\n$/u, "").split("\n");
  if (lines.length < 2) return;
  const existing = pre.querySelector<HTMLElement>(":scope > .code-gutter");
  if (existing?.childElementCount === lines.length) return;
  const diff = /^(?:diff|patch)$/u.test(block.getAttribute("language") ?? "");
  const gutter = existing ?? pre.insertBefore(block.ownerDocument.createElement("span"), code);
  gutter.className = "code-gutter";
  gutter.setAttribute("aria-hidden", "true");
  gutter.replaceChildren(
    ...lines.map((line, i) => {
      const cell = block.ownerDocument.createElement("span");
      const mark = diff ? diffMark(line) : "";
      cell.textContent = diff ? mark || " " : String(i + 1);
      if (mark === "+") cell.className = "code-line-add";
      if (mark === "-") cell.className = "code-line-del";
      return cell;
    }),
  );
}

function diffMark(line: string): string {
  if (/^(?:\+\+\+|---)/u.test(line)) return "";
  return line[0] === "+" || line[0] === "-" ? line[0] : "";
}
