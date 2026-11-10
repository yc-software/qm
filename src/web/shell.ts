import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { analyticsHookConfig } from "../../plugins/chassis/src/analytics-config.ts";
import { browserErrorConfig } from "../../plugins/chassis/src/browser-error-config.ts";
import { injectBranding, type OrgBranding } from "../../plugins/chassis/src/branding.ts";
import { gzipAccepted, json, relayStream, sendBuffered } from "../../plugins/chassis/src/http.ts";
import { readWebBundleLayout } from "../../cli/src/web-release.ts";
import type { Config } from "../config.ts";
import { s3Client } from "../persistence/s3.ts";
import { jitteredBackoffMs } from "../util/async.ts";
import { errMessage, reportFailure } from "../util/errors.ts";
import {
  createLocalWebReleaseStore,
  createS3WebReleaseStore,
  createWebReleaseReader,
  deployBundledRelease,
  withLocalAssetCache,
  type WebReleaseStore,
} from "./releases.ts";

export interface WebReleases {
  document(name: string): Promise<string>;
  file(path: string, gzip: boolean): Promise<{ body: Readable; gzip: boolean } | null>;
}

export interface WebShell {
  serve(req: IncomingMessage, res: ServerResponse): Promise<void>;
  sharePage(res: ServerResponse, status: number, transcript: unknown): Promise<void>;
}

const BUNDLED_WEB_UI = fileURLToPath(new URL("../../plugins/web-ui/dist-web", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

const SHARE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

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

function bundledReleases(store: WebReleaseStore): WebReleases {
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
  return createWebReleaseReader(store, { bundled: () => bundled ?? publishBundled() });
}

function sharedSessionHtml(template: string, transcript: unknown): string {
  const data = JSON.stringify(transcript).replace(/</g, "\\u003c");
  return template.replace(
    /<script id="shared-transcript" type="application\/json">\s*null\s*<\/script>/,
    () => `<script id="shared-transcript" type="application/json">${data}</script>`,
  );
}

function spaCsp(env: NodeJS.ProcessEnv, frameAncestors: string): string {
  const { scriptOrigins, connectOrigins } = analyticsHookConfig(env.WEB_UI_ANALYTICS);
  const browserErrors = browserErrorConfig(env);
  const slack = env.QM_SLACK_SERVICE_URL ? ` ${new URL(env.QM_SLACK_SERVICE_URL).origin} https://slack.com` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${scriptOrigins.map((origin) => ` ${origin}`).join("")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${connectOrigins.map((origin) => ` ${origin}`).join("")}${browserErrors ? ` ${new URL(browserErrors.dsn).origin}` : ""}`,
    "frame-src 'self' data: https:",
    "worker-src 'self' blob:",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'none'",
    `form-action 'self'${slack}`,
    "object-src 'none'",
  ].join("; ");
}

export function createWebShell(
  config: Config & { publicPort: number },
  env: NodeJS.ProcessEnv,
  branding: () => Promise<OrgBranding>,
  releases: WebReleases = bundledReleases(webReleaseStore(config)),
): WebShell {
  const csp = spaCsp(env, "'self'");
  const appsDomain = (config.deployAppsDomain ?? "").toLowerCase();
  const security = (headers: Record<string, string>, policy = csp): Record<string, string> => ({
    ...headers,
    "content-security-policy": policy,
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "referrer-policy": env.QM_SLACK_SERVICE_URL ? "strict-origin" : "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
  });
  const branded = async (html: string) => injectBranding(html, await branding(), { titleSuffix: "· Web" });

  function unavailable(res: ServerResponse, what: string, error: unknown): void {
    console.error(`[web] ${what} unavailable: ${errMessage(error)}`);
    reportFailure("web.release_unavailable", error);
    if (!res.headersSent)
      json(res, 503, { error: "web_ui_unavailable", message: "The web UI release is unavailable." });
    else res.destroy();
  }

  async function document(res: ServerResponse, policy: string): Promise<void> {
    let html: string;
    try {
      html = await releases.document("index.html");
    } catch (error) {
      return unavailable(res, "index.html", error);
    }
    const { "x-frame-options": framing, ...headers } = security(
      { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      policy,
    );
    if (policy === csp) headers["x-frame-options"] = framing!;
    else res.removeHeader("x-frame-options");
    sendBuffered(res, 200, headers, await branded(html));
  }

  async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return json(res, 400, { error: "bad_request" });
    }
    const rel = posix.normalize(decoded).replace(/^\/+/, "");
    if (rel === ".." || rel.startsWith("../") || rel.includes("\\")) return json(res, 403, { error: "forbidden" });
    if (rel.includes("\0")) return json(res, 404, { error: "not_found" });
    if (!extname(rel) || rel === "index.html") return document(res, csp);
    let found: Awaited<ReturnType<WebReleases["file"]>>;
    try {
      found = await releases.file(rel, gzipAccepted(res.req));
    } catch (error) {
      return unavailable(res, rel, error);
    }
    if (!found) return json(res, 404, { error: "not_found" });
    const headers = security({
      "content-type": CONTENT_TYPES[extname(rel)] ?? "application/octet-stream",
      "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      vary: "accept-encoding",
    });
    res.writeHead(200, found.gzip ? { ...headers, "content-encoding": "gzip" } : headers);
    relayStream(found.body, res, {
      onError: (error) => console.error(`[web] streaming ${rel} failed: ${errMessage(error)}`),
    });
  }

  async function manifest(res: ServerResponse): Promise<void> {
    const name = (await branding()).selfLabel || "QM";
    const body = {
      name,
      short_name: name,
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "any",
      background_color: "#ffffff",
      theme_color: "#ffffff",
      icons: [
        {
          src: env.PORTAL_FAVICON_SVG ? "/favicon.svg" : "/brand-mark.svg",
          sizes: "any",
          type: "image/svg+xml",
          purpose: "any maskable",
        },
      ],
    };
    res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" });
    res.end(JSON.stringify(body));
  }

  return {
    async serve(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (req.method !== "GET" || path.startsWith("/api/")) return json(res, 404, { error: "not found" });
      if (path === "/manifest.webmanifest") return manifest(res);
      const slug = (url.searchParams.get("slug") ?? "").toLowerCase();
      if (path === "/app-edit" && appsDomain && /^[a-z0-9-]{1,63}$/.test(slug))
        return document(res, spaCsp(env, `'self' ${slug}.${appsDomain}`));
      return serveStatic(res, path === "/" ? "/index.html" : path);
    },
    async sharePage(res, status, transcript) {
      let template: string;
      try {
        template = await releases.document("shared.html");
      } catch (error) {
        return unavailable(res, "shared.html", error);
      }
      res.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
        "content-security-policy": SHARE_CSP,
      });
      res.end(sharedSessionHtml(await branded(template), transcript));
    },
  };
}
