const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const LABEL_RE = new RegExp(`^${LABEL}$`);
const HOSTNAME_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);

export function isDnsLabel(value: string): boolean {
  return LABEL_RE.test(value);
}

export function isDnsHostname(value: string): boolean {
  return HOSTNAME_RE.test(value);
}

function hostnameIn(url: URL): string | undefined {
  const host = url.hostname.replace(/\.$/, "");
  return isDnsHostname(host) ? host : undefined;
}

export function hostOfUrl(raw: string | undefined): string | undefined {
  if (!raw || !URL.canParse(raw)) return undefined;
  return hostnameIn(new URL(raw));
}

export function hostOfHeader(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value || !URL.canParse(`http://${value}`)) return undefined;
  const url = new URL(`http://${value}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
  return hostnameIn(url);
}

export function tenantAppsSubdomain(env: NodeJS.ProcessEnv): string | undefined {
  const label = env.DEPLOY_APPS_TENANT_SUBDOMAIN?.trim().toLowerCase();
  if (!label) return undefined;
  if (!isDnsLabel(label))
    throw new Error(
      `DEPLOY_APPS_TENANT_SUBDOMAIN (${label}) must be one DNS label, like apps — each tenant then serves apps at <app>.${label}.<tenant host>.`,
    );
  return label;
}

export function parseTenantAppHost(
  rawHost: string | undefined,
  label: string,
): { host: string; app: string; tenantHost: string } | undefined {
  const host = hostOfHeader(rawHost);
  if (!host) return undefined;
  const marker = `.${label}.`;
  const at = host.indexOf(marker);
  if (at <= 0) return undefined;
  const app = host.slice(0, at);
  const tenantHost = host.slice(at + marker.length);
  if (!isDnsLabel(app) || !isDnsHostname(tenantHost)) return undefined;
  return { host, app, tenantHost };
}
