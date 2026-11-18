#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const { values: o } = parseArgs({
  options: {
    url: { type: "string" },
    flow: { type: "string" },
    out: { type: "string", default: "qa-out" },
    label: { type: "string", default: "run" },
    fixtures: { type: "string" },
  },
});
if (!o.url || !o.flow) {
  console.error(
    "usage: record-flow.mjs --url <web ui> --flow <flow.mjs> [--out dir] [--label name] [--fixtures fixtures.json]",
  );
  process.exit(2);
}

const out = resolve(o.out);
mkdirSync(out, { recursive: true });
const size = { width: 1440, height: 900 };
const videoDir = join(out, `.video-${o.label}`);
const failure = (e) => e?.stack ?? String(e);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: size,
  recordVideo: { dir: videoDir, size, showActions: { cursor: "pointer", position: "top" } },
});
const report = {
  url: o.url,
  flow: o.flow,
  label: o.label,
  ok: true,
  steps: [],
  pageErrors: [],
  failedRequests: [],
  captureErrors: [],
};

const streams = [];
if (o.fixtures) {
  await context.exposeBinding("__qaStream", (_source, id, url, ms, text, error) => {
    const stream = streams.find((s) => s.id === id) ?? streams[streams.push({ id, url, chunks: [] }) - 1];
    if (error) report.captureErrors.push(`${url}: ${error}`);
    else stream.chunks.push([ms, text]);
  });
  await context.addInitScript(() => {
    const fetch = window.fetch;
    let n = 0;
    window.fetch = async (...args) => {
      const res = await fetch(...args);
      if (!(res.headers.get("content-type") ?? "").includes("event-stream") || !res.body) return res;
      const [page, copy] = res.body.tee();
      const id = `${Date.now()}-${n++}`;
      const reader = copy.getReader();
      const decoder = new TextDecoder();
      const opened = performance.now();
      const elapsed = () => Math.round(performance.now() - opened);
      const pump = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          await window.__qaStream(id, res.url, elapsed(), decoder.decode(value, { stream: true }));
        }
      };
      window.__qaStream(id, res.url, 0, "");
      pump().catch((e) => e.name !== "AbortError" && window.__qaStream(id, res.url, elapsed(), "", String(e)));
      return new Response(page, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
  });
}

const page = await context.newPage();
page.on("pageerror", (e) => report.pageErrors.push(failure(e)));
page.on("requestfailed", (r) => {
  if (r.failure()?.errorText !== "net::ERR_ABORTED")
    report.failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`);
});
const fixtures = [];
page.on("response", (r) => {
  const request = r.request();
  if (r.status() >= 500) report.failedRequests.push(`${request.method()} ${r.url()} HTTP ${r.status()}`);
  if (!o.fixtures) return;
  const url = new URL(r.url());
  const contentType = r.headers()["content-type"] ?? "";
  const api = ["/api/", "/v1/", "/auth/"].some((prefix) => url.pathname.startsWith(prefix));
  if (!api && !contentType.includes("json") && !contentType.includes("event-stream")) return;
  const fixture = {
    url: r.url(),
    method: request.method(),
    path: url.pathname,
    query: url.search.slice(1),
    status: r.status(),
    contentType,
    ...(request.postData() ? { requestBody: request.postData() } : {}),
  };
  if (contentType.includes("event-stream")) return fixtures.push(fixture);
  fixtures.push(
    r.body().then(
      (body) => ({ ...fixture, body: body.toString("utf8") }),
      (e) => {
        report.captureErrors.push(`${r.url()}: ${failure(e)}`);
        return { ...fixture, body: "" };
      },
    ),
  );
});

async function step(name, fn) {
  const n = report.steps.length + 1;
  const started = Date.now();
  const row = { n, name, ok: true, screenshot: join(out, `${o.label}-${String(n).padStart(2, "0")}.png`) };
  report.steps.push(row);
  const caption = await page.screencast.showOverlay(
    `<div style="position:fixed;left:50%;bottom:14px;transform:translateX(-50%);font:600 15px system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.75);padding:6px 12px;border-radius:6px">${n}. ${name}</div>`,
  );
  try {
    await fn();
    await page.waitForTimeout(400);
  } catch (e) {
    Object.assign(row, { ok: false, error: failure(e) });
    throw e;
  } finally {
    row.ms = Date.now() - started;
    await page.screenshot({ path: row.screenshot }).catch((e) => (row.screenshotError = failure(e)));
    await caption[Symbol.asyncDispose]().catch((e) => (row.cleanupError = failure(e)));
  }
}

const flow = (await import(pathToFileURL(resolve(o.flow)).href)).default;
try {
  await page.goto(o.url, { waitUntil: "domcontentloaded" });
  await flow({ page, step });
  await page.waitForTimeout(800);
} catch (e) {
  report.ok = false;
  report.error = failure(e);
}

const recorded = await Promise.all(fixtures);
const video = page.video();
await context.close();
await browser.close();
if (o.fixtures) {
  for (const f of recorded.filter((f) => f.contentType.includes("event-stream"))) {
    const i = streams.findIndex((s) => s.url === f.url);
    if (i < 0)
      report.captureErrors.push(`${f.url}: body not captured (only fetch() streams are recorded, not EventSource)`);
    f.chunks = i < 0 ? [] : streams.splice(i, 1)[0].chunks;
  }
  writeFileSync(o.fixtures, JSON.stringify(recorded.map(({ url: _url, ...f }) => f)));
}
const webm = join(out, `${o.label}.webm`);
try {
  renameSync(await video.path(), webm);
  report.video = join(out, `${o.label}.mp4`);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    webm,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-crf",
    "28",
    "-preset",
    "veryfast",
    "-movflags",
    "+faststart",
    report.video,
  ]);
  rmSync(webm);
  rmSync(videoDir, { recursive: true, force: true });
} catch (e) {
  report.videoError = failure(e);
}
writeFileSync(join(out, `${o.label}-report.json`), JSON.stringify(report, null, 2));
for (const s of report.steps)
  console.log(
    `${s.ok ? "PASS" : "FAIL"} ${s.n}. ${s.name} (${s.ms} ms)${s.error ? `: ${s.error.split("\n")[0]}` : ""}`,
  );
if (report.error && report.steps.every((s) => s.ok)) console.log(`FAIL ${report.error.split("\n")[0]}`);
console.log(
  `page errors ${report.pageErrors.length}, failed requests ${report.failedRequests.length}, capture errors ${report.captureErrors.length}`,
);
if (o.fixtures) console.log(`fixtures ${resolve(o.fixtures)} (${recorded.length} responses)`);
console.log(report.videoError ? `video failed: ${report.videoError.split("\n")[0]}` : `video ${report.video}`);
console.log(`report ${join(out, `${o.label}-report.json`)}`);
process.exit(report.ok ? 0 : 1);
