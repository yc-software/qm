import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

let coreBranding = { accent: "#f0652f", mark: "Y", selfLabel: "QM" };
const core = createServer((req: IncomingMessage, res) => {
  if ((req.url ?? "").startsWith("/v1/surface-config")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ branding: coreBranding }));
  }
  if (req.method === "PUT" && /\/v1\/admin\/scopes\/[^/]+\/branding/.test(req.url ?? "")) {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      coreBranding = JSON.parse(body) as typeof coreBranding;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});
await new Promise<void>((r) => core.listen(0, r));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_ORG_ID = "acme";
process.env.CORE_SIGNING_SECRET = "admin-branding-test-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  core.close();
});

test("cold start: the FIRST shell render already carries the org branding", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /--brand-accent:#f0652f/, "accent style injected on the first render");
  assert.match(
    html,
    /<meta name="brand-self-label" content="QM"\s*\/?>/,
    "self-label meta injected regardless of the shell's formatting",
  );
  assert.match(html, /--brand-mark:"Y"/, "brand mark variable injected for the badge");
  assert.match(html, /<title>QM Admin<\/title>/, "tab title carries the configured label");
});

test("the shell's badge and product name are branding-driven, not hardcoded", () => {
  const shell = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(shell, /content:\s*var\(--brand-mark\)/, "badge glyph reads --brand-mark");
  assert.match(shell, /--brand-mark:\s*none;/, "and falls back to the shipped mark when the org sets none");
  assert.match(shell, /\[data-brand-product\]/, "every product name is script-addressable");
});

test("a branding save acks only after the shell reflects it — the post-save reload can't be stale", async () => {
  const put = await fetch(`${base}/api/scopes/${encodeURIComponent("org:acme")}/branding`, {
    method: "PUT",
    headers: { cookie: "admin=U-admin", "content-type": "application/json" },
    body: JSON.stringify({
      accent: "#0055ff",
      mark: "Z",
      markUrl: "https://cdn.example.com/icon.png",
      selfLabel: "Zed",
    }),
  });
  assert.equal(put.status, 200);
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /--brand-accent:#0055ff/);
  assert.match(
    html,
    /--brand-mark-image:url\("https:\/\/cdn\.example\.com\/icon\.png"\)/,
    "the cache key follows the icon, so a re-brand is not served a stale shell",
  );
  assert.match(html, /<meta name="brand-self-label" content="Zed"\s*\/?>/);
  assert.match(html, /<title>Zed Admin<\/title>/, "tab title follows the saved label");
});

test("the brand icon is a CSS variable the org can point at its own image", () => {
  const shell = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(
    shell,
    /var\(--brand-mark-image, url\("\.\/brand-mark\.svg"\)\)/,
    "the badge paints from the variable and falls back to the shipped mark",
  );
  assert.match(shell, /id="branding-mark-url"/, "the admin form can set it");
  assert.match(shell, /markUrl: \$\("branding-mark-url"\)\.value\.trim\(\)/, "and saves it with the rest of branding");
});
