import { chromium } from "playwright";
import fs from "node:fs";
const url = process.env.CHAT;
const app = process.env.APP;
const out = process.env.OUT;
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
const b = await chromium.launch({ proxy: { server: "http://127.0.0.1:3128" } });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, recordVideo: { dir: out, size: { width: 1280, height: 900 } } });
if (process.env.COOKIE_FILE) await ctx.addCookies([{ name: "portal_session", value: encodeURIComponent(fs.readFileSync(process.env.COOKIE_FILE, "utf8")), domain: "<dev-instance>", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
const p = await ctx.newPage();
p.on("pageerror", (e) => log("pageerror", String(e).slice(0, 200)));
p.on("dialog", async (d) => { log("dialog:", d.type(), JSON.stringify(d.message())); await d.accept(); });
p.on("response", (r) => { if (r.request().method() !== "GET" && /composio/.test(r.url())) log("request:", r.request().method(), new URL(r.url()).pathname, "->", r.status()); });
const probe = () => p.evaluate(() => {
  const flat = (s) => (s || "").replace(/\s+/g, " ").trim();
  const rows = [...document.querySelectorAll(".message-row")].map((r) => `${flat(r.className).replace("message-row ", "").split(" ").filter((c) => ["user-row", "assistant-row", "streaming"].includes(c)).join(".")}@${Math.round(r.getBoundingClientRect().top)}: ${flat(r.innerText).slice(0, 44)}`);
  const cards = [...document.querySelectorAll(".connection-card")].map((c) => { const box = c.getBoundingClientRect(); return `${flat(c.innerText)} [${flat(c.className).replace("connector-widget connection-card", "").trim()}] h=${Math.round(box.height)}`; });
  const errors = [...document.querySelectorAll(".inline-setup [role=status], .inline-setup [role=alert], .connection-card-error")].map((e) => flat(e.innerText)).filter((t) => t && !/^(Connected|Not connected)$/.test(t));
  const live = document.querySelector(".assistant-row.streaming");
  const anims = document.getAnimations().map((a) => a.animationName).filter((n) => n && n.startsWith("slack-installed"));
  return { rows, cards, errors, liveTop: live ? Math.round(live.getBoundingClientRect().top) : null, anims };
});
const bundle = async () => (await p.evaluate(() => [...document.querySelectorAll("script[src],link[rel=stylesheet]")].map((e) => (e.src || e.href).split("/").pop()).filter((n) => n.startsWith("main-")))).join(" ");
await p.goto(url, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(7000);
log("bundle:", await bundle());
log("signed in as:", await p.evaluate(() => fetch("/me").then((r) => r.json()).then((m) => (typeof m.user === "string" ? m.user : m.user?.email ?? m.user?.id)).catch(() => "?")));
log("before:", JSON.stringify(await probe()));
await p.screenshot({ path: `${out}/01-before.png` });
const card = () => p.locator(".connection-card", { hasText: app }).last();
await card().getByRole("button", { name: /disconnect/i }).first().click();
let last = "";
const start = Date.now();
while (Date.now() - start < 12000) {
  const s = await probe();
  const line = JSON.stringify({ cards: s.cards, errors: s.errors, liveTop: s.liveTop });
  if (line !== last) { log(`disconnect+${Date.now() - start}ms`, line); last = line; }
  await p.waitForTimeout(150);
}
await p.screenshot({ path: `${out}/02-after-disconnect.png` });
const connections = await p.evaluate(async () => { const r = await fetch("/api/composio/connections", { credentials: "same-origin" }); const j = await r.json(); return (j.items || []).map((i) => i.toolkit?.slug || i.toolkit || i.slug).sort().join(", "); });
log("server connections after disconnect:", connections);
await card().getByRole("button", { name: /connect/i }).first().click();
await p.waitForURL(/composio/, { timeout: 40000 }).catch(() => {});
await p.waitForTimeout(5000);
const fields = await p.locator("input:not([type=hidden]):not([type=checkbox])").count();
log("hosted page:", p.url().split("?")[0], "fields:", fields);
await p.screenshot({ path: `${out}/03-hosted-page.png` });
await p.locator("input:not([type=hidden]):not([type=checkbox])").last().fill("qa-not-a-real-key-000000000000");
await p.getByRole("button", { name: /connect|submit|continue|save|authorize/i }).last().click();
const returned = await p.waitForURL(/yc-qm-dev-wake/, { timeout: 25000 }).then(() => true).catch(() => false);
if (!returned) { log("NO RETURN; provider page says:", (await p.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400)); await ctx.close(); await b.close(); process.exit(2); }
const back = Date.now();
last = "";
let n = 0;
let sawLive = false;
while (Date.now() - back < 45000) {
  const at = Date.now() - back;
  const s = await probe().catch(() => null);
  if (at < 4000 || n++ % 10 === 0) await p.screenshot({ path: `${out}/f-${String(at).padStart(5, "0")}.png` }).catch(() => {});
  const line = JSON.stringify(s);
  if (line !== last) { log(`return+${at}ms`, line); last = line; }
  if (s?.liveTop !== null) sawLive = true;
  if (s && s.liveTop === null && (sawLive ? at > 6000 : at > 20000)) break;
  await p.waitForTimeout(at < 4000 ? 50 : 400);
}
log("wake turn seen:", sawLive);
await p.waitForTimeout(1500);
log("after:", JSON.stringify(await probe()));
await p.screenshot({ path: `${out}/04-after-reconnect.png` });
const video = await p.video().path();
await ctx.close();
await b.close();
log("video:", video);
