const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
import assert from "node:assert/strict";
(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const variant of ["focus", "quiet"]) {
    const page = await browser.newPage({ viewport: { width: 1720, height: 1100 }, timezoneId: "America/Los_Angeles" });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.goto((process.env.DEMO_URL || "http://localhost:8080/") + "?chrome=" + variant);
    await page.locator('[data-pane-id="demo-7"] .message-stack').waitFor();
    await page.waitForTimeout(1200);
    assert.equal(new URL(page.url()).searchParams.get("chrome"), variant);
    assert.equal(
      await page.evaluate(() => localStorage.getItem("web-ui:split-canvas:v1").includes('"hideHeader":true')),
      false,
    );
    assert.equal(await page.locator("[data-pane-id] .composer-wrap:visible").count(), 1);
    assert.equal(await page.locator(".dv-tabs-and-actions-container:visible").count(), variant === "focus" ? 1 : 8);
    if (variant === "quiet") {
      await page.locator('[data-pane-id="demo-1"] .chat-scroll').hover();
      assert.equal(
        await page.locator(".dv-groupview:not(.dv-active-group) .dv-right-actions-container:visible").count(),
        0,
      );
    }
    await page.locator('[data-pane-id="demo-1"] .chat-scroll').click({ position: { x: 250, y: 270 } });
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-pane-id="demo-1"]').getAttribute("data-chrome-active"), "true");
    await page.locator('[data-pane-id="demo-1"] textarea').fill("Please check the edge cases too.");
    assert.equal(
      await page.locator('[data-pane-id="demo-1"] textarea').inputValue(),
      "Please check the edge cases too.",
    );
    assert.equal(await page.locator("[data-pane-id] .composer-wrap:visible").count(), 1);
    await page.locator('[data-pane-id="demo-2"] .chat-scroll').focus();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-pane-id="demo-2"]').getAttribute("data-chrome-active"), "true");
    await page.locator('[data-pane-id="demo-1"] .chat-scroll').focus();
    assert.equal(
      await page.locator('[data-pane-id="demo-1"] textarea').inputValue(),
      "Please check the edge cases too.",
    );
    await page.locator('[data-pane-id="demo-1"] textarea').fill("");
    await page.screenshot({ path: `${process.env.SCREENSHOT_DIR || "/tmp"}/multiview-${variant}.png` });
    await page.reload();
    await page.locator('[data-pane-id="demo-7"] .message-stack').waitFor();
    assert.equal(await page.locator(".dv-tabs-and-actions-container:visible").count(), variant === "focus" ? 1 : 8);
    assert.deepEqual(errors, []);
    console.log("PASS", variant, "focus, input, draft preservation, hidden chrome, no console errors");
    await page.close();
  }
  const baseline = await browser.newPage({ viewport: { width: 1720, height: 1100 } });
  await baseline.goto((process.env.DEMO_URL || "http://localhost:8080/") + "?chrome=normal");
  await baseline.locator('[data-pane-id="demo-7"] .message-stack').waitFor();
  assert.equal(await baseline.locator("[data-pane-id] .composer-wrap:visible").count(), 8);
  assert.equal(await baseline.locator(".dv-tabs-and-actions-container:visible").count(), 8);
  console.log("PASS normal UI unchanged");
  await browser.close();
})();
