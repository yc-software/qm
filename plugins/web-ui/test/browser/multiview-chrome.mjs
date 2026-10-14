import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1720, height: 1100 }, timezoneId: "America/Los_Angeles" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(process.argv[2] || "http://localhost:8080/");
  const panes = page.locator("[data-pane-id]");
  await panes.nth(1).locator(".message-stack").waitFor();
  assert.ok((await panes.count()) > 1);
  assert.equal(await panes.locator(".composer-wrap:visible").count(), 1);
  const inactive = page.locator(".dv-groupview:not(.dv-active-group) [data-pane-id]").first();
  const paneId = await inactive.getAttribute("data-pane-id");
  const target = page.locator(`[data-pane-id="${paneId}"]`);
  const group = target.locator(
    "xpath=ancestor::*[contains(concat(' ',normalize-space(@class),' '),' dv-groupview ')][1]",
  );
  const actions = group.locator(".dv-right-actions-container");
  await page.mouse.move(0, 0);
  assert.equal(await actions.evaluate((el) => el.ownerDocument.defaultView.getComputedStyle(el).opacity), "0");
  const titleBox = await group.locator(".split-pane-title").boundingBox();
  const inputBox = await target.locator(".chat-scroll").boundingBox();
  await target.locator(".chat-scroll").hover();
  assert.equal(await target.locator(".composer-wrap").isVisible(), false);
  assert.equal(await actions.evaluate((el) => el.ownerDocument.defaultView.getComputedStyle(el).opacity), "1");
  assert.deepEqual(await group.locator(".split-pane-title").boundingBox(), titleBox);
  assert.deepEqual(await target.locator(".chat-scroll").boundingBox(), inputBox);
  await page.mouse.move(0, 0);
  await actions.locator("button").first().focus();
  assert.equal(await actions.evaluate((el) => el.ownerDocument.defaultView.getComputedStyle(el).opacity), "1");
  await target.locator(".chat-scroll").click({ position: { x: 100, y: 100 } });
  assert.equal(await target.locator(".composer-wrap").isVisible(), true);
  await target.locator("textarea").fill("Check the edge cases too.");
  assert.equal(await target.locator("textarea").inputValue(), "Check the edge cases too.");
  assert.equal(await panes.locator(".composer-wrap:visible").count(), 1);
  const other = page.locator(".dv-groupview:not(.dv-active-group) [data-pane-id]").first();
  const otherId = await other.getAttribute("data-pane-id");
  const nextPane = page.locator(`[data-pane-id="${otherId}"]`);
  await nextPane.locator(".chat-scroll").focus();
  assert.equal(await nextPane.locator(".composer-wrap").isVisible(), true);
  await target.locator(".chat-scroll").focus();
  assert.equal(await target.locator("textarea").inputValue(), "Check the edge cases too.");
  await target.locator("textarea").fill("");
  assert.deepEqual(errors, []);

  console.log(
    "PASS default quiet headers, hover without activation or reflow, keyboard access, composer focus, drafts, no browser errors",
  );
} finally {
  await browser.close();
}
