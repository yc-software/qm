import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { text } from "node:stream/consumers";
import { createUiReleases } from "../server/ui-releases.ts";

const BASE = "https://releases.example";
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";

function bucket(objects: Map<string, string | number>) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const path = String(input).slice(BASE.length);
    requests.push(path);
    const object = objects.get(path);
    if (typeof object === "number") return new Response("unavailable", { status: object });
    return object === undefined ? new Response("missing", { status: 404 }) : new Response(object);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function response() {
  const body = new PassThrough();
  const sent: { status?: number; headers?: Record<string, string> } = {};
  const res = Object.assign(body, {
    writeHead(status: number, headers: Record<string, string>) {
      sent.status = status;
      sent.headers = headers;
      return res;
    },
  });
  return { res: res as unknown as ServerResponse, sent, body: text(body) };
}

test("documents come from the release the live pointer names", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const objects = new Map<string, string | number>([
    ["/channels/live.json", JSON.stringify({ id: A })],
    [`/releases/${A}/index.html`, "<html>A</html>"],
    [`/releases/${B}/index.html`, "<html>B</html>"],
  ]);
  const { fetchImpl, requests } = bucket(objects);
  const releases = createUiReleases(`${BASE}/`, fetchImpl);
  assert.equal(await releases.document("index.html"), "<html>A</html>");
  objects.set("/channels/live.json", JSON.stringify({ id: B }));
  assert.equal(await releases.document("index.html"), "<html>A</html>");
  assert.equal(requests.filter((path) => path === "/channels/live.json").length, 1);
  t.mock.timers.tick(10_000);
  assert.equal(await releases.document("index.html"), "<html>B</html>");
});

test("an unreadable pointer keeps serving the last release, but never invents one", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const objects = new Map<string, string | number>([[`/releases/${A}/index.html`, "<html>A</html>"]]);
  const { fetchImpl } = bucket(objects);
  const releases = createUiReleases(BASE, fetchImpl);
  await assert.rejects(releases.document("index.html"), /channels\/live\.json: HTTP 404/);
  objects.set("/channels/live.json", JSON.stringify({ id: A }));
  assert.equal(await releases.document("index.html"), "<html>A</html>");
  objects.set("/channels/live.json", 503);
  t.mock.timers.tick(10_000);
  assert.equal(await releases.document("index.html"), "<html>A</html>");
  objects.set("/channels/live.json", JSON.stringify({ id: "../../etc" }));
  t.mock.timers.tick(10_000);
  assert.equal(await releases.document("index.html"), "<html>A</html>");
});

test("assets relay the precompressed copy when the browser accepts gzip", async () => {
  const objects = new Map<string, string | number>([
    ["/assets/main-1.js", "plain"],
    ["/assets/main-1.js.gz", "packed"],
    ["/assets/only-raw.js", "raw"],
  ]);
  const releases = createUiReleases(BASE, bucket(objects).fetchImpl);
  const headers = { "content-type": "text/javascript; charset=utf-8" };

  const gzip = response();
  assert.equal(await releases.relayAsset(gzip.res, "/assets/main-1.js", headers, true), true);
  assert.equal(await gzip.body, "packed");
  assert.equal(gzip.sent.headers?.["content-encoding"], "gzip");

  const plain = response();
  assert.equal(await releases.relayAsset(plain.res, "/assets/main-1.js", headers, false), true);
  assert.equal(await plain.body, "plain");
  assert.equal(plain.sent.headers?.["content-encoding"], undefined);

  const fallback = response();
  assert.equal(await releases.relayAsset(fallback.res, "/assets/only-raw.js", headers, true), true);
  assert.equal(await fallback.body, "raw");

  assert.equal(await releases.relayAsset(response().res, "/assets/missing.js", headers, true), false);
});
