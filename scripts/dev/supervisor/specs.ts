import { join } from "node:path";
import type { ChildSpec, SlotPorts } from "../lib/types.ts";

export interface SpecInputs {
  worktree: string;
  ports: SlotPorts;
  baseEnv: Record<string, string>;
  watch: boolean;
  webUiBasePath: string;
  slack?: { botToken: string; appToken: string };
  sessionStore: string;
  runStore: string;
  databaseUrl: string;
  adminGrantsSeed: string;
  coreSigningSecret: string;
  portalSessionSecret: string;
  portalDevPrincipal: string;
  sandboxEnv: Record<string, string>;
}

export function buildChildSpecs(i: SpecInputs): ChildSpec[] {
  const watchArgs = i.watch ? ["--watch"] : [];
  const base = { ...i.baseEnv, ...i.sandboxEnv };
  const orgId = i.baseEnv.DEV_INSTANCE_ORG_ID || "acme";
  const signing: Record<string, string> = i.coreSigningSecret ? { CORE_SIGNING_SECRET: i.coreSigningSecret } : {};
  const portalUrl = `http://localhost:${i.ports.portal}`;
  const authUrl = `http://localhost:${i.ports.auth}`;
  return [
    {
      name: "core",
      cwd: i.worktree,
      argv: ["node", "--env-file-if-exists=.env", ...watchArgs, "src/index.ts"],
      env: {
        ...base,
        ORG_ID: orgId,
        SESSION_STORE: i.sessionStore,
        RUN_STORE: i.runStore,
        PORT: String(i.ports.core),
        ...(i.databaseUrl ? { DATABASE_URL: i.databaseUrl } : {}),
        ...(i.adminGrantsSeed ? { ADMIN_GRANTS: i.adminGrantsSeed } : {}),
        PUBLIC_WEB_URL: `http://localhost:${i.ports.portal}`,
        AUTH_SERVICE_URL: authUrl,
        ...(i.slack
          ? {
              SLACK_BOT_TOKEN: i.slack.botToken,
              SLACK_APP_TOKEN: i.slack.appToken,
              DEV_INTROSPECTION: "1",
              DEV_HEALTH_PORT: String(i.ports.slackHealth),
            }
          : {}),
        CORE_ORG_ID: orgId,
        SHUTDOWN_DRAIN_MS: "2000",
      },
      port: i.ports.core,
      readiness: { kind: "log", pattern: `listening on :${i.ports.core}` },
      health: { kind: "tcp", port: i.ports.core },
      stopGraceMs: 15_000,
    },
    {
      name: "auth",
      cwd: join(i.worktree, "plugins/auth"),
      argv: ["node", ...watchArgs, "src/index.ts"],
      env: {
        ...base,
        ...signing,
        PORT: String(i.ports.auth),
        CORE_API_URL: `http://localhost:${i.ports.core}`,
        CORE_ORG_ID: orgId,
        AUTH_ISSUER: `${portalUrl}/idp`,
        AUTH_CLIENT_ID: "qm-portal",
        AUTH_CLIENT_SECRET: i.baseEnv.AUTH_CLIENT_SECRET ?? "",
        AUTH_REDIRECT_URI: `${portalUrl}/auth/callback`,
        AUTH_SIGNING_JWK: i.baseEnv.AUTH_SIGNING_JWK ?? "",
        AUTH_TOKEN_SECRET: i.baseEnv.AUTH_TOKEN_SECRET ?? "",
        NODE_ENV: "development",
      },
      port: i.ports.auth,
      readiness: { kind: "log", pattern: `http://localhost:${i.ports.auth}` },
      health: { kind: "healthz", url: `${authUrl}/healthz` },
      stopGraceMs: 5_000,
    },
    {
      name: "web",
      cwd: join(i.worktree, "plugins/web-ui"),
      argv: ["node", "--env-file-if-exists=.env", "server/index.ts"],
      env: {
        ...base,
        ...signing,
        PORT: String(i.ports.web),
        CORE_API_URL: `http://localhost:${i.ports.core}`,
        WEB_UI_BASE: i.webUiBasePath,
        ...(i.watch ? { WEB_UI_DEV: "1" } : {}),
        CORE_ORG_ID: orgId,
        WEB_UI_PRINCIPALS: "",
        WEB_UI_PUBLIC_URL: `http://localhost:${i.ports.portal}`,
      },
      port: i.ports.web,
      readiness: { kind: "log", pattern: `surface on http://localhost:${i.ports.web}` },
      health: { kind: "tcp", port: i.ports.web },
      stopGraceMs: 5_000,
    },
    {
      name: "admin",
      cwd: join(i.worktree, "plugins/admin"),
      argv: ["node", `--env-file-if-exists=${join(i.worktree, ".env")}`, ...watchArgs, "src/index.ts"],
      env: {
        ...base,
        ...signing,
        PORT: String(i.ports.admin),
        CORE_API_URL: `http://localhost:${i.ports.core}`,
        CORE_ORG_ID: orgId,
        ADMIN_BASE_PATH: "/admin",
      },
      port: i.ports.admin,
      readiness: { kind: "log", pattern: `http://localhost:${i.ports.admin}` },
      health: { kind: "tcp", port: i.ports.admin },
      stopGraceMs: 5_000,
    },
    {
      name: "portal",
      cwd: join(i.worktree, "plugins/portal"),
      argv: ["node", ...watchArgs, "src/index.ts"],
      env: {
        ...base,
        ...signing,
        PORT: String(i.ports.portal),
        PORTAL_PUBLIC_URL: `http://localhost:${i.ports.portal}`,
        CORE_API_URL: `http://localhost:${i.ports.core}`,
        CORE_ORG_ID: orgId,
        WEB_UI_UPSTREAM: `http://localhost:${i.ports.web}`,
        ADMIN_UPSTREAM: `http://localhost:${i.ports.admin}`,
        PORTAL_SESSION_SECRET: i.portalSessionSecret,
        NODE_ENV: "development",
        PORTAL_LOCAL_AUTH_BYPASS: i.baseEnv.DEV_INSTANCE_PORTAL_AUTH_BYPASS ?? "1",
        PORTAL_DEV_PRINCIPAL: i.portalDevPrincipal,
        AUTH_BROKER_UPSTREAM: authUrl,
        AUTH_BROKER_PREFIX: "/idp",
        OIDC_CLIENT_ID: "qm-portal",
        OIDC_CLIENT_SECRET: i.baseEnv.AUTH_CLIENT_SECRET ?? "",
        OIDC_ISSUER: `${portalUrl}/idp`,
        OIDC_AUTH_ENDPOINT: `${portalUrl}/idp/authorize`,
        OIDC_TOKEN_ENDPOINT: `${authUrl}/token`,
        OIDC_USERINFO_ENDPOINT: `${authUrl}/userinfo`,
        OIDC_JWKS_URI: `${authUrl}/.well-known/jwks.json`,
        OIDC_SCOPES: "openid email",
        OIDC_PRINCIPAL_CLAIM: "email",
      },
      port: i.ports.portal,
      readiness: { kind: "log", pattern: `public front door on http://localhost:${i.ports.portal}` },
      health: { kind: "tcp", port: i.ports.portal },
      stopGraceMs: 5_000,
    },
  ];
}
