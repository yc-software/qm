const LINK_RE = /https?:\/\/[^\s<>()[\]]+/gi;

export const CONNECTOR_NAMES: Record<string, string> = {
  google: "Google Workspace",
  slack: "Slack",
  notion: "Notion",
  linear: "Linear",
  github: "GitHub",
  dropbox: "Dropbox",
  x: "X",
};

export interface ConnectorLink {
  provider: string;
  url: string;
  label?: string;
}

export function connectorLinksIn(text: string, trustedOrigin?: string): ConnectorLink[] {
  const labels = new Map<string, string>();
  for (const m of text.matchAll(/\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/gi)) {
    const label = m[1]!.trim();
    if (label && !labels.has(m[2]!)) labels.set(m[2]!, label);
  }
  const out: ConnectorLink[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const url = m[0].replace(/[*_]+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.username || parsed.password) continue;
    if (parsed.origin === "https://connect.composio.dev" && /^\/link\/lk_[A-Za-z0-9_-]+$/.test(parsed.pathname)) {
      const label = labels.get(url);
      if (!out.some((l) => l.url === url)) out.push({ provider: "composio", url, ...(label ? { label } : {}) });
      continue;
    }
    if (
      trustedOrigin &&
      parsed.origin === trustedOrigin &&
      parsed.pathname === "/admin" &&
      parsed.search === "?slack=setup"
    ) {
      if (!out.some((l) => l.provider === "slack-bot")) out.push({ provider: "slack-bot", url });
      continue;
    }
    if (trustedOrigin && parsed.origin !== trustedOrigin) continue;
    if (!/^\/(?:connect\/redeem|v1\/connectors\/oauth\/consent\/redeem)\/[^/]+$/.test(parsed.pathname)) continue;
    const provider = parsed.searchParams.get("p") ?? "";
    if (!CONNECTOR_NAMES[provider]) continue;
    if (!out.some((l) => l.url === url)) out.push({ provider, url });
  }
  return out;
}

const EMPH = String.raw`(?:\*\*|\*|__|_)`;

export function stripConnectorLinks(text: string, links = connectorLinksIn(text)): string {
  for (const { url } of links) {
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text
      .replace(new RegExp(`${EMPH}?\\[[^\\]]*\\]\\(\\s*<?${escaped}>?\\s*\\)${EMPH}?`, "g"), "")
      .replace(new RegExp(`${EMPH}?<?${escaped}(?=$|[\\s<>()[\\]*_])>?${EMPH}?`, "g"), "");
  }
  return text.replace(/[ \t]+$/gm, "").trim();
}

export function connectorService(link: ConnectorLink): string {
  if (link.provider !== "composio") return link.provider;
  const label = (link.label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const services: Array<[string, RegExp]> = [
    ["gmail", /\bgmail\b/],
    ["googlecalendar", /\b(?:google calendar|gcalendar)\b|^(?:connect |authorize )?calendar$/],
    ["googledrive", /\b(?:google drive|gdrive)\b/],
    ["googlesheets", /\b(?:google sheets|gsheets)\b/],
    ["google", /\b(?:google|google workspace)\b/],
    ["slack", /\bslack\b/],
    ["notion", /\bnotion\b/],
    ["linear", /\blinear\b/],
    ["github", /\bgithub\b/],
    ["dropbox", /\bdropbox\b/],
    ["x", /\b(?:twitter|x)\b/],
  ];
  const matches = services.filter(([, pattern]) => pattern.test(label));
  const hasGoogleProduct = matches.some(([id]) => id.startsWith("google") && id !== "google");
  const specific = matches.filter(([id]) => id !== "google" || !hasGoogleProduct);
  return specific.length === 1 ? specific[0]![0] : "";
}
