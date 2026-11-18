const prompt = process.env.PROMPT ?? "Reply with three short bullet points about the ocean, then the word FINISHED.";
const expected = process.env.EXPECT ?? "FINISHED";

export default async ({ page, step }) => {
  const composer = page.locator(".composer-input");
  const reply = () => page.locator(".assistant-row").filter({ hasText: expected }).last();
  await step("Open a new session", async () => {
    await composer.waitFor({ timeout: 30000 });
    const fresh = page.getByText("New session", { exact: true });
    if (await fresh.count()) await fresh.click();
  });
  await step("Type and send a prompt", async () => {
    await composer.click();
    await composer.pressSequentially(prompt, { delay: 15 });
    await page.keyboard.press("Enter");
    await page.locator(".user-row").first().waitFor({ timeout: 15000 });
  });
  await step("Reply streams to completion", async () => {
    await reply().waitFor({ timeout: 180000 });
    await page.waitForTimeout(1500);
  });
  await step("Reload: transcript persists", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await reply().waitFor({ timeout: 30000 });
  });
};
