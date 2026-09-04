import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { SlackClient } from "./slack.ts";
import { CoreClient } from "./core.ts";
import {
  Ctx,
  isLiveStatusText,
  liveRunExitCode,
  slug,
  type Actor,
  type Env,
  type Scenario,
  type ScenarioResult,
} from "./harness.ts";
import { renderGallery } from "./gallery.ts";
import { scenarios } from "./scenarios.ts";
import { startEventPump, TwinAdmin } from "./arga.ts";

const OUT_DIR = path.join(import.meta.dirname, "out");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function buildEnv(): Promise<Env> {
  const qa = new SlackClient(requireEnv("SLACK_QA_USER_TOKEN"));
  const bot = new SlackClient(requireEnv("SLACK_BOT_TOKEN"));
  const core = new CoreClient(requireEnv("CORE_API_URL"), requireEnv("CORE_SIGNING_SECRET"));
  const [qaAuth, botAuth] = await Promise.all([qa.authTest(), bot.authTest()]);
  const runId = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
    : String(Math.floor(Date.now() / 1000));
  const twin =
    process.env.ARGA_TWIN_ADMIN_URL && process.env.ARGA_TWIN_PROXY_TOKEN
      ? new TwinAdmin(process.env.ARGA_TWIN_ADMIN_URL, process.env.ARGA_TWIN_PROXY_TOKEN)
      : undefined;
  return {
    runId,
    qa,
    bot,
    core,
    botUserId: botAuth.userId,
    qaUserId: qaAuth.userId,
    teamId: qaAuth.teamId,
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    judgeModel: process.env.LIVE_E2E_JUDGE_MODEL ?? "claude-haiku-4-5-20251001",
    ...(process.env.LIVE_E2E_TARGET_CHANNEL ? { targetChannel: process.env.LIVE_E2E_TARGET_CHANNEL } : {}),
    sandbox: Boolean(process.env.SPRITES_TOKEN),
    actors: await resolveActors(),
    ...(twin ? { twin } : {}),
  };
}

function maybeStartEventPump(env: Env): import("./arga.ts").EventPump | undefined {
  if (!env.twin) return undefined;
  const port = process.env.SLACK_EVENTS_PORT ?? "8182";
  const signingSecret = requireEnv("SLACK_SIGNING_SECRET");
  const pump = startEventPump({
    admin: env.twin,
    signingSecret,
    targetUrl: `http://127.0.0.1:${port}/slack/events`,
    botUserId: env.botUserId,
  });
  console.log(`  🔁 twin event pump → 127.0.0.1:${port}`);
  return pump;
}

async function warmUp(env: Env): Promise<void> {
  const scratch = await env.qa.createChannel(`ci-${env.runId}-warmup`.toLowerCase().slice(0, 75));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    await env.qa.invite(scratch, env.botUserId);
    for (const actor of env.actors.values()) await env.qa.invite(scratch, actor.userId);

    const warmTs = await env.qa.post(scratch, `<@${env.botUserId}> warm-up ping — reply "ok".`);
    const warmDeadline = Date.now() + 180_000;
    let warmed = false;
    while (Date.now() < warmDeadline) {
      const msgs = await env.qa.replies(scratch, warmTs).catch(() => []);
      if (msgs.some((m) => m.user === env.botUserId && m.text && !isLiveStatusText(m.text))) {
        warmed = true;
        break;
      }
      await sleep(3000);
    }
    console.log(`  🔥 bot warm-up turn ${warmed ? "ok (instance warm)" : "no reply in 180s (proceeding anyway)"}`);

    for (const actor of env.actors.values())
      await actor.client.post(scratch, `warming up (${actor.name}) - ci ${env.runId}`);

    if (env.twin && env.targetChannel) {
      await env.qa.post(env.targetChannel, `target-channel warm-up - ci ${env.runId}`).catch(() => {});
    }
    for (const actor of env.actors.values()) {
      let verified = false;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const r = await env.core.resolveDirectory(actor.handle).catch(() => ({ members: [] as Array<unknown> }));
        if (r.members.length) {
          verified = true;
          break;
        }
        await sleep(2500);
      }
      console.log(
        `  🔥 warmed actor ${actor.name} (@${actor.handle} ${actor.mention})${verified ? "" : " — directory unverified, proceeding (scenarios address by id)"}`,
      );
    }
  } finally {
    await env.qa.archive(scratch).catch(() => {});
  }
}

function loadActorTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  const json = process.env.LIVE_E2E_ACTOR_TOKENS;
  if (json)
    for (const [name, token] of Object.entries(JSON.parse(json) as Record<string, string>))
      tokens.set(name.toLowerCase(), token);
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^LIVE_E2E_ACTOR_TOKEN_(.+)$/.exec(k);
    if (m && v) tokens.set(m[1]!.toLowerCase(), v);
  }
  return tokens;
}

async function resolveActors(): Promise<Map<string, Actor>> {
  const actors = new Map<string, Actor>();
  for (const [name, token] of loadActorTokens()) {
    const client = new SlackClient(token);
    try {
      const auth = await client.authTest();
      actors.set(name, { name, handle: auth.user, client, userId: auth.userId, mention: `<@${auth.userId}>` });
    } catch (err) {
      console.error(
        `  ⚠️  actor "${name}" token failed auth, dropping: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return actors;
}

function selectScenarios(env: Env): { selected: Scenario[]; skipped: ScenarioResult[] } {
  const raw = process.env.LIVE_E2E_FILTER;
  const filter = raw === "all" ? undefined : raw;
  const skipped: ScenarioResult[] = [];
  const selected: Scenario[] = [];
  for (const s of scenarios) {
    if (filter) {
      const byTag = filter.startsWith("@") && (s.tags ?? []).includes(filter.slice(1));
      if (!byTag && !s.name.includes(filter)) continue;
    }
    const tags = s.tags ?? [];
    if (tags.includes("sandbox") && !env.sandbox) {
      skipped.push({
        name: s.name,
        status: "skip",
        attempts: 0,
        durationMs: 0,
        skipReason: "SPRITES_TOKEN not set (no sandbox)",
      });
      continue;
    }
    if (tags.includes("needs-target-channel") && !env.targetChannel) {
      skipped.push({
        name: s.name,
        status: "skip",
        attempts: 0,
        durationMs: 0,
        skipReason: "LIVE_E2E_TARGET_CHANNEL not set",
      });
      continue;
    }
    if (tags.includes("twin") && !env.twin) {
      skipped.push({
        name: s.name,
        status: "skip",
        attempts: 0,
        durationMs: 0,
        skipReason: "not a twin-backed run (needs ARGA_TWIN_ADMIN_URL)",
      });
      continue;
    }
    if (tags.includes("no-twin") && env.twin) {
      skipped.push({
        name: s.name,
        status: "skip",
        attempts: 0,
        durationMs: 0,
        skipReason: "twin backend can't serve this capability (see the scenario's note)",
      });
      continue;
    }
    const missing = (s.actors ?? []).map((a) => a.toLowerCase()).filter((a) => !env.actors.has(a));
    if (missing.length) {
      skipped.push({
        name: s.name,
        status: "skip",
        attempts: 0,
        durationMs: 0,
        skipReason: `actors not available: ${missing.join(", ")}`,
      });
      continue;
    }
    selected.push(s);
  }
  return { selected, skipped };
}

function applyShard(
  selected: Scenario[],
  skipped: ScenarioResult[],
): { selected: Scenario[]; skipped: ScenarioResult[] } {
  const raw = process.env.LIVE_E2E_SHARD;
  if (!raw) return { selected, skipped };
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(raw);
  if (!m) throw new Error(`LIVE_E2E_SHARD must look like "2/3", got "${raw}"`);
  const [shard, total] = [Number(m[1]), Number(m[2])];
  if (shard > total) throw new Error(`LIVE_E2E_SHARD shard ${shard} > total ${total}`);
  const sorted = [...selected].sort((a, b) => a.name.localeCompare(b.name));
  return {
    selected: sorted.filter((_, i) => i % total === shard - 1),
    skipped: shard === 1 ? skipped : [],
  };
}

async function dumpTranscript(env: Env, scenario: Scenario, ctx: Ctx): Promise<string[]> {
  const sessionIds: string[] = [];
  if (ctx.dmChannelId) {
    const found = await env.core.findSessionByThread(ctx.dmChannelId).catch(() => null);
    if (found) {
      const llm = await env.core.getSessionLlm(found.id).catch(() => null);
      const file = path.join(OUT_DIR, "transcripts", `${slug(scenario.name)}-${found.id}.json`);
      await writeFile(
        file,
        JSON.stringify({ scenario: scenario.name, dm: ctx.dmChannelId, entries: found.entries, llm }, null, 2),
      );
      sessionIds.push(found.id);
    }
  }
  for (const ch of ctx.createdChannels) {
    const msgs = await env.qa.history(ch.id).catch(() => []);
    const roots = new Set(msgs.map((m) => m.thread_ts ?? m.ts));
    for (const root of roots) {
      const found = await env.core.findSessionByThread(ch.id, root).catch(() => null);
      if (!found) continue;
      const llm = await env.core.getSessionLlm(found.id).catch(() => null);
      const file = path.join(OUT_DIR, "transcripts", `${slug(scenario.name)}-${found.id}.json`);
      await writeFile(
        file,
        JSON.stringify({ scenario: scenario.name, channel: ch.id, entries: found.entries, llm }, null, 2),
      );
      sessionIds.push(found.id);
    }
  }
  return sessionIds;
}

async function runScenario(env: Env, scenario: Scenario): Promise<ScenarioResult> {
  const started = Date.now();
  const quarantined = (scenario.tags ?? []).includes("quarantine");
  const sessionIds: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctx = new Ctx(env, scenario, attempt);
    const timeoutMs = scenario.timeoutMs ?? 4 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        scenario.run(ctx),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`scenario timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      const timeline = ctx.timeline.toJSON();
      await ctx.cleanup();
      const status = attempt === 1 ? "pass" : "flaky";
      console.log(
        `  ${status === "pass" ? "✅" : "🟡"} ${scenario.name} (${Math.round((Date.now() - started) / 1000)}s${attempt > 1 ? ", retried" : ""})`,
      );
      return {
        name: scenario.name,
        status,
        attempts: attempt,
        durationMs: Date.now() - started,
        timeline,
        ...(quarantined ? { quarantined } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(`  ❌ ${scenario.name} attempt ${attempt}: ${message.split("\n")[0]}`);
      const timeline = ctx.timeline.toJSON();
      const ids = await dumpTranscript(env, scenario, ctx).catch(() => [] as string[]);
      sessionIds.push(...ids);
      await ctx.cleanup().catch(() => {});
      if (attempt === 2) {
        const coreErrors = await env.core
          .listErrors()
          .then((r) =>
            r.errors
              .filter((e) => e.category === "turn")
              .filter((e) => (sessionIds.length ? !!e.sessionId && sessionIds.includes(e.sessionId) : e.ts >= started))
              .map((e) => e.message),
          )
          .catch(() => [] as string[]);
        return {
          name: scenario.name,
          status: "fail",
          attempts: 2,
          durationMs: Date.now() - started,
          error: message,
          timeline,
          ...(quarantined ? { quarantined } : {}),
          ...(coreErrors.length ? { coreErrors } : {}),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("unreachable");
}

async function runLane(env: Env, lane: Scenario[], concurrency: number): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const queue = [...lane];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      results.push(await runScenario(env, s));
    }
  });
  await Promise.all(workers);
  return results;
}

function renderSummary(results: ScenarioResult[], runId: string): string {
  const lines = [
    `## Live Slack E2E — run ${runId}`,
    "",
    "| scenario | status | attempts | duration |",
    "|---|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.status}${r.quarantined ? " (quarantined)" : ""}${r.skipReason ? ` (${r.skipReason})` : ""} | ${r.attempts} | ${Math.round(r.durationMs / 1000)}s |`,
    ),
    "",
  ];
  for (const r of results.filter((x) => x.status === "fail")) {
    lines.push(`### ❌ ${r.name}`, "```", (r.error ?? "").slice(0, 2000), "```", "");
    if (r.coreErrors?.length) {
      lines.push(
        "Core turn errors during this scenario:",
        "```",
        r.coreErrors.map((e) => e.slice(0, 500)).join("\n"),
        "```",
        "",
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  await mkdir(path.join(OUT_DIR, "transcripts"), { recursive: true });
  const env = await buildEnv();
  const pump = maybeStartEventPump(env);
  await pump?.ready;
  try {
    await runCatalog(env);
  } finally {
    await pump?.stop();
  }
}

async function runCatalog(env: Env): Promise<void> {
  await warmUp(env);
  const picked = selectScenarios(env);
  const { selected, skipped } = applyShard(picked.selected, picked.skipped);
  for (const s of skipped) console.log(`  ⏭️  ${s.name}: skipped — ${s.skipReason}`);
  const concurrency = Number(process.env.LIVE_E2E_CONCURRENCY) || 8;
  console.log(
    `live-e2e run ${env.runId}: ${selected.length} scenarios (concurrency ${concurrency}), agent <@${env.botUserId}>, QA user <@${env.qaUserId}>`,
  );

  const parallelLane = selected.filter((s) => s.lane === "parallel");
  const dmLane = selected.filter((s) => s.lane === "dm");
  const exclusiveLane = selected.filter((s) => s.lane === "exclusive");
  const [parallelResults, dmResults] = await Promise.all([
    runLane(env, parallelLane, concurrency),
    runLane(env, dmLane, 1),
  ]);
  const exclusiveResults = await runLane(env, exclusiveLane, 1);

  const results = [...parallelResults, ...dmResults, ...exclusiveResults, ...skipped];
  results.sort((a, b) => a.name.localeCompare(b.name));
  const failures = results.filter((r) => r.status === "fail" && !r.quarantined);
  const quarantinedFails = results.filter((r) => r.status === "fail" && r.quarantined);
  const flaky = results.filter((r) => r.status === "flaky");

  const summary = renderSummary(results, env.runId);
  await writeFile(
    path.join(OUT_DIR, "results.json"),
    JSON.stringify({ runId: env.runId, teamId: env.teamId, results }, null, 2),
  );
  await writeFile(path.join(OUT_DIR, "summary.md"), summary);
  await writeFile(path.join(OUT_DIR, "gallery.html"), renderGallery(env.runId, results));
  console.log(`  📸 gallery: ${path.join(OUT_DIR, "gallery.html")}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);

  console.log(
    `\n${results.length - failures.length - quarantinedFails.length - flaky.length - skipped.length} passed, ${flaky.length} flaky, ${failures.length} failed, ${quarantinedFails.length} quarantined-fail, ${skipped.length} skipped`,
  );

  if (failures.length) {
    const runUrl =
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "(local run)";
    const causeLines = failures
      .filter((f) => f.coreErrors?.length)
      .map((f) => `• ${f.name}: ${f.coreErrors![0]!.slice(0, 300)}`);
    const text =
      `:rotating_light: live-e2e failed — ${failures.map((f) => f.name).join(", ")}\n${runUrl}` +
      (causeLines.length ? `\n${causeLines.join("\n")}` : "");
    if (process.env.SLACK_ALERT_REQUIRED === "1") {
      const alertBot = process.env.SLACK_ALERT_BOT_TOKEN
        ? new SlackClient(process.env.SLACK_ALERT_BOT_TOKEN, "https://slack.com")
        : env.bot;
      await alertBot.post(requireEnv("SLACK_ALERT_CHANNEL"), text);
    } else if (process.env.SLACK_ALERT_CHANNEL) {
      await env.bot
        .post(process.env.SLACK_ALERT_CHANNEL, text)
        .catch((err: Error) => console.error(`alert post failed: ${err.message}`));
    }
  }

  process.exitCode = liveRunExitCode(failures.length, process.env.LIVE_E2E_OBSERVATIONAL === "1");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
