import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

interface HostedSurface {
  startServer(port: number, host?: string): Promise<Server>;
}

const hosted = (path: string): Promise<HostedSurface> =>
  import(new URL(path, import.meta.url).href) as Promise<HostedSurface>;

export async function startWebEdge(
  opts: { publicPort: number; corePort: number; orgId: string },
  env: NodeJS.ProcessEnv,
): Promise<Server[]> {
  env.CORE_API_URL = `http://127.0.0.1:${opts.corePort}`;
  env.CORE_ORG_ID = opts.orgId;
  const web = await hosted("../plugins/web-ui/server/index.ts");
  const webServer = await web.startServer(0, "127.0.0.1");
  const webUrl = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
  env.WEB_UI_UPSTREAM = webUrl;
  env.ADMIN_UPSTREAM = `${webUrl}/admin`;
  const portal = await hosted("../plugins/portal/src/index.ts");
  return [webServer, await portal.startServer(opts.publicPort)];
}
