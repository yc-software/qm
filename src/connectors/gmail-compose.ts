import addressparser from "nodemailer/lib/addressparser";
import { splitLinks } from "../../plugins/chassis/src/links.ts";
import { escapeHtml } from "../../plugins/chassis/src/http.ts";
import { header, plainText } from "../loops/verdict/fetch.ts";
import { isObj } from "../util/objects.ts";

export interface GmailParts {
  text: string;
  html: string;
}

const htmlLine = (line: string): string =>
  line
    ? splitLinks(line.replaceAll("  ", "\u00a0 "))
        .map((seg) =>
          seg.kind === "link" ? `<a href="${escapeHtml(seg.href)}">${escapeHtml(seg.href)}</a>` : escapeHtml(seg.text),
        )
        .join("")
    : "<br>";

const htmlMirror = (text: string): string => {
  const [first = "", ...rest] = text.split("\n");
  return `<div dir="ltr">${htmlLine(first)}${rest.map((line) => `<div>${htmlLine(line)}</div>`).join("")}</div>`;
};

function bodyOf(html: string): string {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<body");
  if (open === -1) return html;
  const close = lower.lastIndexOf("</body>");
  return html.slice(lower.indexOf(">", open) + 1, close === -1 ? html.length : close);
}

const isOffset = (token: string): boolean =>
  token.length === 5 && "+-".includes(token[0]!) && Array.from(token.slice(1)).every((c) => c >= "0" && c <= "9");

function sentAt(date: string, timeZone: string | undefined): string {
  const at = new Date(Date.parse(date));
  if (Number.isNaN(at.getTime())) return "";
  const zone = timeZone ?? date.split(" ").find(isOffset) ?? "+0000";
  const day = at.toLocaleDateString("en-US", {
    timeZone: zone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = at.toLocaleTimeString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  return `${day} at ${time.replaceAll(" ", "\u202f")} `;
}

function quoteLine(line: string): string {
  if (line.startsWith(">")) return `>${line}`;
  return line ? `> ${line}` : ">";
}

function gmailQuote(message: Record<string, unknown>, timeZone: string | undefined): GmailParts {
  const payload = isObj(message.payload) ? message.payload : {};
  const [sender] = addressparser(header(payload, "From"), { flatten: true });
  const address = sender?.address ?? "";
  const attribution = `${sentAt(header(payload, "Date"), timeZone)}${sender?.name ? `${sender.name} ` : ""}`;
  const snippet = typeof message.snippet === "string" ? message.snippet : "";
  const plain = (plainText(payload) ?? snippet).replaceAll("\r\n", "\n");
  const rich = plainText(payload, "text/html");
  const quoted = plain.split("\n").map(quoteLine).join("\n");
  return {
    text: `On ${attribution}<${address}> wrote:\n\n${quoted}`,
    html:
      `<br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On ${escapeHtml(attribution)}` +
      `&lt;<a href="mailto:${escapeHtml(address)}">${escapeHtml(address)}</a>&gt; wrote:<br></div>` +
      `<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">` +
      `${rich ? bodyOf(rich) : htmlMirror(plain)}</blockquote></div>`,
  };
}

export function gmailBodyParts(
  body: string,
  original: Record<string, unknown> | undefined,
  timeZone: string | undefined,
): GmailParts {
  const quote = original && gmailQuote(original, timeZone);
  return {
    text: quote ? `${body}\n\n${quote.text}` : body,
    html: htmlMirror(body) + (quote?.html ?? ""),
  };
}
