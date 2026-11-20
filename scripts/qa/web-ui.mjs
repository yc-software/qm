import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { connectInstance, finish, launch, loadPlaywright, outDir, withPage } from "./instance.mjs";
import { backgroundRun, fireCron, newWebSession, requestApproval, slackMessage } from "./events.mjs";

const TURN_MS = 180_000;
const COMPOSER = ".composer-input:visible";
const assistant = (page, text) => page.locator(".assistant-row").filter({ hasText: text }).first();

const CHECKS = {
  async chat(page, qa) {
    const text = `QA web reply ${randomUUID().slice(0, 8)}`;
    await page.goto(`${qa.portal}/`);
    await page.locator(".new-chat-nav button").first().click();
    await page.locator(COMPOSER).fill(`Reply with exactly: ${text}`);
    await page.keyboard.press("Enter");
    await assistant(page, text).waitFor({ timeout: TURN_MS });
  },
  async cron(page, qa) {
    const session = await newWebSession(qa);
    await page.goto(session.url);
    await page.locator(COMPOSER).waitFor();
    const fired = await fireCron(qa, session);
    await assistant(page, fired.text).waitFor({ timeout: 60_000 });
  },
  async approval(page, qa) {
    const pending = await requestApproval(qa);
    await page.goto(pending.url);
    const card = page.locator(".composer-approval").filter({ hasText: pending.command });
    await card.waitFor({ timeout: 60_000 });
    await card.getByRole("button", { name: "Allow once" }).click();
    await card.waitFor({ state: "hidden", timeout: 60_000 });
    await assistant(page, pending.command.split(" ")[1]).waitFor({ timeout: TURN_MS });
  },
  async background(page, qa) {
    await page.goto(`${qa.portal}/`);
    await page.locator(COMPOSER).waitFor();
    const run = await backgroundRun(qa);
    const row = page.locator(`.sidebar a[href$="/s/${run.sessionId}"]`).first();
    await row.waitFor({ timeout: 60_000 });
    await row.click();
    await assistant(page, run.text).waitFor({ timeout: TURN_MS });
  },
  async slack(page, qa) {
    const message = await slackMessage(qa);
    await page.goto(message.url);
    await assistant(page, message.text).waitFor({ timeout: TURN_MS });
    await page.locator(`.sidebar a[href$="/s/${message.sessionId}"] .slack-mark`).first().waitFor({ timeout: 30_000 });
  },
};

async function runBrowser(playwright, name, checks, qa, dir, headed) {
  const browser = await launch(playwright, name, headed);
  const results = await Promise.all(
    checks.map((check) => withPage(browser, dir, check, (page) => CHECKS[check](page, qa))),
  );
  await browser.close();
  return results;
}

const { values } = parseArgs({
  options: {
    browser: { type: "string", default: "chromium,webkit" },
    check: { type: "string", default: Object.keys(CHECKS).join(",") },
    headed: { type: "boolean", default: false },
  },
});
const browsers = values.browser.split(",").filter(Boolean);
const checks = values.check.split(",").filter(Boolean);
const unknown = checks.filter((c) => !CHECKS[c]);
if (unknown.length) {
  console.error(`unknown check ${unknown.join(", ")}; choose from ${Object.keys(CHECKS).join(", ")}`);
  process.exit(2);
}
const started = Date.now();
const qa = connectInstance();
const playwright = loadPlaywright(browsers);
const dir = outDir("web-ui");
const results = (
  await Promise.all(browsers.map((name) => runBrowser(playwright, name, checks, qa, dir, values.headed)))
).flat();
finish(dir, qa, results, started);
