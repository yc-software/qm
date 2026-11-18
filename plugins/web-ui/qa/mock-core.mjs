#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { preview } from "vite";

const { values: o } = parseArgs({
  options: {
    dist: { type: "string", default: "dist-web" },
    fixtures: { type: "string", default: "fixtures.json" },
    port: { type: "string", default: "8080" },
  },
});
const fixtures = JSON.parse(readFileSync(o.fixtures, "utf8"));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const recorded = new Set(
  fixtures.flatMap((f) => `${f.path} ${f.requestBody ?? ""}`.match(UUID) ?? []).map((id) => id.toLowerCase()),
);
const toRecorded = new Map();
const toLive = new Map();
const swap = (text, ids) => text.replace(UUID, (id) => ids.get(id.toLowerCase()) ?? id);
const template = (text) => text.replace(UUID, ":id");
const query = (params) =>
  [...params]
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
const bind = (live, old) => {
  const ids = old.match(UUID) ?? [];
  (live.match(UUID) ?? []).forEach((id, i) => {
    if (!ids[i] || recorded.has(id.toLowerCase())) return;
    toRecorded.set(id.toLowerCase(), ids[i].toLowerCase());
    toLive.set(ids[i].toLowerCase(), id);
  });
};

const queues = new Map();
const enqueue = (key, f) => {
  const queue = queues.get(key) ?? { list: [], next: 0 };
  queue.list.push(f);
  queues.set(key, queue);
};
const exact = (method, path, search) => `${method} ${path}?${query(new URLSearchParams(search))}`;
const loose = (method, path, search) => template(exact(method, path, search));
for (const f of fixtures) {
  enqueue(exact(f.method, f.path, f.query), f);
  enqueue(loose(f.method, f.path, f.query), f);
}
const take = (queue) => queue.list[Math.min(queue.next++, queue.list.length - 1)];

async function replayStream(res, f) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let elapsed = 0;
  for (const [ms, text] of f.chunks) {
    await new Promise((r) => setTimeout(r, ms - elapsed));
    elapsed = ms;
    res.write(swap(text, toLive));
  }
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15000);
  res.on("close", () => clearInterval(keepalive));
}

async function replay(req, res, next) {
  const url = new URL(req.url, "http://mock");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  const method = req.method;
  const path = swap(url.pathname, toRecorded);
  const search = swap(url.search, toRecorded);
  const queue = queues.get(exact(method, path, search)) ?? queues.get(loose(method, path, search));
  if (queue) {
    const f = take(queue);
    bind(`${url.pathname} ${url.search}`, `${f.path} ${f.query}`);
    if (f.requestBody && body) bind(body, f.requestBody);
    if (f.contentType.includes("event-stream")) return replayStream(res, f);
    res.writeHead(f.status, { "content-type": f.contentType });
    return res.end(swap(f.body, toLive));
  }
  if (!["/api/", "/v1/", "/auth/"].some((prefix) => url.pathname.startsWith(prefix))) return next();
  console.error(`MISS ${method} ${url.pathname}${url.search}`);
  res.writeHead(method === "GET" ? 404 : 200, { "content-type": "application/json" });
  res.end(method === "GET" ? '{"error":"mock-core: no fixture"}' : "{}");
}

const server = await preview({
  root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  logLevel: "warn",
  build: { outDir: resolve(o.dist) },
  preview: { port: Number(o.port), strictPort: true },
  plugins: [{ name: "mock-core", configurePreviewServer: (s) => void s.middlewares.use(replay) }],
});
console.log(`mock-core: ${resolve(o.dist)} with ${fixtures.length} fixtures on ${server.resolvedUrls.local[0]}`);
