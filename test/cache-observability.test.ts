import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { cacheHitRatio, isStablePrefixMiss } from "../src/admin/metrics-sink.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { testConfig } from "./support/test-config.ts";

function loadViewerCacheHelpers(): {
  callCacheUsage: (q: unknown) => { cacheRead: number; cacheWrite: number; uncachedInput: number } | null;
  sumCacheUsage: (rs: unknown[]) => { cacheRead: number; cacheWrite: number; uncachedInput: number } | null;
  viewerCacheHitRatio: (u: unknown) => number | null;
  viewerIsStablePrefixMiss: (u: unknown) => boolean;
  cacheMetaItems: (u: unknown) => Array<{ textContent: string; className: string }>;
} {
  const htmlPath = fileURLToPath(new URL("../plugins/admin/public/index.html", import.meta.url));
  const html = readFileSync(htmlPath, "utf8");
  const grab = (name: string): string => {
    const start = html.indexOf("function " + name + "(");
    if (start < 0) throw new Error("viewer helper not found: " + name);
    let i = html.indexOf("{", start);
    let depth = 0;
    for (; i < html.length; i++) {
      if (html[i] === "{") depth++;
      else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error("unterminated viewer helper: " + name);
  };
  const src = [
    grab("callCacheUsage"),
    grab("sumCacheUsage"),
    grab("cacheHitRatio"),
    grab("isStablePrefixMiss"),
    grab("metaChip"),
    grab("cacheMetaItems"),
  ].join("\n");
  const factory = new Function(
    "document",
    "fmtPct",
    "fmtTokens",
    `${src}\nreturn { callCacheUsage, sumCacheUsage, viewerCacheHitRatio: cacheHitRatio, viewerIsStablePrefixMiss: isStablePrefixMiss, cacheMetaItems };`,
  ) as (
    document: { createElement: (tag: string) => { tagName: string; className: string; textContent: string } },
    fmtPct: (n: number) => string,
    fmtTokens: (n: number) => string,
  ) => ReturnType<typeof loadViewerCacheHelpers>;
  return factory(
    { createElement: (tag: string) => ({ tagName: tag.toUpperCase(), className: "", textContent: "" }) },
    (n: number) => ((n || 0) * 100).toFixed(1) + "%",
    (n: number) => String(n) + " tokens",
  );
}

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "cache-obs-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    metrics: built.metrics,
    runs: built.runs,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE = { "x-admin-actor": "admin-alice@default-org" };
const getJson = async (base: string, path: string, headers: Record<string, string> = ALICE): Promise<any> =>
  (await fetch(base + path, { headers })).json();

test("cacheHitRatio: read / (read + write + uncached); null when there's no telemetry", () => {
  assert.equal(cacheHitRatio({ cacheRead: 100, cacheWrite: 0, uncachedInput: 0 }), 1);
  assert.equal(cacheHitRatio({ cacheRead: 0, cacheWrite: 100, uncachedInput: 0 }), 0);
  assert.equal(cacheHitRatio({ cacheRead: 80, cacheWrite: 10, uncachedInput: 10 }), 0.8);
  assert.equal(cacheHitRatio({}), null);
  assert.equal(cacheHitRatio({ cacheRead: 0, cacheWrite: 0, uncachedInput: 0 }), null);
});

test("isStablePrefixMiss: flags a big-write/near-zero-read turn, not a small cold seed", () => {
  assert.equal(isStablePrefixMiss({ cacheRead: 0, cacheWrite: 50_000, uncachedInput: 100 }), true);
  assert.equal(isStablePrefixMiss({ cacheRead: 50_000, cacheWrite: 0, uncachedInput: 100 }), false);
  assert.equal(isStablePrefixMiss({ cacheRead: 0, cacheWrite: 200, uncachedInput: 50 }), false);
  assert.equal(isStablePrefixMiss({}), null);
});

test("metrics: the cache aggregate reflects warm turns and flags a stable-prefix miss", async () => {
  const s = start();
  try {
    const warm1: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:w1" },
      text: "hello there",
    };
    const warm2: TurnRequest = {
      surface: "test",
      actor: { externalId: "U2" },
      conversation: { kind: "dm", threadRef: "dm:U2:w2" },
      text: "how are you",
    };
    const miss: TurnRequest = {
      surface: "test",
      actor: { externalId: "U3" },
      conversation: { kind: "dm", threadRef: "dm:U3:m1" },
      text: "!cachemiss",
    };
    assert.equal((await s.built.app.turn(warm1)).status, "ok");
    assert.equal((await s.built.app.turn(warm2)).status, "ok");
    assert.equal((await s.built.app.turn(miss)).status, "ok");

    const m = await getJson(s.base, "/v1/admin/metrics?scope=org:default-org");
    assert.ok(m.cache, "the metrics response carries a cache block");
    assert.equal(m.cache.samples, 3, "all three turns carried cache telemetry");
    assert.ok(m.cache.avgHitRatio > 0.5 && m.cache.avgHitRatio < 1, "avg hit ratio is the blend of warm + miss turns");
    assert.ok(
      m.cache.pooledHitRatio > 0 && m.cache.pooledHitRatio <= 1,
      "pooled (token-weighted) ratio is a real fraction",
    );
    assert.equal(m.cache.missTurns, 1, "exactly the one re-prefilled turn is a miss");
    assert.ok(Math.abs(m.cache.missRate - 1 / 3) < 1e-9, "miss rate = miss turns / turns-with-telemetry");
    assert.ok(m.cache.cacheReadTotal > 0, "warm turns contributed cache reads");
    assert.ok(m.cache.cacheWriteTotal > 0, "the miss turn contributed a cache write");
  } finally {
    await s.close();
  }
});

test("metrics: empty scope yields a present-but-empty cache block (null ratios, not an error)", async () => {
  const s = start();
  try {
    const m = await getJson(s.base, "/v1/admin/metrics?scope=personal:nobody");
    assert.ok(m.cache, "cache block is always present");
    assert.equal(m.cache.samples, 0);
    assert.equal(m.cache.avgHitRatio, null, "no turns ⇒ null ratio (UI renders —), not 0");
    assert.equal(m.cache.pooledHitRatio, null);
    assert.equal(m.cache.missRate, null);
    assert.equal(m.cache.missTurns, 0);
    assert.equal(m.cache.cacheReadTotal, 0);
  } finally {
    await s.close();
  }
});

test("history /llm: per-call usage (cacheRead/cacheWrite) is plumbed through to the viewer", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:llm" },
      text: "what's the weather",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    const sess = await getJson(s.base, "/v1/admin/sessions?scope=org:default-org");
    const conv = sess.sessions[0];

    const d = await getJson(s.base, `/v1/admin/sessions/${encodeURIComponent(conv.id)}/llm?scope=org:default-org`);
    assert.ok(d.requests.length >= 1, "at least one captured request");
    const req = d.requests[0]!;
    assert.ok(req.usage && typeof req.usage === "object", "the captured request carries provider usage");
    assert.equal(typeof req.usage.cacheRead, "number", "cacheRead is exposed per call");
    assert.equal(typeof req.usage.cacheWrite, "number", "cacheWrite is exposed per call");
    assert.equal(typeof req.usage.input, "number", "non-cached input is exposed per call");
    assert.ok(req.usage.cacheRead > 0, "a warm turn served input from the prefix");
    assert.equal(req.usage.cacheWrite, 0, "a warm turn wrote nothing to the cache");
    const ratio = cacheHitRatio({
      cacheRead: req.usage.cacheRead,
      cacheWrite: req.usage.cacheWrite,
      uncachedInput: req.usage.input,
    });
    assert.ok(ratio !== null && ratio > 0.5, "the call's hit ratio is high (warm)");
    assert.equal(
      isStablePrefixMiss({
        cacheRead: req.usage.cacheRead,
        cacheWrite: req.usage.cacheWrite,
        uncachedInput: req.usage.input,
      }),
      false,
    );
  } finally {
    await s.close();
  }
});

test("viewer: per-call usage maps to a usage block; the per-turn rollup sums across calls", () => {
  const v = loadViewerCacheHelpers();
  assert.deepEqual(v.callCacheUsage({ usage: { input: 10, cacheRead: 90, cacheWrite: 0 } }), {
    cacheRead: 90,
    cacheWrite: 0,
    uncachedInput: 10,
  });
  assert.equal(v.callCacheUsage({}), null, "a request with no usage has no cache block");
  assert.deepEqual(
    v.sumCacheUsage([
      { usage: { input: 10, cacheRead: 90, cacheWrite: 0 } },
      { usage: { input: 5, cacheRead: 0, cacheWrite: 5 } },
      {},
    ]),
    { cacheRead: 90, cacheWrite: 5, uncachedInput: 15 },
  );
  assert.equal(v.sumCacheUsage([{}, {}]), null, "a turn with no usage on any call has no rollup");
});

test("viewer: the ratio + miss math matches the server's canonical helpers", () => {
  const v = loadViewerCacheHelpers();
  for (const u of [
    { cacheRead: 100, cacheWrite: 0, uncachedInput: 0 },
    { cacheRead: 0, cacheWrite: 50_000, uncachedInput: 100 },
    { cacheRead: 80, cacheWrite: 10, uncachedInput: 10 },
  ]) {
    assert.equal(v.viewerCacheHitRatio(u), cacheHitRatio(u), "viewer ratio == server ratio");
    assert.equal(v.viewerIsStablePrefixMiss(u), isStablePrefixMiss(u) === true, "viewer miss == server miss");
  }
});

test("viewer: cache metadata flags a stable-prefix miss with danger styling, and is quiet when warm", () => {
  const v = loadViewerCacheHelpers();
  const warm = v.cacheMetaItems({ cacheRead: 90, cacheWrite: 0, uncachedInput: 10 });
  assert.ok(
    warm.some((b) => b.textContent.startsWith("cache ") && b.className === "meta-chip"),
    "warm turn shows a quiet ratio metric",
  );
  assert.ok(!warm.some((b) => b.textContent.includes("stable-prefix miss")), "warm turn has no miss flag");
  const miss = v.cacheMetaItems({ cacheRead: 0, cacheWrite: 50_000, uncachedInput: 100 });
  assert.ok(
    miss.some((b) => b.textContent.startsWith("cache ") && b.className.includes("danger")),
    "miss turn's ratio metric is marked dangerous",
  );
  const loud = miss.find((b) => b.textContent.includes("stable-prefix miss"));
  assert.ok(loud && loud.className.includes("danger"), "a stable-prefix-miss danger label is shown");
  assert.deepEqual(v.cacheMetaItems(null), []);
});
