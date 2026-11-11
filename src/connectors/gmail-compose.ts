import addressparser from "nodemailer/lib/addressparser";
import { isTag, type ChildNode } from "domhandler";
import { DomUtils, ElementType, parseDocument } from "htmlparser2";
import { splitLinks } from "../../plugins/chassis/src/links.ts";
import { escapeHtml } from "../../plugins/chassis/src/http.ts";
import { gmailHeader, gmailPartText } from "./gmail-api.ts";
import { isObj } from "../util/objects.ts";

export interface GmailParts {
  text: string;
  html: string;
}

const linkedLine = (line: string): string =>
  splitLinks(line)
    .map((seg) =>
      seg.kind === "link" ? `<a href="${escapeHtml(seg.href)}">${escapeHtml(seg.href)}</a>` : escapeHtml(seg.text),
    )
    .join("");

const GMAIL_PLAIN_WIDTH = 76;

const spaced = (line: string): string => {
  const kept = line.replaceAll("  ", "\u00a0 ");
  return kept.endsWith(" ") ? `${kept.slice(0, -1)}\u00a0` : kept;
};

const htmlLine = (line: string): string => (line ? linkedLine(spaced(line)) : "<br>");

const htmlMirror = (text: string): string => {
  const [first = "", ...rest] = text.split("\n");
  return `<div dir="ltr">${htmlLine(first)}${rest.map((line) => `<div>${htmlLine(line)}</div>`).join("")}</div>`;
};

function wrapped(line: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    if (current && current.length + 1 + word.length > GMAIL_PLAIN_WIDTH) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  return [...lines, current];
}

const plainWrapped = (text: string): string =>
  text
    .split("\n")
    .flatMap((line) => (line.startsWith(">") ? [line] : wrapped(line.trimEnd())))
    .join("\n");

const quoteLine = (line: string): string => {
  if (line.startsWith(">")) return `>${line}`;
  return line ? `> ${line}` : ">";
};

const HIDDEN_HTML = new Set(["head", "style", "script", "title"]);

function textOf(nodes: ChildNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === ElementType.Text) return node.data;
      if (!isTag(node)) return "";
      if (node.name === "br") return "\n";
      return textOf(node.children) + (node.name === "div" || node.name === "p" ? "\n" : "");
    })
    .join("");
}

const hidden = (node: ChildNode): boolean =>
  node.type === ElementType.Comment || (isTag(node) && HIDDEN_HTML.has(node.name));

const opensNewTab = (node: ChildNode): boolean =>
  isTag(node) && node.name === "a" && "href" in node.attribs && !("target" in node.attribs);

function bodyMarkup(html: string): { markup: string; text: string } {
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true });
  const body = DomUtils.findOne((el) => el.name === "body", doc.children);
  const html2 = DomUtils.findOne((el) => el.name === "html", doc.children);
  const root = body?.children ?? html2?.children ?? doc.children;
  const edits = DomUtils.filter((node) => hidden(node) || opensNewTab(node), root);
  let markup = "";
  let at = root[0]?.startIndex ?? 0;
  for (const node of edits) {
    const start = node.startIndex ?? at;
    if (start < at) continue;
    if (hidden(node)) {
      markup += html.slice(at, start);
      at = (node.endIndex ?? start) + 1;
    } else if (isTag(node)) {
      const tagEnd = (node.children[0]?.startIndex ?? (node.endIndex ?? start) - 3) - 1;
      markup += `${html.slice(at, tagEnd)} target="_blank"`;
      at = tagEnd;
    }
  }
  markup += html.slice(at, (root.at(-1)?.endIndex ?? html.length - 1) + 1);
  for (const node of edits.filter(hidden)) DomUtils.removeElement(node);
  return { markup, text: textOf(root) };
}

const isOffset = (token: string): boolean =>
  token.length === 5 && "+-".includes(token[0]!) && Array.from(token.slice(1)).every((c) => c >= "0" && c <= "9");

function gmailDate(header: string, viewerZone: string | undefined): string {
  const at = new Date(Date.parse(header));
  if (Number.isNaN(at.getTime())) return "";
  const timeZone = viewerZone ?? header.split(" ").find(isOffset) ?? "+0000";
  const day = at.toLocaleDateString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = at.toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  return `${day} at ${time.replaceAll(" ", "\u202f")} `;
}

function attribution(payload: Record<string, unknown>, viewerZone: string | undefined): { text: string; html: string } {
  const from = gmailHeader(payload, "From");
  const when = gmailDate(gmailHeader(payload, "Date"), viewerZone);
  const [sender] = addressparser(from, { flatten: true });
  const address = sender?.address ?? "";
  const link = `<a href="mailto:${escapeHtml(address)}">${escapeHtml(address)}</a>`;
  return {
    text: `On ${when}${sender?.name ? `${sender.name} ` : ""}<${address}> wrote:`,
    html: `On ${escapeHtml(when)}${sender?.name ? `${escapeHtml(sender.name)} ` : ""}&lt;${link}&gt; wrote:`,
  };
}

function gmailQuote(message: Record<string, unknown>, viewerZone: string | undefined): GmailParts {
  const payload = isObj(message.payload) ? message.payload : {};
  const rich = gmailPartText(payload, "text/html");
  const parsed = rich ? bodyMarkup(rich) : undefined;
  const plain = (gmailPartText(payload) || parsed?.text || "").replaceAll("\r\n", "\n");
  const attr = attribution(payload, viewerZone);
  return {
    text: `${attr.text}\n\n${plainWrapped(plain).split("\n").map(quoteLine).join("\n")}`,
    html:
      `<br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">${attr.html}<br></div>` +
      `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${parsed?.markup ?? htmlMirror(plain)}</blockquote></div>`,
  };
}

export function gmailBodyParts(
  body: string,
  original: Record<string, unknown> | undefined,
  viewerZone: string | undefined,
): GmailParts {
  const quote = original && gmailQuote(original, viewerZone);
  return {
    text: quote ? `${plainWrapped(body)}\n\n${quote.text}` : plainWrapped(body),
    html: htmlMirror(body) + (quote?.html ?? ""),
  };
}
