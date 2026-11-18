import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export const BROWSER_STATE =
  process.env.LIVE_E2E_BROWSER_STATE ?? path.join(os.homedir(), ".cache", "live-slack-browser-state.json");
export const SHOTS_DIR = path.join(import.meta.dirname, "out", "shots");
export const CLIENT_URL = "https://app.slack.com/client";
export const VIEWPORT = { width: 1400, height: 1000 };

export function threadUrl(teamId: string, channelId: string, rootTs: string): string {
  return `${CLIENT_URL}/${teamId}/${channelId}/thread/${channelId}-${rootTs}`;
}

export function launchFirefox(headless = true): Promise<any> {
  const from = createRequire(path.join(process.env.LIVE_E2E_PLAYWRIGHT_DIR ?? process.cwd(), "package.json"));
  return from("playwright").firefox.launch({ headless });
}

export async function slackPage(browser: any): Promise<any> {
  return (await browser.newContext({ storageState: BROWSER_STATE, viewport: VIEWPORT })).newPage();
}
