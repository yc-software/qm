import { chromium } from "playwright";
import fs from "node:fs";
const BASE = "https://<dev-instance>";
const out = "/tmp/pw/run6";
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
const b = await chromium.launch({ proxy: { server: "http://127.0.0.1:3128" } });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: out, size: { width: 1280, height: 900 } } });
const p = await ctx.newPage();
p.on("pageerror", (e) => log("pageerror", String(e).slice(0, 200)));
let watch = false;
p.on("response", async (r) => {
  if (!watch || !/\/api\/sessions\/[0-9a-f-]{36}(\?|$)/.test(r.url())) return;
  const body = await r.json().catch(() => null);
  if (body?.session) log("session payload on reload:", JSON.stringify({ working: body.session.working ?? null, workingSince: typeof body.session.workingSince, workingRun: typeof body.session.workingRun }));
});
const probe = () => p.evaluate(() => {
  const flat = (s) => (s || "").replace(/\s+/g, " ").trim();
  return {
    rows: [...document.querySelectorAll(".message-row")].map((r) => `${flat(r.className).replace("message-row ", "").split(" ").filter((c) => ["user-row", "assistant-row", "streaming"].includes(c)).join(".")}@${Math.round(r.getBoundingClientRect().top)}: ${flat(r.innerText).slice(0, 40)}`),
    cards: [...document.querySelectorAll(".connection-card")].map((c) => `${flat(c.innerText)}${c.classList.contains("pending") ? " (dim)" : ""}`),
  };
});
await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(3000);
await p.getByRole("button", { name: "New session" }).first().click();
await p.waitForTimeout(1200);
await p.fill("textarea.composer-input", "I want to try Perplexity, Exa and Firecrawl. Show me a connect card for each using the card tool (toolkit ids perplexityai, exa, firecrawl) with one short sentence.");
await p.keyboard.press("Enter");
for (let i = 0; i < 60; i++) { await p.waitForTimeout(1500); const s = await probe(); if (s.cards.length >= 3 && !s.cards.some((c) => c.includes("(dim)")) && !s.rows.some((r) => r.includes("streaming"))) break; }
await p.waitForTimeout(2000);
log("chat:", p.url());
log("settled:", JSON.stringify(await probe()));
await p.locator(".connection-card", { hasText: "Perplexity" }).last().getByRole("button", { name: /connect/i }).first().click();
await p.waitForURL(/composio/, { timeout: 40000 }).catch(() => {});
await p.waitForTimeout(5000);
await p.locator("input:not([type=hidden]):not([type=checkbox])").first().fill("qa-not-a-real-key-000000000000");
await p.getByRole("button", { name: /connect|submit|continue|save|authorize/i }).last().click();
const returned = await p.waitForURL(/yc-qm-dev-wake/, { timeout: 25000 }).then(() => true).catch(() => false);
if (!returned) { log("NO RETURN; provider page:", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300)); await ctx.close(); await b.close(); process.exit(2); }
await p.waitForSelector(".assistant-row.streaming", { timeout: 20000 });
log("wake turn is live; before reload:", JSON.stringify(await probe()));
watch = true;
await p.reload({ waitUntil: "domcontentloaded" });
const back = Date.now();
let last = "";
let n = 0;
while (Date.now() - back < 45000) {
  const at = Date.now() - back;
  const s = await probe().catch(() => null);
  if (n++ % 4 === 0) await p.screenshot({ path: `${out}/r-${String(at).padStart(5, "0")}.png` }).catch(() => {});
  const line = JSON.stringify(s);
  if (line !== last) { log(`reload+${at}ms`, line); last = line; }
  if (s && s.rows.length >= 3 && !s.rows.some((r) => r.includes("streaming")) && at > 6000) break;
  await p.waitForTimeout(120);
}
await p.screenshot({ path: `${out}/99-after.png` });
const video = await p.video().path();
await ctx.close();
await b.close();
log("video:", video);
