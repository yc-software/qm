const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}*_“”‘’«»…]$/;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const CODE_RE = /`([^`]+)`/g;
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const BOLD_RE = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g;
const ITALIC_RE = /(^|[\s(])[*_](?=\S)([^*_\n]*?\S)[*_](?=$|[\s.,;:!?)])/g;
const HOLD_OPEN = "\uE000";
const HOLD_CLOSE = "\uE001";
const HOLD_RE = /\uE000(\d+)\uE001/g;
const HOLD_CHARS_RE = /[\uE000\uE001]/g;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function trimUrl(url: string): string {
  let out = url;
  while (out && TRAILING_PUNCTUATION_RE.test(out)) {
    const last = out.at(-1)!;
    const opener = CLOSERS[last];
    if (opener && out.split(opener).length > out.split(last).length - 1) break;
    out = out.slice(0, -1);
  }
  return out;
}

function withHeld(
  text: string,
  render: { code(code: string): string; link(label: string, url: string): string; rest(s: string): string },
): string {
  const held: string[] = [];
  const hold = (value: string): string => {
    held.push(value);
    return `${HOLD_OPEN}${held.length - 1}${HOLD_CLOSE}`;
  };
  let s = text.replace(HOLD_CHARS_RE, "");
  s = s.replace(CODE_RE, (_m, code: string) => hold(render.code(code)));
  s = s.replace(LINK_RE, (_m, label: string, url: string) => hold(render.link(label, url)));
  s = s.replace(URL_RE, (raw) => {
    const url = trimUrl(raw);
    return hold(render.link(url, url)) + raw.slice(url.length);
  });
  return render.rest(s).replace(HOLD_RE, (_m, i: string) => held[Number(i)]!);
}

function inlineHtml(text: string): string {
  return withHeld(text, {
    code: (code) => `<code>${escapeHtml(code)}</code>`,
    link: (label, url) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`,
    rest: (s) => escapeHtml(s).replace(BOLD_RE, "<b>$2</b>").replace(ITALIC_RE, "$1<i>$2</i>"),
  });
}

function inlineText(text: string): string {
  return withHeld(text, {
    code: (code) => code,
    link: (label, url) => (label === url ? url : `${label} (${url})`),
    rest: (s) => s.replace(BOLD_RE, "$2").replace(ITALIC_RE, "$1$2"),
  });
}

function blockShape(lines: string[]): "list" | "heading" | "prose" {
  if (lines.every((l) => LIST_RE.test(l))) return "list";
  if (lines.length === 1 && HEADING_RE.test(lines[0]!)) return "heading";
  return "prose";
}

function blockHtml(block: string): string {
  const lines = block.split("\n");
  const shape = blockShape(lines);
  if (shape === "list") {
    const ordered = /^\s*\d/.test(lines[0]!);
    const items = lines.map((l) => `<li>${inlineHtml(l.match(LIST_RE)![3]!)}</li>`).join("");
    return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
  }
  if (shape === "heading") return `<div><b>${inlineHtml(lines[0]!.match(HEADING_RE)![1]!)}</b></div>`;
  return `<div>${lines.map(inlineHtml).join("<br>")}</div>`;
}

function blockText(block: string): string {
  const lines = block.split("\n");
  const shape = blockShape(lines);
  if (shape === "list") {
    return lines
      .map((l) => {
        const [, indent, marker, item] = l.match(LIST_RE)!;
        return `${indent}${/^\d/.test(marker!) ? marker : "-"} ${inlineText(item!)}`;
      })
      .join("\n");
  }
  if (shape === "heading") return inlineText(lines[0]!.match(HEADING_RE)![1]!);
  return lines.map(inlineText).join("\n");
}

function blocks(body: string): string[] {
  return body
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

export function emailHtml(body: string): string {
  return `<div dir="auto">${blocks(body).map(blockHtml).join("<br>")}</div>`;
}

export function emailPlainText(body: string): string {
  return blocks(body).map(blockText).join("\n\n");
}
