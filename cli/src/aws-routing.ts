import type { QmConfig } from "./config.ts";

export const validAlbHostname = (value: string): boolean =>
  value.length <= 253 &&
  value.includes(".") &&
  value
    .split(".")
    .every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));

export function awsPortalAppsDomain(config: QmConfig): string | undefined {
  if (!config.aws?.services.portal) return undefined;
  const domain = config.env.portal?.PORTAL_APPS_DOMAIN?.trim().toLowerCase().replace(/\.$/, "");
  if (!domain) return undefined;
  const coreDomain = (config.env.core?.DEPLOY_APPS_DOMAIN || config.env.core?.AWS_DEPLOY_APPS_DOMAIN)
    ?.trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const company = new URL(config.publicUrl).hostname.toLowerCase();
  if (!validAlbHostname(domain) || domain !== coreDomain || !domain.endsWith(`.${company}`)) {
    throw new Error("portal apps domain must match core and remain beneath the company public hostname");
  }
  return domain;
}

export function awsCoreHostnames(config: QmConfig): string[] {
  const hosts: string[] = [];
  const normalize = (value: string, source: string): string => {
    const host = value.trim().toLowerCase().replace(/\.$/, "");
    if (!validAlbHostname(host)) {
      throw new Error(`${source} ${JSON.stringify(value)} does not derive a valid ALB host-header hostname`);
    }
    return host;
  };
  const api = config.apiUrl?.trim();
  if (api) {
    let hostname: string;
    try {
      hostname = new URL(api).hostname;
    } catch {
      throw new Error(
        `apiUrl ${JSON.stringify(api)} is not a valid URL, so the ALB host rule for the core API cannot be derived`,
      );
    }
    const apiHost = normalize(hostname, "apiUrl");
    if (apiHost !== new URL(config.publicUrl).hostname.toLowerCase().replace(/\.$/, "")) hosts.push(apiHost);
  }
  const apps = config.env.core?.DEPLOY_APPS_DOMAIN?.trim() || config.env.core?.AWS_DEPLOY_APPS_DOMAIN?.trim();
  const portalAppsDomain = awsPortalAppsDomain(config);
  if (apps && (!config.aws?.sharedAlb || apps.trim().toLowerCase().replace(/\.$/, "") !== portalAppsDomain))
    hosts.push(`*.${normalize(apps, "the apps domain (env.core.DEPLOY_APPS_DOMAIN or AWS_DEPLOY_APPS_DOMAIN)")}`);
  return [...new Set(hosts)];
}
