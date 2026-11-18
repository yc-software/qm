import type { McpServer, McpServerApp } from "./mcp-server-store.ts";

const TOOLKIT_ID = /^[a-z0-9_-]{1,100}$/;

export function isToolkitId(value: unknown): value is string {
  return typeof value === "string" && TOOLKIT_ID.test(value);
}

export interface ConnectorApp extends McpServerApp {
  connector: string;
}

export interface CatalogApp {
  id: string;
  logoUrl: string;
  name: string;
  description: string;
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
