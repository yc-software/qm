import { parseArgs } from "node:util";
import { connectInstance, finish, launch, loadPlaywright, outDir, withPage } from "./instance.mjs";

const QUIET_MS = 600;
const PAGE_MS = 20_000;

async function discoverPages(browser, qa) {
  const page = await browser.newPage();
  await page.goto(`${qa.portal}/settings`);
  await page.locator(".settings-nav-item").first().waitFor({ timeout: PAGE_MS });
  const hrefs = await page
    .locator(".settings-nav-item")
    .evaluateAll((links) => links.map((a) => a.getAttribute("href")));
  await page.close();
  const pages = Object.fromEntries(hrefs.map((href) => [href.replace(/^\/settings\/?/, "") || "general", href]));
  const { sessions } = await qa.api("GET", `/v1/sessions?principalId=${encodeURIComponent(qa.principal)}`);
  return {
    ...pages,
    onboarding: "/settings/onboarding",
    keychain: "/settings/keychain",
    ackemoji: "/settings/ackemoji",
    user: `/settings/user?user=${encodeURIComponent(qa.principal)}`,
    ...(sessions[0] ? { session: `/settings/history/s/${encodeURIComponent(sessions[0].id)}` } : {}),
  };
}

async function settle(page, problems) {
  const inflight = new Set();
  page.on("request", (req) => {
    if (req.resourceType() !== "eventsource" && new URL(req.url()).pathname.startsWith("/api/")) inflight.add(req);
  });
  page.on("requestfinished", (req) => inflight.delete(req));
  page.on("requestfailed", (req) => inflight.delete(req));
  return async () => {
    const end = Date.now() + PAGE_MS;
    let quietSince = Date.now();
    while (Date.now() < end) {
      if (inflight.size) quietSince = Date.now();
      else if (Date.now() - quietSince >= QUIET_MS) return;
      await page.waitForTimeout(100);
    }
    problems.push(`API still busy after ${PAGE_MS / 1000}s`);
  };
}

function visit(browser, qa, name, path, dir) {
  return withPage(browser, dir, name, async (page, problems) => {
    const quiet = await settle(page, problems);
    await page.goto(`${qa.portal}${path}`);
    await page.locator(".settings-content").waitFor({ timeout: PAGE_MS });
    await quiet();
    if (!(await page.locator(".settings-content").innerText()).trim()) throw new Error("settings content is empty");
  });
}

const { values } = parseArgs({
  options: {
    page: { type: "string" },
    browser: { type: "string", default: "chromium" },
    list: { type: "boolean", default: false },
    headed: { type: "boolean", default: false },
  },
});
const started = Date.now();
const qa = connectInstance();
const browsers = values.browser.split(",").filter(Boolean);
const playwright = loadPlaywright(browsers);
const dir = outDir("portal");
const results = [];
for (const name of browsers) {
  const browser = await launch(playwright, name, values.headed);
  const pages = await discoverPages(browser, qa);
  if (values.list) {
    for (const [key, path] of Object.entries(pages)) console.log(`${key.padEnd(16)} ${path}`);
    await browser.close();
    process.exit(0);
  }
  const wanted = values.page ? values.page.split(",") : Object.keys(pages);
  const missing = wanted.filter((key) => !pages[key]);
  if (missing.length) {
    console.error(`unknown page ${missing.join(", ")}; run with --list to see them`);
    process.exit(2);
  }
  const visits = wanted.map((key) => visit(browser, qa, key, pages[key], dir));
  results.push(...(await Promise.all(visits)));
  await browser.close();
}
finish(dir, qa, results, started);
