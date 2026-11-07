import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { CoreHandoff } from "../../plugins/portal/src/index.ts";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiAlias } from "../api/browser-session.ts";
import type { Config } from "../config.ts";
import { s3Client } from "../persistence/s3.ts";
import { jitteredBackoffMs } from "../util/async.ts";
import { reportFailure } from "../util/errors.ts";
import { readWebBundleLayout } from "../../cli/src/web-release.ts";
import {
  createLocalWebReleaseStore,
  createS3WebReleaseStore,
  createWebReleaseReader,
  deployBundledRelease,
  withLocalAssetCache,
  type WebReleaseStore,
} from "./releases.ts";
import type { WebReleases } from "../../plugins/web-ui/server/index.ts";

interface WebSurface {
  startServer(options: { port: number; host: string; releases: WebReleases }): Promise<Server>;
}

interface PortalSurface {
  startServer(options: { port: number; host?: string; core: CoreHandoff }): Promise<void>;
  server: Server;
}

const BUNDLED_WEB_UI = fileURLToPath(new URL("../../plugins/web-ui/dist-web", import.meta.url));

function webReleaseStore(config: Config): WebReleaseStore {
  return config.snapshotStore === "s3" && config.s3Bucket
    ? withLocalAssetCache(
        createS3WebReleaseStore({
          bucket: config.s3Bucket,
          ...(config.s3Endpoint ? { _client: s3Client(config.s3Region, { endpoint: config.s3Endpoint }) } : {}),
          ...(config.s3Region ? { region: config.s3Region } : {}),
          ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
        }),
        join(tmpdir(), "qm-web-ui-assets"),
      )
    : createLocalWebReleaseStore(join(config.dataDir, "web-ui"));
}

export async function startFrontDoor(
  config: Config & { publicPort: number },
  env: NodeJS.ProcessEnv,
  core: Server,
): Promise<{ close(): void }> {
  if (!env.PORTAL_SESSION_SECRET) throw new Error("PORTAL_SESSION_SECRET is required to serve the public port");
  const store = webReleaseStore(config);
  const bundle = existsSync(join(BUNDLED_WEB_UI, "index.html")) ? readWebBundleLayout(BUNDLED_WEB_UI) : undefined;
  if (!bundle) console.log(`[web] this build carries no web UI bundle at ${BUNDLED_WEB_UI}; serving the live release`);
  let bundled: string | undefined;
  let publishing: Promise<void> | undefined;
  let failures = 0;
  let retryAt = 0;
  const publishBundled = (): string | undefined => {
    if (!bundle || Date.now() < retryAt) return undefined;
    publishing ??= deployBundledRelease(store, BUNDLED_WEB_UI, bundle)
      .then(
        (result) => {
          bundled = result.id;
          console.log(
            `[web] bundled web UI release ${result.id} ${result.uploaded ? "uploaded to" : "already in"} ${store.describe()}; live release ${result.live}`,
          );
        },
        (error: unknown) => {
          retryAt = Date.now() + jitteredBackoffMs(++failures);
          reportFailure("web.bundled_release_publish", error);
        },
      )
      .finally(() => {
        publishing = undefined;
      });
    return bundled;
  };
  publishBundled();
  env.CORE_API_URL = `http://127.0.0.1:${config.port}`;
  env.CORE_ORG_ID = config.orgId;
  env.PUBLIC_WEB_URL = config.publicWebUrl ?? `http://localhost:${config.publicPort}`;
  if (config.deployAppsDomain) env.PORTAL_APPS_DOMAIN ||= config.deployAppsDomain;
  const web = (await import("../../plugins/web-ui/server/index.ts")) as WebSurface;
  const webServer = await web.startServer({
    port: 0,
    host: "127.0.0.1",
    releases: createWebReleaseReader(store, { bundled: () => bundled ?? publishBundled() }),
  });
  env.WEB_UI_UPSTREAM = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
  const portal = (await import("../../plugins/portal/src/index.ts")) as PortalSurface;
  try {
    await portal.startServer({
      port: config.publicPort,
      core: {
        serves: (method, pathname) => apiAlias(method, pathname) !== null,
        handle: (req, res) => void core.emit("request", req, res),
      },
    });
  } catch (error) {
    webServer.close();
    webServer.closeAllConnections();
    throw error;
  }
  const servers = [portal.server, webServer];
  return {
    close() {
      for (const server of servers) {
        server.close();
        server.closeAllConnections();
      }
    },
  };
}
