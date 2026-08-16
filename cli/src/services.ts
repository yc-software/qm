export const SERVICE_NAMES = ["core", "web-ui", "admin", "portal", "auth"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export const isServiceName = (s: string): s is ServiceName => (SERVICE_NAMES as readonly string[]).includes(s);

export const VIRTUAL_SERVICE_NAMES = ["slack"] as const;
export type VirtualServiceName = (typeof VIRTUAL_SERVICE_NAMES)[number];
export type DeclaredServiceName = ServiceName | VirtualServiceName;

export const isVirtualService = (s: string): s is VirtualServiceName =>
  (VIRTUAL_SERVICE_NAMES as readonly string[]).includes(s);
export const isDeclaredService = (s: string): s is DeclaredServiceName => isServiceName(s) || isVirtualService(s);

export const runnableServices = (names: readonly DeclaredServiceName[]): ServiceName[] => names.filter(isServiceName);

export function virtualServiceEnv(
  services: readonly DeclaredServiceName[],
  env: Partial<Record<DeclaredServiceName, Record<string, string>>>,
): Record<string, string> {
  return Object.assign({}, ...services.filter(isVirtualService).map((s) => env[s] ?? {}));
}

const RESERVED_CONTAINER_NAMES: readonly string[] = [...SERVICE_NAMES, ...VIRTUAL_SERVICE_NAMES, "pg", "sandbox"];
export const isReservedContainerName = (name: string): boolean => RESERVED_CONTAINER_NAMES.includes(name);

export function pluginNameError(name: string): string | null {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    return "must be a lowercase DNS label (a-z, 0-9, and hyphens between) — the fly target uses it as the app name <appPrefix>-<name>";
  }
  if (isReservedContainerName(name)) {
    return `collides with a built-in container (reserved: ${RESERVED_CONTAINER_NAMES.join(", ")}) — choose another name`;
  }
  return null;
}

export interface LogOpts {
  follow?: boolean;
  tail?: number;
}

export interface ServiceCtx {
  appPrefix: string;
  orgId: string;
  deployAppPrefix: string;
  publicUrl: string;
  hasPortal: boolean;
  hasAuth: boolean;
  authAllowedEmailDomain?: string;
  brand?: BrandEnv;
  /** Provider-supplied internal URL other services use to reach core. */
  coreUrl: string;
  /** Provider-supplied internal base URL of the auth service. */
  authUrl: string;
}

interface FlyServiceSpec {
  managed: (s: ServiceCtx) => Record<string, string>;
  stackKeys: string[];
  deployFlags: string[];
  flycast?: boolean;
}

export interface ServiceDef {
  name: ServiceName;
  readiness: RegExp;
  order: number;
  dev: {
    cwd: string;
    entry: string[];
    portEnv?: "PORT";
    portSlotOffset?: number;
  };
  docker: {
    image: ServiceName;
    internalPort: number;
    portEnv: "PORT";
    hostPortOffset?: number;
  };
  fly?: FlyServiceSpec;
}

export interface BrandEnv {
  botName?: string;
  orgName?: string;
}

export const brandEnvOf = (c: { botName?: string; orgName?: string }): BrandEnv | undefined =>
  c.botName || c.orgName
    ? { ...(c.botName ? { botName: c.botName } : {}), ...(c.orgName ? { orgName: c.orgName } : {}) }
    : undefined;

export function orgEnv(
  service: string,
  orgId: string,
  publicUrl: string,
  hasPortal: boolean,
  brand?: BrandEnv,
): Record<string, string> {
  const base = publicUrl.replace(/\/$/, "");
  const identity: Record<string, string> = service === "core" ? { ORG_ID: orgId } : { CORE_ORG_ID: orgId };
  const webUiUrl = base;
  if (service === "core") {
    return {
      ...identity,
      PUBLIC_WEB_URL: base,
      WEB_UI_PUBLIC_URL: webUiUrl,
      ...(brand?.botName ? { ORG_BRAND_SELF_LABEL: brand.botName } : {}),
      ...(brand?.orgName ? { ORG_BRAND_ORG_NAME: brand.orgName } : {}),
    };
  }
  if (service === "web-ui") return { ...identity, WEB_UI_PUBLIC_URL: webUiUrl };
  if (service === "portal") return { ...identity, PORTAL_PUBLIC_URL: base };
  if (service === "admin" && hasPortal) return { ...identity, ADMIN_BASE_PATH: "/admin" };
  if (service === "auth") return { ...identity, ...(brand?.botName ? { AUTH_BRAND_NAME: brand.botName } : {}) };
  return identity;
}

const AUTH_PATH_PREFIX = "/idp";
const AUTH_CLIENT_ID = "qm-portal";

export const AUTH_BROKER_ENV_KEYS = [
  "AUTH_BROKER_UPSTREAM",
  "AUTH_BROKER_PREFIX",
  "OIDC_CLIENT_ID",
  "OIDC_ISSUER",
  "OIDC_AUTH_ENDPOINT",
  "OIDC_TOKEN_ENDPOINT",
  "OIDC_USERINFO_ENDPOINT",
  "OIDC_JWKS_URI",
  "OIDC_SCOPES",
  "OIDC_PRINCIPAL_CLAIM",
  "OIDC_ALLOWED_EMAIL_DOMAIN",
] as const;

export function brokerWiring(
  service: string,
  o: { publicUrl: string; authBaseUrl: string; allowedEmailDomain?: string },
): Record<string, string> {
  const base = o.publicUrl.replace(/\/$/, "");
  const internal = o.authBaseUrl.replace(/\/$/, "");
  const issuer = `${base}${AUTH_PATH_PREFIX}`;
  if (service === "portal") {
    return {
      AUTH_BROKER_UPSTREAM: internal,
      AUTH_BROKER_PREFIX: AUTH_PATH_PREFIX,
      OIDC_CLIENT_ID: AUTH_CLIENT_ID,
      OIDC_ISSUER: issuer,
      OIDC_AUTH_ENDPOINT: `${issuer}/authorize`,
      OIDC_TOKEN_ENDPOINT: `${internal}/token`,
      OIDC_USERINFO_ENDPOINT: `${internal}/userinfo`,
      OIDC_JWKS_URI: `${internal}/.well-known/jwks.json`,
      OIDC_SCOPES: "openid email",
      OIDC_PRINCIPAL_CLAIM: "email",
      ...(o.allowedEmailDomain ? { OIDC_ALLOWED_EMAIL_DOMAIN: o.allowedEmailDomain } : {}),
    };
  }
  if (service === "auth") {
    return {
      AUTH_ISSUER: issuer,
      AUTH_CLIENT_ID,
      AUTH_REDIRECT_URI: `${base}/auth/callback`,
    };
  }
  return {};
}

const pluginWiring = (service: string, s: ServiceCtx): Record<string, string> => ({
  CORE_API_URL: s.coreUrl,
  ...orgEnv(service, s.orgId, s.publicUrl, s.hasPortal, s.brand),
  ...(s.hasAuth
    ? brokerWiring(service, {
        publicUrl: s.publicUrl,
        authBaseUrl: s.authUrl,
        ...(s.authAllowedEmailDomain ? { allowedEmailDomain: s.authAllowedEmailDomain } : {}),
      })
    : {}),
});

const CATALOG: Record<ServiceName, ServiceDef> = {
  core: {
    name: "core",
    readiness: /listening on :\d+/,
    order: 0,
    dev: { cwd: ".", entry: ["--env-file-if-exists=.env", "src/index.ts"], portEnv: "PORT", portSlotOffset: 0 },
    docker: { image: "core", internalPort: 8080, portEnv: "PORT", hostPortOffset: 0 },
    fly: {
      managed: (s) => ({
        ...orgEnv("core", s.orgId, s.publicUrl, s.hasPortal, s.brand),
        FLY_DEPLOY_APP_PREFIX: s.deployAppPrefix,
      }),
      stackKeys: [
        "SNAPSHOT_STORE",
        "TRANSFER_STORE",
        "S3_BUCKET",
        "S3_REGION",
        "PUBLIC_WEB_URL",
        "FLY_ORG",
        "FLY_DEPLOY_BASE_IMAGE",
        "PI_DETECT_MODEL",
      ],
      deployFlags: ["--ha=false"],
    },
  },
  "web-ui": {
    name: "web-ui",
    readiness: /surface on http/,
    order: 20,
    dev: {
      cwd: "plugins/web-ui",
      entry: ["--env-file-if-exists=.env", "server/index.ts"],
      portEnv: "PORT",
      portSlotOffset: 16,
    },
    docker: { image: "web-ui", internalPort: 8080, portEnv: "PORT", hostPortOffset: 2 },
    fly: {
      managed: (s) => pluginWiring("web-ui", s),
      stackKeys: ["WEB_UI_PUBLIC_URL"],
      deployFlags: ["--ha=false", "--flycast", "--no-public-ips"],
      flycast: true,
    },
  },
  admin: {
    name: "admin",
    readiness: /\[admin-plugin\] http/,
    order: 30,
    dev: { cwd: "plugins/admin", entry: ["src/index.ts"], portEnv: "PORT", portSlotOffset: 32 },
    docker: { image: "admin", internalPort: 8080, portEnv: "PORT", hostPortOffset: 3 },
    fly: {
      managed: (s) => pluginWiring("admin", s),
      stackKeys: ["ADMIN_BASE_PATH"],
      deployFlags: ["--ha=false"],
    },
  },
  portal: {
    name: "portal",
    readiness: /public front door on/,
    order: 40,
    dev: { cwd: "plugins/portal", entry: ["src/index.ts"], portEnv: "PORT", portSlotOffset: 48 },
    docker: { image: "portal", internalPort: 8080, portEnv: "PORT", hostPortOffset: 1 },
    fly: {
      managed: (s) => ({
        ...pluginWiring("portal", s),
        WEB_UI_UPSTREAM: `http://${s.appPrefix}-web-ui.flycast`,
        ADMIN_UPSTREAM: `http://${s.appPrefix}-admin.internal:8080`,
      }),
      stackKeys: [
        "PORTAL_PUBLIC_URL",
        "OIDC_CLIENT_ID",
        "OIDC_ALLOWED_EMAILS",
        "OIDC_ALLOWED_EMAIL_DOMAIN",
        "PORTAL_EXPECTED_TEAM_ID",
        "OIDC_AUTH_ENDPOINT",
        "OIDC_TOKEN_ENDPOINT",
        "OIDC_USERINFO_ENDPOINT",
        "OIDC_ISSUER",
        "OIDC_JWKS_URI",
        "OIDC_SCOPES",
        "OIDC_PRINCIPAL_CLAIM",
        "AUTH_BROKER_UPSTREAM",
        "AUTH_BROKER_PREFIX",
      ],
      deployFlags: ["--ha=false"],
    },
  },
  auth: {
    name: "auth",
    readiness: /sign-in broker on/,
    order: 35,
    dev: { cwd: "plugins/auth", entry: ["src/index.ts"], portEnv: "PORT", portSlotOffset: 64 },
    docker: { image: "auth", internalPort: 8080, portEnv: "PORT" },
    fly: {
      managed: (s) => pluginWiring("auth", s),
      stackKeys: [
        "AUTH_ISSUER",
        "AUTH_CLIENT_ID",
        "AUTH_REDIRECT_URI",
        "AUTH_EMAIL_TRANSPORT",
        "AUTH_BRAND_NAME",
        "AUTH_ALLOWED_EMAIL_DOMAIN",
        "SMTP_PORT",
        "SMTP_TLS",
      ],
      deployFlags: ["--ha=false", "--flycast", "--no-public-ips"],
      flycast: true,
    },
  },
};

export const serviceDef = (name: ServiceName): ServiceDef => CATALOG[name];

export function ordered(names: ServiceName[]): ServiceDef[] {
  return names.map(serviceDef).sort((a, b) => a.order - b.order);
}

export function teardownOrdered(names: ServiceName[]): ServiceDef[] {
  return ordered(names).reverse();
}
