import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BROWSER_STATE, CLIENT_URL, launchFirefox, SHOTS_DIR, slackPage, threadUrl, VIEWPORT } from "./browser.ts";
import { renderGallery, type ShotIndex } from "./gallery.ts";
import type { ScenarioResult, TimelinePost } from "./harness.ts";
import { sleep } from "./slack.ts";

const OUT_DIR = path.dirname(SHOTS_DIR);
const CONCURRENCY = Number(process.env.LIVE_E2E_SHOTS_CONCURRENCY) || 4;

interface ResultsFile {
  runId: string;
  teamId: string;
  results: ScenarioResult[];
}

interface ThreadTarget {
  scenario: string;
  channelId: string;
  rootTs: string;
  needle?: string;
}

function plainNeedle(post: TimelinePost | undefined): string | undefined {
  if (!post) return undefined;
  const plain = post.text
    .replace(/^@agent\s+/, "")
    .replace(/[*_~`]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const slice = plain.slice(0, 40).trim();
  return slice.length >= 8 ? slice : undefined;
}

function collectTargets(results: ScenarioResult[]): ThreadTarget[] {
  const targets: ThreadTarget[] = [];
  for (const r of results) {
    if (!r.timeline) continue;
    for (const th of r.timeline.threads) {
      const rootPost =
        r.timeline.posts.find((p) => p.rootTs === th.rootTs) ??
        r.timeline.posts.find((p) => p.channelId === th.channelId);
      targets.push({ scenario: r.name, channelId: th.channelId, rootTs: th.rootTs, needle: plainNeedle(rootPost) });
    }
  }
  return targets;
}

function shotKey(t: ThreadTarget): string {
  return `${t.channelId}:${t.rootTs}`;
}

function shotFile(t: ThreadTarget): string {
  return `${t.channelId}_${t.rootTs.replace(/\./g, "-")}.png`;
}

async function login(): Promise<void> {
  console.log("Opening Firefox — sign into your Slack workspace in the window. Waiting for a live session…");
  const browser = await launchFirefox(false);
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await page.goto(CLIENT_URL);
    for (const deadline = Date.now() + 5 * 60_000; Date.now() < deadline; await sleep(3000)) {
      if (!/\/client\/[TE][A-Z0-9]+/.test(page.url())) continue;
      await mkdir(path.dirname(BROWSER_STATE), { recursive: true });
      await context.storageState({ path: BROWSER_STATE });
      console.log(`✅ Slack session saved to ${BROWSER_STATE}; sweeps reuse it headless.`);
      return;
    }
    console.error("Timed out waiting for a Slack login.");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

async function capture(page: any, teamId: string, t: ThreadTarget): Promise<boolean> {
  await page.goto(threadUrl(teamId, t.channelId, t.rootTs), { waitUntil: "domcontentloaded", timeout: 60_000 });
  const content = t.needle ? page.getByText(t.needle).first() : page.locator('[data-qa="message_container"]').first();
  const ready = await content.waitFor({ timeout: 25_000 }).then(
    () => true,
    () => false,
  );
  if (/signin/.test(page.url())) throw new Error("Slack browser login expired — run: npm run gallery:shots:login");
  await page.screenshot({ path: path.join(SHOTS_DIR, shotFile(t)) });
  return ready;
}

async function sweep(): Promise<void> {
  const raw = await readFile(path.join(OUT_DIR, "results.json"), "utf8").catch(() => null);
  if (!raw) {
    console.error("no out/results.json — run the scenarios first (node test/live-slack/run.ts)");
    process.exitCode = 1;
    return;
  }
  const { runId, teamId, results } = JSON.parse(raw) as ResultsFile;
  const queue = collectTargets(results);
  const total = queue.length;
  if (!total) {
    console.log("no threads to screenshot in this run");
    return;
  }
  await mkdir(SHOTS_DIR, { recursive: true });
  console.log(`📸 screenshotting ${total} threads (team ${teamId})…`);
  const browser = await launchFirefox();
  const shots: ShotIndex = {};
  try {
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      const page = await slackPage(browser);
      for (let t = queue.shift(); t; t = queue.shift()) {
        try {
          const ready = await capture(page, teamId, t);
          shots[shotKey(t)] = `shots/${shotFile(t)}`;
          console.log(`  ${ready ? "✅" : "⚠️ "} ${t.scenario} ${t.channelId}${ready ? "" : " (content not seen)"}`);
        } catch (err) {
          console.error(`  ❌ ${t.scenario} ${t.channelId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
    await Promise.all(workers);
  } finally {
    await browser.close();
  }
  await writeFile(path.join(OUT_DIR, "gallery.html"), renderGallery(runId, results, shots));
  console.log(
    `gallery updated with ${Object.keys(shots).length}/${total} screenshots: ${path.join(OUT_DIR, "gallery.html")}`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--login")) await login();
  else await sweep();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
