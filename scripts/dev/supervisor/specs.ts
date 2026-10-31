import type { ChildSpec, SlotPorts } from "../lib/types.ts";

export interface SpecInputs {
  worktree: string;
  ports: SlotPorts;
  baseEnv: Record<string, string>;
  watch: boolean;
  web?: boolean;
  webUiBasePath: string;
  slack?: { botToken: string; appToken: string };
  databaseUrl: string;
  adminGrantsSeed: string;
  portalSessionSecret: string;
  portalDevPrincipal: string;
  sandboxEnv: Record<string, string>;
}

export function buildChildSpecs(i: SpecInputs): ChildSpec[] {
  const watchArgs = i.watch ? ["--watch"] : [];
  const orgId = i.baseEnv.DEV_INSTANCE_ORG_ID || "acme";
  const web = i.web !== false;
  const publicUrl = `http://localhost:${i.ports.portal}`;
  const shared: Record<string, string> = {
    ...i.baseEnv,
    ...i.sandboxEnv,
    ORG_ID: orgId,
    CORE_ORG_ID: orgId,
    ...(i.databaseUrl ? { DATABASE_URL: i.databaseUrl } : {}),
    ...(i.adminGrantsSeed ? { ADMIN_GRANTS: i.adminGrantsSeed } : {}),
    PUBLIC_WEB_URL: web ? publicUrl : "",
    SHUTDOWN_DRAIN_MS: "2000",
  };
  const frontDoor: Record<string, string> = web
    ? {
        PUBLIC_PORT: String(i.ports.portal),
        PORTAL_PUBLIC_URL: publicUrl,
        PORTAL_SESSION_SECRET: i.portalSessionSecret,
        PORTAL_LOCAL_AUTH_BYPASS: i.baseEnv.PORTAL_LOCAL_AUTH_BYPASS ?? "1",
        PORTAL_DEV_PRINCIPAL: i.portalDevPrincipal,
        WEB_UI_BASE: i.webUiBasePath,
        WEB_UI_PUBLIC_URL: publicUrl,
        WEB_UI_PRINCIPALS: "",
        ...(i.watch ? { WEB_UI_DEV: "1" } : {}),
      }
    : {};
  return [
    {
      name: "edge",
      cwd: i.worktree,
      argv: ["node", "--env-file-if-exists=.env", ...watchArgs, "src/edge/main.ts"],
      env: {
        ...shared,
        PORT: String(i.ports.core),
        ...frontDoor,
        ...(i.slack
          ? {
              SLACK_BOT_TOKEN: i.slack.botToken,
              SLACK_APP_TOKEN: i.slack.appToken,
              DEV_INTROSPECTION: "1",
              DEV_HEALTH_PORT: String(i.ports.slackHealth),
            }
          : { SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "" }),
        DEV_INSTANCE_NO_SLACK: i.slack ? "0" : "1",
      },
      port: i.ports.core,
      readiness: {
        kind: "log",
        pattern: web ? `public front door on ${publicUrl}` : `listening on :${i.ports.core}`,
      },
      health: { kind: "tcp", port: i.ports.core },
      stopGraceMs: 15_000,
    },
    {
      name: "harness",
      cwd: i.worktree,
      argv: ["node", "--env-file-if-exists=.env", ...watchArgs, "src/harness/main.ts"],
      env: {
        ...shared,
        PORT: String(i.ports.harness),
        SLACK_BOT_TOKEN: "",
        SLACK_APP_TOKEN: "",
        DEV_INSTANCE_NO_SLACK: "1",
      },
      port: i.ports.harness,
      readiness: { kind: "log", pattern: `listening on :${i.ports.harness}` },
      health: { kind: "tcp", port: i.ports.harness },
      stopGraceMs: 15_000,
    },
  ];
}
