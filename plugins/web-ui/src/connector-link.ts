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
}

export function connectorLinksIn(text: string, trustedOrigin?: string): ConnectorLink[] {
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
      if (!out.some((l) => l.url === url)) out.push({ provider: "composio", url });
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
