import type { Server } from "node:http";
import type { CoreHandoff } from "../../plugins/portal/src/index.ts";
import { apiAlias, sessionCookieTenant } from "../api/browser-session.ts";
import { sessionLifetime } from "../../plugins/portal/src/session.ts";
import { bootTenant } from "../tenants/boot.ts";
import { inTenant } from "../tenants/claim.ts";
import type { Config } from "../config.ts";
import type { WebShell } from "./shell.ts";

interface PortalSurface {
  startServer(options: { port: number; host?: string; core: CoreHandoff }): Promise<void>;
  server: Server;
}

export async function startFrontDoor(
  config: Config & { publicPort: number },
  env: NodeJS.ProcessEnv,
  core: Server,
  shell: WebShell,
): Promise<{ close(): void }> {
  const secret = env.PORTAL_SESSION_SECRET;
  if (!secret) throw new Error("PORTAL_SESSION_SECRET is required to serve the public port");
  env.CORE_API_URL = `http://127.0.0.1:${config.port}`;
  env.CORE_ORG_ID = config.orgId;
  env.PUBLIC_WEB_URL = config.publicWebUrl ?? `http://localhost:${config.publicPort}`;
  if (config.deployAppsDomain) env.PORTAL_APPS_DOMAIN ||= config.deployAppsDomain;
  const portal = (await import("../../plugins/portal/src/index.ts")) as PortalSurface;
  await portal.startServer({
    port: config.publicPort,
    core: {
      serves: (method, pathname) => apiAlias(method, pathname) !== null,
      handle: (req, res) => void core.emit("request", req, res),
      shell: (req, res) => {
        const tenant = sessionCookieTenant(req, secret, sessionLifetime(env).max) ?? bootTenant();
        return tenant ? inTenant(tenant, () => shell.serve(req, res)) : shell.serve(req, res);
      },
    },
  });
  return {
    close() {
      portal.server.close();
      portal.server.closeAllConnections();
    },
  };
}
