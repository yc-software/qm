const CONNECTOR_REDEEM_RE =
  /https?:\/\/[^\s)\]]+\/(?:connect\/redeem|v1\/connectors\/oauth\/consent\/redeem)\/[^\s)\]]+/gi;

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
  for (const m of text.matchAll(CONNECTOR_REDEEM_RE)) {
    const url = m[0].replace(/(?:\*\*|\*|__|_)+$/, "");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (trustedOrigin && parsed.origin !== trustedOrigin) continue;
    if (parsed.username || parsed.password) continue;
    const provider = parsed.searchParams.get("p") ?? "";
    if (!CONNECTOR_NAMES[provider]) continue;
    if (!out.some((l) => l.url === url)) out.push({ provider, url });
  }
  return out;
}

const EMPH = String.raw`(?:\*\*|\*|__|_)`;

export function stripConnectorLinks(text: string): string {
  return text
    .replace(
      new RegExp(
        `${EMPH}?\\[[^\\]]*\\]\\(\\s*<?https?:\\/\\/[^\\s)]+\\/(?:connect\\/redeem|v1\\/connectors\\/oauth\\/consent\\/redeem)\\/[^\\s)>]+>?\\s*\\)${EMPH}?`,
        "gi",
      ),
      "",
    )
    .replace(new RegExp(`${EMPH}?${CONNECTOR_REDEEM_RE.source}${EMPH}?`, "gi"), "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
