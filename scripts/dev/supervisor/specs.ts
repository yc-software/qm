import type { ChildSpec, SlotPorts } from "../lib/types.ts";

export interface SpecInputs {
  worktree: string;
  ports: SlotPorts;
  baseEnv: Record<string, string>;
  watch: boolean;
  web?: boolean;
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
  const publicUrl = `http://localhost:${i.ports.portal}`;
  const edge: Record<string, string> =
    i.web === false
      ? {}
      : {
          PUBLIC_PORT: String(i.ports.portal),
          PORTAL_PUBLIC_URL: publicUrl,
          PORTAL_SESSION_SECRET: i.portalSessionSecret,
          PORTAL_LOCAL_AUTH_BYPASS: i.baseEnv.PORTAL_LOCAL_AUTH_BYPASS ?? "1",
          PORTAL_DEV_PRINCIPAL: i.portalDevPrincipal,
          WEB_UI_BASE: i.webUiBasePath,
          WEB_UI_PRINCIPALS: "",
          WEB_UI_PUBLIC_URL: publicUrl,
          ...(i.watch ? { WEB_UI_DEV: "1" } : {}),
        };
  return [
    {
      name: "core",
      cwd: i.worktree,
      argv: ["node", "--env-file-if-exists=.env", ...watchArgs, "src/index.ts"],
      env: {
        ...base,
        ...signing,
        ORG_ID: orgId,
        SESSION_STORE: i.sessionStore,
        RUN_STORE: i.runStore,
        PORT: String(i.ports.core),
        ...(i.databaseUrl ? { DATABASE_URL: i.databaseUrl } : {}),
        ...(i.adminGrantsSeed ? { ADMIN_GRANTS: i.adminGrantsSeed } : {}),
        PUBLIC_WEB_URL: i.web === false ? "" : publicUrl,
        ...(i.slack
          ? {
              SLACK_BOT_TOKEN: i.slack.botToken,
              SLACK_APP_TOKEN: i.slack.appToken,
              DEV_INTROSPECTION: "1",
              DEV_HEALTH_PORT: String(i.ports.slackHealth),
            }
          : { SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "" }),
        DEV_INSTANCE_NO_SLACK: i.slack ? "0" : "1",
        CORE_ORG_ID: orgId,
        SHUTDOWN_DRAIN_MS: "2000",
        ...edge,
      },
      port: i.ports.core,
      readiness: {
        kind: "log",
        pattern: i.web === false ? `listening on :${i.ports.core}` : `public front door on ${publicUrl}`,
      },
      health: { kind: "tcp", port: i.web === false ? i.ports.core : i.ports.portal },
      stopGraceMs: 15_000,
    },
  ];
}
