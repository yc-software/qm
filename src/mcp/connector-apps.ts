import type { McpServer, McpServerApp } from "./mcp-server-store.ts";

const TOOLKIT_ID = /^[a-z0-9_-]{1,100}$/;

export function isToolkitId(value: unknown): value is string {
  return typeof value === "string" && TOOLKIT_ID.test(value);
}

export function isReturnParam(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function connectLink(app: McpServerApp, returnUrl: string | undefined): string {
  if (!app.returnParam || !returnUrl) return app.connectUrl;
  const url = new URL(app.connectUrl);
  url.searchParams.set(app.returnParam, returnUrl);
  return url.href;
}

export function connectedServices(text: string): { connected: Set<string>; unavailable: string[] } {
  const parsed: unknown = JSON.parse(text);
  const services = (parsed as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) throw new Error("status tool answered without services");
  const entries = services.map((service: unknown) => (service ?? {}) as Record<string, unknown>);
  const ids = (key: string) => entries.filter((s) => isToolkitId(s.id) && s[key] === true).map((s) => s.id as string);
  return { connected: new Set(ids("connected")), unavailable: ids("unavailable") };
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
    return app ? { ...item, ...linkOf(app) } : item;
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
          ...linkOf(app),
        }))
    : [];
  return [...unlisted, ...listed];
}

function linkOf(app: ConnectorApp) {
  return {
    connectUrl: app.connectUrl,
    ...(app.returnParam ? { returnParam: app.returnParam } : {}),
    connector: app.connector,
  };
}
