export const SERVICE_NAMES = ["core", "egress-proxy"] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export const isServiceName = (s: string): s is ServiceName => (SERVICE_NAMES as readonly string[]).includes(s);

export const VIRTUAL_SERVICE_NAMES = ["slack", "auth"] as const;
export type VirtualServiceName = (typeof VIRTUAL_SERVICE_NAMES)[number];
export type DeclaredServiceName = ServiceName | VirtualServiceName;

export const isVirtualService = (s: string): s is VirtualServiceName =>
  (VIRTUAL_SERVICE_NAMES as readonly string[]).includes(s);
export const isDeclaredService = (s: string): s is DeclaredServiceName => isServiceName(s) || isVirtualService(s);

export const PUBLIC_PORT = 8000;

export function serviceHost(name: string): string {
  return isVirtualService(name) ? "core" : name;
}

export const runnableServices = (names: readonly DeclaredServiceName[]): ServiceName[] =>
  [...new Set(names.map(serviceHost))].filter(isServiceName);

export function hostedServiceEnv(
  services: readonly DeclaredServiceName[],
  env: Partial<Record<DeclaredServiceName, Record<string, string>>>,
  host: string,
): Record<string, string> {
  if (host === "core" || serviceHost(host) !== host) return { ...env[host as DeclaredServiceName] };
  const out: Record<string, string> = {};
  for (const service of services.filter((name) => serviceHost(name) === host)) {
    for (const [name, value] of Object.entries(env[service] ?? {})) {
      if (name === "PORT") continue;
      if (out[name] !== undefined && out[name] !== value) {
        throw new Error(`Conflicting ${name} settings in services hosted by ${host}`);
      }
      out[name] = value;
    }
  }
  return out;
}

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
  hasAuth: boolean;
  authAllowedEmailDomain?: string;
  brand?: BrandEnv;
  coreUrl: string;
}

interface FlyServiceSpec {
  managed: (s: ServiceCtx) => Record<string, string>;
  stackKeys: string[];
  deployFlags: string[];
  publicIngress?: boolean;
}

export interface ServiceDef {
  name: ServiceName;
  readiness: RegExp;
  order: number;
  dev?: {
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
  tcpIngress?: { healthCheck: string[] };
}

export interface BrandEnv {
  botName?: string;
  orgName?: string;
}

export const brandEnvOf = (c: { botName?: string; orgName?: string }): BrandEnv | undefined =>
  c.botName || c.orgName
    ? { ...(c.botName ? { botName: c.botName } : {}), ...(c.orgName ? { orgName: c.orgName } : {}) }
    : undefined;

export function orgEnv(service: string, orgId: string, publicUrl: string, brand?: BrandEnv): Record<string, string> {
  const base = publicUrl.replace(/\/$/, "");
  const identity: Record<string, string> = service === "core" ? { ORG_ID: orgId } : { CORE_ORG_ID: orgId };
  if (service === "core") {
    return {
      ...identity,
      PUBLIC_PORT: String(PUBLIC_PORT),
      PUBLIC_WEB_URL: base,
      ...(brand?.botName ? { ORG_BRAND_SELF_LABEL: brand.botName, AUTH_BRAND_NAME: brand.botName } : {}),
      ...(brand?.orgName ? { ORG_BRAND_ORG_NAME: brand.orgName } : {}),
    };
  }
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

export function brokerWiring(o: { publicUrl: string; allowedEmailDomain?: string }): Record<string, string> {
  const base = o.publicUrl.replace(/\/$/, "");
  const issuer = `${base}${AUTH_PATH_PREFIX}`;
  return {
    AUTH_BROKER_UPSTREAM: "http://127.0.0.1:8099",
    AUTH_EMBEDDED: "1",
    AUTH_ISSUER: issuer,
    AUTH_CLIENT_ID,
    AUTH_REDIRECT_URI: `${base}/auth/callback`,
    AUTH_BROKER_PREFIX: AUTH_PATH_PREFIX,
    OIDC_CLIENT_ID: AUTH_CLIENT_ID,
    OIDC_ISSUER: issuer,
    OIDC_AUTH_ENDPOINT: `${issuer}/authorize`,
    OIDC_TOKEN_ENDPOINT: "http://127.0.0.1:8099/token",
    OIDC_USERINFO_ENDPOINT: "http://127.0.0.1:8099/userinfo",
    OIDC_JWKS_URI: "http://127.0.0.1:8099/.well-known/jwks.json",
    OIDC_SCOPES: "openid email",
    OIDC_PRINCIPAL_CLAIM: "email",
    ...(o.allowedEmailDomain
      ? { OIDC_ALLOWED_EMAIL_DOMAIN: o.allowedEmailDomain, AUTH_ALLOWED_EMAIL_DOMAIN: o.allowedEmailDomain }
      : {}),
  };
}

const brokerEnv = (s: ServiceCtx): Record<string, string> =>
  s.hasAuth
    ? brokerWiring({
        publicUrl: s.publicUrl,
        ...(s.authAllowedEmailDomain ? { allowedEmailDomain: s.authAllowedEmailDomain } : {}),
      })
    : {};

const pluginWiring = (service: string, s: ServiceCtx): Record<string, string> => ({
  CORE_API_URL: s.coreUrl,
  ...orgEnv(service, s.orgId, s.publicUrl, s.brand),
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
        ...orgEnv("core", s.orgId, s.publicUrl, s.brand),
        ...brokerEnv(s),
        FLY_DEPLOY_APP_PREFIX: s.deployAppPrefix,
      }),
      stackKeys: [
        "SNAPSHOT_STORE",
        "TRANSFER_STORE",
        "S3_BUCKET",
        "S3_REGION",
        "PUBLIC_WEB_URL",
        "FLY_ORG",
        "PI_DETECT_MODEL",
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
        "OIDC_PROMPT",
        "AUTH_BROKER_UPSTREAM",
        "AUTH_BROKER_PREFIX",
        "AUTH_ISSUER",
        "AUTH_CLIENT_ID",
        "AUTH_REDIRECT_URI",
        "AUTH_EMAIL_TRANSPORT",
        "AUTH_BRAND_NAME",
        "AUTH_ALLOWED_EMAIL_DOMAIN",
        "SMTP_PORT",
        "SMTP_TLS",
      ],
      deployFlags: ["--ha=false"],
      publicIngress: true,
    },
  },
  "egress-proxy": {
    name: "egress-proxy",
    readiness: /starting main dispatch loop/,
    order: 50,
    docker: { image: "egress-proxy", internalPort: 48080, portEnv: "PORT", hostPortOffset: 4 },
    fly: {
      managed: (s) => pluginWiring("egress-proxy", s),
      stackKeys: [],
      deployFlags: ["--ha=false"],
      publicIngress: true,
    },
    tcpIngress: {
      healthCheck: [
        "CMD",
        "node",
        "-e",
        "require('net').connect(48081,'127.0.0.1').on('connect',()=>require('http').get({socketPath:'/tmp/envoy-admin.sock',path:'/ready'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))).on('error',()=>process.exit(1))",
      ],
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
