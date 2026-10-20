import { marked } from "marked";

export const CONNECTOR_LABELS: Record<string, { name: string; hosts: string }> = {
  google: {
    name: "Google Workspace",
    hosts: "Gmail, Calendar, Drive, Sheets",
  },
  slack: {
    name: "Slack",
    hosts: "Channels & messages",
  },
  notion: {
    name: "Notion",
    hosts: "Pages & databases",
  },
  linear: {
    name: "Linear",
    hosts: "Issues & projects",
  },
  github: {
    name: "GitHub",
    hosts: "Repos, issues & PRs",
  },
  dropbox: {
    name: "Dropbox",
    hosts: "Files & folders",
  },
  x: {
    name: "X (Twitter)",
    hosts: "Posts & profile",
  },
};

export interface ConnectorLink {
  provider: string;
  url: string;
  toolkit?: string;
  logoUrl?: string;
  label?: string;
}

export function connectorLinksOf(payload: unknown): ConnectorLink[] {
  const raw = (payload as { connectorLinks?: unknown } | null)?.connectorLinks;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const { provider, url, toolkit, logoUrl } = (item ?? {}) as Record<string, unknown>;
    if (typeof provider !== "string" || !provider || typeof url !== "string" || !url) return [];
    return [
      {
        provider,
        url,
        ...(typeof toolkit === "string" && toolkit ? { toolkit } : {}),
        ...(typeof logoUrl === "string" && logoUrl ? { logoUrl } : {}),
      },
    ];
  });
}

export function slackSetupUrl(origin: string): string {
  return `${origin}/admin?slack=setup`;
}

export function takeLinks(text: string, urls: readonly string[]): { body: string; labels: Map<string, string> } {
  const wanted = new Set(urls.filter((url) => text.includes(url)));
  const labels = new Map<string, string>();
  if (!wanted.size) return { body: text, labels };
  const spans: string[] = [];
  marked.walkTokens(marked.lexer(text), (token) => {
    if ((token.type === "strong" || token.type === "em") && token.tokens?.length === 1) {
      const only = token.tokens[0]!;
      if (only.type === "link" && wanted.has(only.href)) spans.push(token.raw);
    }
    if (token.type !== "link" || !wanted.has(token.href)) return;
    spans.push(token.raw);
    if (!labels.has(token.href)) labels.set(token.href, token.text === token.href ? "" : token.text.trim());
  });
  for (const span of spans.sort((a, b) => b.length - a.length)) text = text.split(span).join("");
  const body = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return { body, labels };
}
