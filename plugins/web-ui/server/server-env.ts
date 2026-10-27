import { portFromEnv } from "../../chassis/src/env.ts";
import { edgeTenant, tenantPublicUrl } from "../../chassis/src/tenant-hosts.ts";
import { browserErrorConfig } from "./browser-error-config.ts";
import { type ServerResponse } from "node:http";

export const PORT = portFromEnv(8096);
const PUBLIC_URL = (process.env.WEB_UI_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
export const publicUrl = (): string => {
  const tenant = edgeTenant();
  return tenant?.id ? tenantPublicUrl(tenant) : PUBLIC_URL;
};

export const faviconSvg = (): string | undefined => {
  const tenant = edgeTenant();
  return (tenant?.id ? tenant.faviconSvg : undefined) ?? process.env.WEB_UI_FAVICON_SVG;
};

const SLACK_SERVICE_URL = process.env.QM_SLACK_SERVICE_URL || undefined;
export const slackServiceUrl = (): string | undefined => {
  const tenant = edgeTenant();
  return tenant?.id && !tenant.secrets.slackServiceToken ? undefined : SLACK_SERVICE_URL;
};

export const analyticsKey = process.env.POSTHOG_API_KEY?.trim();
export const analyticsHost = new URL((analyticsKey && process.env.POSTHOG_HOST?.trim()) || "https://us.i.posthog.com");
export const analyticsConfig = analyticsKey ? { apiKey: analyticsKey, host: analyticsHost.origin } : undefined;

export const browserErrors = browserErrorConfig(process.env);
const APPS_FRAME_DOMAIN = (process.env.DEPLOY_APPS_DOMAIN ?? "").toLowerCase();
export const appsFrameDomain = (): string => {
  const tenant = edgeTenant();
  return tenant?.id ? (tenant.appsDomain ?? "").toLowerCase() : APPS_FRAME_DOMAIN;
};

export function framedByOwnSurfaces(
  res: ServerResponse,
  headers: Record<string, string>,
  csp: string,
): Record<string, string> {
  res.removeHeader("x-frame-options");
  const { "x-frame-options": _blanketDeny, ...rest } = headers;
  return { ...rest, "content-security-policy": csp };
}
