import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

interface HostedSurface {
  startServer(port: number, host?: string): Promise<Server>;
}

const hosted = (path: string): Promise<HostedSurface> =>
  import(new URL(path, import.meta.url).href) as Promise<HostedSurface>;

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

export async function startFrontDoor(
  opts: { apiPort: number; publicPort: number; orgId: string; host?: string },
  env: NodeJS.ProcessEnv,
): Promise<{ close(): Promise<void> }> {
  env.CORE_API_URL = `http://127.0.0.1:${opts.apiPort}`;
  env.CORE_ORG_ID = opts.orgId;
  env.PORTAL_PUBLIC_URL ||= `http://localhost:${opts.publicPort}`;
  env.WEB_UI_PUBLIC_URL ||= env.PORTAL_PUBLIC_URL;
  const web = await hosted("../../plugins/web-ui/server/index.ts");
  const webServer = await web.startServer(0, "127.0.0.1");
  const webUrl = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
  env.WEB_UI_UPSTREAM = webUrl;
  env.ADMIN_UPSTREAM = `${webUrl}/admin`;
  const portal = await hosted("../../plugins/portal/src/index.ts");
  const portalServer = await portal.startServer(opts.publicPort, opts.host).catch(async (error: unknown) => {
    await closeServer(webServer);
    throw error;
  });
  return {
    async close() {
      await Promise.all([closeServer(portalServer), closeServer(webServer)]);
    },
  };
}
