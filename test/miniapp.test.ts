import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import {
  putMiniapp,
  MAX_MINIAPP_HTML_BYTES,
  documentHtml,
  clipMiniappTitle,
  parseMiniappView,
  skinMiniappHtml,
  assertMiniappOk,
} from "../src/miniapps/miniapp.ts";
import { createToolContext } from "../src/tools/primitives.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeId } from "../src/types.ts";
import { extractMiniapps, parseMiniappUrl, miniappActionBlocks } from "../src/slack/lib.ts";
import { cleanAgentReplyForSlack, slackSurfaceInstructions } from "../src/slack/messaging.ts";

const SECRET = "miniapp-test-secret-value-32chars!!";

test("skinMiniappHtml injects host tokens and follows the requested theme", () => {
  const light = skinMiniappHtml("<!doctype html><html><head></head><body>x</body></html>", "light");
  assert.match(light, /id="qm-miniapp-skin"/);
  assert.match(light, /--background:#ffffff/);
  assert.match(light, /overflow:hidden/);
  assert.match(light, /height:100%/);
  const dark = skinMiniappHtml(light, "dark");
  assert.equal(dark.match(/id="qm-miniapp-skin"/g)?.length, 1);
  assert.match(dark, /--background:#0a0a0a/);
  assert.doesNotMatch(dark, /--background:#ffffff/);
});

test("assertMiniappOk accepts a real playground and rejects broken ones", () => {
  assert.doesNotThrow(() => assertMiniappOk("<!doctype html><html><body><canvas id=c></canvas><script>void 0</script></body></html>"));
  assert.throws(() => assertMiniappOk("<!doctype html><html><body></body></html>"), /nothing to show/);
  assert.throws(() => assertMiniappOk("<!doctype html><html><body><canvas></canvas><script>fetch('/')</script></body></html>"), /network/);
  assert.throws(() => assertMiniappOk("<!doctype html><html><body><p>x</p><script>function (</script></body></html>"), /does not parse/);
  assert.throws(
    () => assertMiniappOk("<!doctype html><html><body><p>x</p><script src='https://x.test/a.js'></script></body></html>"),
    /inline/,
  );
});

test("parseMiniappView only accepts source", () => {
  assert.equal(parseMiniappView("source"), "source");
  assert.equal(parseMiniappView("play"), undefined);
});

test("documentHtml wraps fragments and leaves full documents alone", () => {
  const wrapped = documentHtml("Hi", "<p>x</p>");
  assert.match(wrapped, /<!doctype html>/i);
  assert.match(wrapped, /<title>Hi<\/title>/);
  const full = "<!doctype html><html><body>ok</body></html>";
  assert.equal(documentHtml("Hi", full), full);
});

test("clipMiniappTitle falls back and truncates", () => {
  assert.equal(clipMiniappTitle("  "), "Playground");
  assert.equal(clipMiniappTitle("a".repeat(90)).length, 80);
});

test("extractMiniapps strips the directive and keeps a valid url", () => {
  const r = extractMiniapps("Here you go\n[[miniapp: https://qm.test/m/abc/def | Slope]]");
  assert.equal(r.text, "Here you go");
  assert.equal(r.miniapps.length, 1);
  assert.equal(r.miniapps[0]!.title, "Slope");
  assert.equal(r.miniapps[0]!.url, "https://qm.test/m/abc/def");
  assert.equal(parseMiniappUrl("javascript:alert(1)"), null);
  assert.equal(parseMiniappUrl("/m/abc/def"), "/m/abc/def");
  assert.equal(parseMiniappUrl("https://evil.test/x"), null);
});

test("miniapp Slack buttons are url buttons", () => {
  const blocks = miniappActionBlocks([{ url: "https://qm.test/m/a/b", title: "Play" }]);
  assert.equal(blocks[0]!.type, "actions");
  const btn = (blocks[0] as { elements: Array<{ type: string; url: string }> }).elements[0]!;
  assert.equal(btn.type, "button");
  assert.equal(btn.url, "https://qm.test/m/a/b");
  assert.equal(miniappActionBlocks([{ url: "/m/a/b", title: "Play" }]).length, 0);
});

test("cleanAgentReplyForSlack strips miniapp markers and Slack does not render them", () => {
  const cleaned = cleanAgentReplyForSlack("Try this\n[[miniapp: https://qm.test/m/aa/bb | Blocks]]");
  assert.equal(cleaned.text, "Try this");
  assert.equal(cleaned.miniapps[0]!.title, "Blocks");
  assert.doesNotMatch(slackSurfaceInstructions("dm"), /\[\[miniapp:/);
});

test("putMiniapp stores HTML and GET /m/:id/:key serves it sandboxed", async () => {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  const rec = await putMiniapp(built.miniapps, {
    title: "Slope",
    html: "<canvas id=c></canvas><script>c.getContext('2d')</script>",
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    publicBase: "https://qm.test",
  });
  assert.match(rec.url, /^https:\/\/qm\.test\/m\/[0-9a-f]+\/[A-Za-z0-9_-]+$/);
  assert.match(rec.directive, /\[\[miniapp:/);

  const server = createServer(built.app, { signingSecret: SECRET, miniapps: built.miniapps });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  try {
    const path = new URL(rec.url).pathname;
    const ok = await fetch(`http://localhost:${port}${path}`);
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.match(html, /<canvas/);
    assert.match(html, /id="qm-miniapp-skin"/);
    assert.match(html, /id="qm-miniapp-probe"/);
    assert.match(html, /source:"qm-miniapp"/);
    const themed = await fetch(`http://localhost:${port}${path}?theme=dark`);
    assert.match(await themed.text(), /--background:#0a0a0a/);
    const source = await fetch(`http://localhost:${port}${path}?view=source`);
    assert.equal(source.status, 200);
    assert.match(source.headers.get("content-type") ?? "", /text\/plain/);
    const raw = await source.text();
    assert.match(raw, /<canvas/);
    assert.doesNotMatch(raw, /id="qm-miniapp-skin"/);
    const csp = ok.headers.get("content-security-policy") ?? "";
    assert.match(csp, /^sandbox\b/);
    assert.ok(!/allow-same-origin/.test(csp));
    assert.match(csp, /connect-src 'none'/);
    const miss = await fetch(`http://localhost:${port}/m/${rec.id}/wrong-key`);
    assert.equal(miss.status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("miniapp tool writes a playground and returns a directive", async () => {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  const tc = createToolContext({
    sandbox: { provision: async () => ({}) } as never,
    provision: async () => ({}) as never,
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => true,
    grantedHandles: [],
    workspace: {} as never,
    deploy: { deployOrUpdate: async () => ({ id: "x" }) } as never,
    acl: built.acl,
    createdBy: "U1",
    miniapps: built.miniapps,
    publicWebUrl: "https://qm.test",
  });
  const r = await tc.miniapp({ title: "Blocks", html: "<p>hi</p>" });
  assert.equal(r.title, "Blocks");
  assert.match(r.url, /^https:\/\/qm\.test\/m\//);
  assert.match(r.directive, /\[\[miniapp: https:\/\/qm\.test\/m\//);
});

test("putMiniapp refuses a playground that cannot render", async () => {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  await assert.rejects(
    () =>
      putMiniapp(built.miniapps, {
        title: "broken",
        html: "<p>x</p><script>function (</script>",
        ownerScopeId: scopeId("personal", "U1"),
        createdBy: "U1",
      }),
    /does not parse/,
  );
});

test("miniapp rejects oversized HTML", async () => {
  const built = buildApp(testConfig({ signingSecret: SECRET }));
  await assert.rejects(
    () =>
      putMiniapp(built.miniapps, {
        title: "big",
        html: "x".repeat(MAX_MINIAPP_HTML_BYTES + 1),
        ownerScopeId: scopeId("personal", "U1"),
        createdBy: "U1",
      }),
    /keep it under/,
  );
});
