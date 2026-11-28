import { reportFailure } from "../../util/errors.ts";
import type { ApiCtx, Route } from "./route.ts";

const DESKTOP_RELEASES = "https://github.com/yc-software/qm/releases";
const DESKTOP_FEED = `${DESKTOP_RELEASES}/download/desktop-updates/RELEASES.json`;

type DesktopFeed = { currentRelease?: string; releases?: Array<{ version?: string; updateTo?: { url?: string } }> };

export async function currentDesktopDownload(fetchFeed: typeof fetch = fetch): Promise<string> {
  const response = await fetchFeed(DESKTOP_FEED);
  if (!response.ok) throw new Error(`desktop release feed returned HTTP ${response.status}`);
  const feed = (await response.json()) as DesktopFeed;
  const url = feed.releases?.find((release) => release.version === feed.currentRelease)?.updateTo?.url;
  if (!url?.startsWith(`${DESKTOP_RELEASES}/download/desktop-v`))
    throw new Error(`desktop release feed names no download for ${feed.currentRelease}`);
  return url;
}

async function download(ctx: ApiCtx): Promise<void> {
  const url = await currentDesktopDownload().catch((error: unknown) => {
    reportFailure("desktop download", error);
    return DESKTOP_RELEASES;
  });
  ctx.res.writeHead(302, { location: url, "cache-control": "no-store" }).end();
}

export const desktopDownloadRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/web/desktop/download", auth: "public", tenant: "none", handle: download },
];
