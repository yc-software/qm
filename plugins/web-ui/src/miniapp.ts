export interface MiniappEmbed {
  url: string;
  title: string;
}

const MINIAPP_DIRECTIVE = /\[\[miniapp:\s*(\S+?)\s*(?:\|\s*([^\]]*?))?\]\]/gi;
const TRAILING_OPEN = /\[\[miniapp:[\s\S]*$/i;

export function parseMiniappUrl(raw: string): string | null {
  const value = raw.trim().replace(/^<|>$/g, "");
  if (!value) return null;
  if (value.startsWith("/m/")) {
    const parts = value.slice(3).split("/").filter(Boolean);
    if (parts.length === 2 && parts[0] && parts[1]) return `/m/${parts[0]}/${parts[1]}`;
    return null;
  }
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts[0] !== "m" || parts.length !== 3) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function miniappsIn(text: string): MiniappEmbed[] {
  const out: MiniappEmbed[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MINIAPP_DIRECTIVE)) {
    const url = parseMiniappUrl(m[1] ?? "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: (m[2] ?? "").trim() || "Playground" });
  }
  return out.slice(0, 5);
}

export function stripMiniappDirectives(text: string): string {
  if (!text) return text ?? "";
  return text
    .replace(MINIAPP_DIRECTIVE, "")
    .replace(TRAILING_OPEN, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function currentMiniappTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function miniappFrameSrc(url: string, withBase: (path: string) => string, theme?: "light" | "dark"): string {
  let src = url;
  if (url.startsWith("/m/")) src = withBase(url);
  else {
    try {
      const u = new URL(url);
      const parts = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      if (parts[0] === "m" && parts.length === 3) src = withBase(`/${parts.join("/")}`);
    } catch {
      src = url;
    }
  }
  if (!theme) return src;
  return withMiniappParam(src, "theme", theme);
}

export function miniappSourceSrc(frameSrc: string): string {
  return withMiniappParam(frameSrc, "view", "source");
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export function formatMiniappHtml(html: string): string {
  const holes: string[] = [];
  const parked = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (block) => {
    holes.push(block);
    return `\0${holes.length - 1}\0`;
  });
  const lines = parked
    .replace(/\0(\d+)\0/g, "\n\0$1\0\n")
    .replace(/></g, ">\n<")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let depth = 0;
  return lines
    .map((line) => {
      const close = /^<\/([a-zA-Z][\w:-]*)/.exec(line);
      const open = /^<([a-zA-Z][\w:-]*)\b[^>]*>/.exec(line);
      if (close) depth = Math.max(0, depth - 1);
      const pad = "  ".repeat(depth);
      const name = open?.[1]?.toLowerCase() ?? "";
      const self = /\/\s*>$/.test(line) || VOID_TAGS.has(name);
      const paired = Boolean(open && new RegExp(`</${open[1]}\\s*>$`, "i").test(line));
      if (open && !close && !self && !paired && !line.startsWith("<!")) depth++;
      return pad + line.replace(/\0(\d+)\0/g, (_, i) => holes[Number(i)] ?? "");
    })
    .join("\n");
}

function withMiniappParam(src: string, key: string, value: string): string {
  if (/^https?:/i.test(src)) {
    const u = new URL(src);
    u.searchParams.set(key, value);
    return u.toString();
  }
  const sep = src.includes("?") ? "&" : "?";
  return `${src}${sep}${key}=${value}`;
}
