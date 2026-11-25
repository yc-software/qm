import { chromium } from "playwright";
import fs from "node:fs";
const url = process.env.CHAT;
const connect = process.env.CONNECT;
const out = process.env.OUT;
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
const b = await chromium.launch({ proxy: { server: "http://127.0.0.1:3128" } });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: out, size: { width: 1280, height: 900 } } });
const p = await ctx.newPage();
p.on("pageerror", (e) => log("pageerror", String(e).slice(0, 200)));
const probe = () => p.evaluate(() => {
  const flat = (s) => (s || "").replace(/\s+/g, " ").trim();
  const rows = [...document.querySelectorAll(".message-row")].map((r) => `${flat(r.className).replace("message-row ", "")}@${Math.round(r.getBoundingClientRect().top)}: ${flat(r.innerText).slice(0, 48)}`);
  const cards = [...document.querySelectorAll(".connection-card")].map((c) => `${flat(c.innerText)} [${flat(c.className).replace("connector-widget connection-card", "").trim()}]@${Math.round(c.getBoundingClientRect().top)}`);
  const live = document.querySelector(".assistant-row.streaming");
  const anims = document.getAnimations().map((a) => a.animationName).filter((n) => n && n.startsWith("slack-installed"));
  return { rows, cards, liveTop: live ? Math.round(live.getBoundingClientRect().top) : null, anims };
});
await p.goto(url, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
log("reloaded:", JSON.stringify(await probe(), null, 1));
await p.screenshot({ path: `${out}/00-reloaded.png` });
await p.locator(".connection-card", { hasText: connect }).last().getByRole("button", { name: /connect/i }).first().click();
await p.waitForURL(/composio/, { timeout: 40000 }).catch(() => {});
await p.waitForTimeout(5000);
await p.locator("input:not([type=hidden]):not([type=checkbox])")[process.env.FIELD === "last" ? "last" : "first"]().fill("qa-not-a-real-key-000000000000");
await p.getByRole("button", { name: /connect|submit|continue|save|authorize/i }).last().click();
const returned = await p.waitForURL(/yc-qm-dev-wake/, { timeout: 25000 }).then(() => true).catch(() => false);
if (!returned) { log("NO RETURN; provider page says:", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400)); await ctx.close(); await b.close(); process.exit(2); }
const back = Date.now();
let last = "";
let shot = 0;
while (Date.now() - back < 60000) {
  const at = Date.now() - back;
  const s = await probe().catch(() => null);
  if (at < 5000 || shot++ % 10 === 0) await p.screenshot({ path: `${out}/f-${String(at).padStart(5, "0")}.png` }).catch(() => {});
  const line = JSON.stringify(s);
  if (line !== last) { log(`+${at}ms`, line); last = line; }
  if (s && s.liveTop === null && at > 15000) break;
  await p.waitForTimeout(at < 5000 ? 40 : 400);
}
await p.waitForTimeout(1500);
log("after:", JSON.stringify(await probe(), null, 1));
await p.screenshot({ path: `${out}/99-after.png` });
const video = await p.video().path();
await ctx.close();
await b.close();
log("video:", video);
