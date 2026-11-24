import type { McpServer, McpServerApp } from "./mcp-server-store.ts";

const TOOLKIT_ID = /^[a-z0-9_-]{1,100}$/;

export function isToolkitId(value: unknown): value is string {
  return typeof value === "string" && TOOLKIT_ID.test(value);
}

export interface ConnectorApp extends McpServerApp {
  connector: string;
}

interface KeyField {
  key: string;
  label: string;
  secret: boolean;
}

export type DirectConnect = { connect: "mcp" } | { connect: "api_key"; keyFields: KeyField[] };

export interface CatalogApp {
  id: string;
  logoUrl: string;
  name: string;
  description: string;
  connect?: DirectConnect["connect"];
  keyFields?: KeyField[];
}

const OAUTH_SCHEMES = new Set(["OAUTH1", "OAUTH2", "S2S_OAUTH2"]);
const KEY_SCHEMES = new Set(["API_KEY", "BEARER_TOKEN"]);

export function directConnect(toolkit: string, name: string, schemes: string[]): DirectConnect | null {
  if (schemes.includes("DCR_OAUTH")) return { connect: "mcp" };
  if (schemes.some((scheme) => OAUTH_SCHEMES.has(scheme))) return null;
  const upper = toolkit.toUpperCase().replaceAll("-", "_");
  const prefix = "0123456789".includes(upper[0]!) ? `APP_${upper}` : upper;
  const basic = schemes.includes("BASIC") && !schemes.some((scheme) => KEY_SCHEMES.has(scheme));
  return {
    connect: "api_key",
    keyFields: basic
      ? [
          { key: `${prefix}_USERNAME`, label: `${name} username`, secret: false },
          { key: `${prefix}_PASSWORD`, label: `${name} password`, secret: true },
        ]
      : [{ key: `${prefix}_API_KEY`, label: `${name} API key`, secret: true }],
  };
}

export function connectorApps(servers: McpServer[]): ConnectorApp[] {
  return servers.flatMap((server) =>
    server.enabled ? (server.apps ?? []).map((app) => ({ ...app, connector: server.id })) : [],
  );
}

export function withConnectorApps(items: CatalogApp[], apps: ConnectorApp[], firstPage: boolean) {
  const byToolkit = new Map(apps.map((app) => [app.toolkit, app]));
  const listed = items.map((item) => {
    const app = byToolkit.get(item.id);
    return app ? { ...item, connectUrl: app.connectUrl, connector: app.connector } : item;
  });
  const ids = new Set(items.map((item) => item.id));
  const unlisted = firstPage
    ? apps
        .filter((app) => !ids.has(app.toolkit))
        .map((app) => ({
          id: app.toolkit,
          logoUrl: `https://logos.composio.dev/api/${app.toolkit}`,
          name: app.name,
          description: "",
          connectUrl: app.connectUrl,
          connector: app.connector,
        }))
    : [];
  return [...unlisted, ...listed];
}
