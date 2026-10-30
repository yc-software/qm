import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LRUCache } from "lru-cache";
import { ALERT_ICON, cardPage } from "../../chassis/src/card-page.ts";
import { cookie, json } from "../../chassis/src/http.ts";
import { isUiChannel, UI_CHANNEL_COOKIE, UI_RELEASE_META } from "../../chassis/src/ui-release.ts";

const MIN_UI_PROTOCOL = 1;
const IMMUTABLE = "public, max-age=31536000, immutable";

type DocumentName = "index.html" | "shared.html";

interface UiRelease {
  id: string;
  protocol: number;
}

class UiReleaseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseUiRelease(value: unknown): UiRelease {
  const { id, protocol } = (value ?? {}) as { id?: unknown; protocol?: unknown };
  if (typeof id !== "string" || !/^[a-f0-9]{8,64}$/.test(id) || !Number.isSafeInteger(protocol))
    throw new Error("release manifest needs a hex id and an integer protocol");
  return { id, protocol: protocol as number };
}

export function uiProtocolSupported(header: string | string[] | undefined): boolean {
  if (header === undefined) return true;
  const protocol = Number.parseInt(Array.isArray(header) ? (header[0] ?? "") : header, 10);
  return protocol >= MIN_UI_PROTOCOL;
}

const withReleaseMeta = (html: string, id: string | undefined): string =>
  id ? html.replace("</head>", `<meta name="${UI_RELEASE_META}" content="${id}" />\n</head>`) : html;

function localRelease(dist: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(dist, "release.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseUiRelease(JSON.parse(text)).id;
}

function bucketReleases(base: string) {
  async function get(path: string): Promise<Response | null> {
    const response = await fetch(`${base}/${path}`, { signal: AbortSignal.timeout(5_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${base}/${path}: HTTP ${response.status}`);
    return response;
  }
  const pointers = new LRUCache<string, { release: UiRelease | null }>({
    max: 200,
    ttl: 10_000,
    fetchMethod: async (channel, last) => {
      try {
        const response = await get(`channels/${channel}.json`);
        return { release: response ? parseUiRelease(await response.json()) : null };
      } catch (error) {
        console.error(
          `[web-ui] release channel ${channel} unreadable${last ? ", keeping the last pointer" : ""}:`,
          String(error),
        );
        if (last) return last;
        throw error;
      }
    },
  });
  const documents = new LRUCache<string, string>({
    max: 64,
    fetchMethod: async (key) => {
      const response = await get(`releases/${key}`);
      if (!response)
        throw new UiReleaseError(503, `Web UI release ${key.split("/")[0]} is missing ${key.split("/")[1]}.`);
      return await response.text();
    },
  });
  return {
    async document(channel: string, name: DocumentName): Promise<string> {
      const { release } = (await pointers.fetch(channel))!;
      if (!release) throw new UiReleaseError(404, `No web UI release is published on channel "${channel}".`);
      if (release.protocol < MIN_UI_PROTOCOL)
        throw new UiReleaseError(
          503,
          `Web UI release ${release.id} speaks protocol ${release.protocol}; this server needs ${MIN_UI_PROTOCOL} or newer. Publish a newer release.`,
        );
      return withReleaseMeta((await documents.fetch(`${release.id}/${name}`))!, release.id);
    },
    async relayAsset(res: ServerResponse, path: string): Promise<void> {
      const upstream = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        if (upstream.status !== 404) console.error(`[web-ui] asset ${path}: bucket answered HTTP ${upstream.status}`);
        return void json(res, upstream.status === 404 ? 404 : 502, { error: "asset_unavailable" });
      }
      res.writeHead(200, {
        "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": IMMUTABLE,
        "x-content-type-options": "nosniff",
      });
      const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
      res.on("close", () => stream.destroy());
      stream.on("error", () => res.destroy());
      stream.pipe(res);
    },
  };
}

export function createUiDocuments(dist: string, releasesUrl: string | undefined) {
  const bucket = releasesUrl ? bucketReleases(new URL(releasesUrl).href.replace(/\/$/, "")) : undefined;
  let localId: string | undefined;
  return {
    relayAsset: bucket?.relayAsset,
    async document(req: IncomingMessage, name: DocumentName): Promise<string | null> {
      const channel = cookie(req, UI_CHANNEL_COOKIE);
      if (bucket) return bucket.document(channel && isUiChannel(channel) ? channel : "live", name);
      let html: string;
      try {
        html = readFileSync(join(dist, name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      localId ??= localRelease(dist);
      return withReleaseMeta(html, localId);
    },
  };
}

export function releaseErrorPage(error: unknown): { status: number; html: string } {
  if (!(error instanceof UiReleaseError)) throw error;
  return {
    status: error.status,
    html: cardPage({
      title: "Web UI unavailable",
      heading: "Web UI unavailable",
      msg: error.message,
      icon: ALERT_ICON,
      warn: true,
      actions: `<a class="btn primary" href="/?ui=live">Open the current release</a>`,
      help: "",
    }),
  };
}
