import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Cdp } from "./cdp.ts";
import { renderGallery, type ShotIndex } from "./gallery.ts";
import type { ScenarioResult, TimelinePost } from "./harness.ts";
import { sleep } from "./slack.ts";

const OUT_DIR = path.join(import.meta.dirname, "out");
const SHOTS_DIR = path.join(OUT_DIR, "shots");
const PROFILE = process.env.LIVE_E2E_SHOTS_PROFILE ?? path.join(os.homedir(), ".cache", "live-slack-shots-chrome");
const PORT = Number(process.env.LIVE_E2E_SHOTS_PORT) || 9333;
const CLIENT_URL = "https://app.slack.com/client";

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

function deepLink(teamId: string, t: ThreadTarget): string {
  return `${CLIENT_URL}/${teamId}/${t.channelId}/thread/${t.channelId}-${t.rootTs}`;
}

function shotKey(t: ThreadTarget): string {
  return `${t.channelId}:${t.rootTs}`;
}

function shotFile(t: ThreadTarget): string {
  return `${t.channelId}_${t.rootTs.replace(/\./g, "-")}.png`;
}

async function login(): Promise<void> {
  await mkdir(PROFILE, { recursive: true });
  console.log("Opening Chrome — sign into example.slack.com in the window. Waiting for a live session…");
  const cdp = await Cdp.launch({ port: PORT, userDataDir: PROFILE, headed: true });
  try {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      if (await cdp.isSlackLoggedIn(CLIENT_URL).catch(() => false)) {
        console.log("✅ Slack session captured. You can close nothing — the sweep will reuse this profile headless.");
        return;
      }
      await sleep(3000);
    }
    console.error("Timed out waiting for a Slack login.");
    process.exitCode = 1;
  } finally {
    await cdp.close();
  }
}

async function sweep(): Promise<void> {
  const raw = await readFile(path.join(OUT_DIR, "results.json"), "utf8").catch(() => null);
  if (!raw) {
    console.error("no out/results.json — run the scenarios first (node test/live-slack/run.ts)");
    process.exitCode = 1;
    return;
  }
  const { runId, teamId, results } = JSON.parse(raw) as ResultsFile;
  const targets = collectTargets(results);
  if (!targets.length) {
    console.log("no threads to screenshot in this run");
    return;
  }
  await mkdir(SHOTS_DIR, { recursive: true });
  const cdp = await Cdp.launch({ port: PORT, userDataDir: PROFILE, headed: false });
  const shots: ShotIndex = {};
  try {
    if (!(await cdp.isSlackLoggedIn(CLIENT_URL).catch(() => false))) {
      console.error(
        "dedicated Chrome profile is not signed into Slack — run: node test/live-slack/screenshots.ts --login",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`📸 screenshotting ${targets.length} threads (team ${teamId})…`);
    for (const t of targets) {
      try {
        const { data, ready } = await cdp.capture(deepLink(teamId, t), { needle: t.needle, readyMs: 25_000 });
        const file = shotFile(t);
        await writeFile(path.join(SHOTS_DIR, file), Buffer.from(data, "base64"));
        shots[shotKey(t)] = `shots/${file}`;
        console.log(
          `  ${ready ? "✅" : "⚠️ "} ${t.scenario} ${t.channelId}${ready ? "" : " (content needle not seen — capture may be early)"}`,
        );
      } catch (err) {
        console.error(`  ❌ ${t.scenario} ${t.channelId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await cdp.close();
  }
  await writeFile(path.join(OUT_DIR, "gallery.html"), renderGallery(runId, results, shots));
  console.log(
    `gallery updated with ${Object.keys(shots).length}/${targets.length} screenshots: ${path.join(OUT_DIR, "gallery.html")}`,
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
