import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { SlackClient } from "./slack.ts";
import { CoreClient } from "./core.ts";
import {
  Ctx,
  isLiveStatusText,
  liveRunExitCode,
  releaseBlockers,
  slug,
  type Actor,
  type Env,
  type Scenario,
  type ScenarioResult,
} from "./harness.ts";
import { renderGallery } from "./gallery.ts";
import { scenarios } from "./scenarios.ts";
import { sandboxProviderScenarios, selectSandboxProviderScenarios } from "./scenarios-sandbox-providers.ts";
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
  const core = new CoreClient(
    requireEnv("CORE_API_URL"),
    requireEnv("CORE_SIGNING_SECRET"),
    process.env.LIVE_E2E_ORG_SCOPE || undefined,
  );
  const [qaAuth, botAuth] = await Promise.all([
    qa.authTest(),
    process.env.LIVE_E2E_BOT_USER_ID ? undefined : bot.authTest(),
  ]);
  const botUserId = process.env.LIVE_E2E_BOT_USER_ID ?? botAuth?.userId;
  if (!botUserId) throw new Error("SLACK_BOT_TOKEN auth.test returned no user id");
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
    botUserId,
    qaUserId: qaAuth.userId,
    teamId: qaAuth.teamId,
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    judgeModel: process.env.LIVE_E2E_JUDGE_MODEL ?? "claude-haiku-4-5-20251001",
    ...(process.env.LIVE_E2E_TARGET_CHANNEL ? { targetChannel: process.env.LIVE_E2E_TARGET_CHANNEL } : {}),
    sandbox:
      process.env.LIVE_E2E_SANDBOX_AVAILABLE === "1" ||
      Boolean(process.env.SPRITES_TOKEN) ||
      Boolean(process.env.FLY_API_TOKEN),
    actors: await resolveActors(),
    ...(twin ? { twin } : {}),
  };
}

function maybeStartEventPump(env: Env): import("./arga.ts").EventPump | undefined {
  if (!env.twin) return undefined;
  const port = process.env.SLACK_EVENTS_PORT ?? "8182";
  const targetUrl = process.env.SLACK_EVENTS_TARGET_URL ?? `http://127.0.0.1:${port}/slack/events`;
  const signingSecret = requireEnv("SLACK_SIGNING_SECRET");
  const pump = startEventPump({
    admin: env.twin,
    signingSecret,
    targetUrl,
    botUserId: env.botUserId,
  });
  console.log(`  🔁 twin event pump → ${targetUrl}`);
  return pump;
}

async function warmUp(env: Env, required = false): Promise<void> {
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
    if (!warmed && required) throw new Error("release gate warm-up received no bot reply in 180s");

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
  const providerScenarios = selectSandboxProviderScenarios(process.env.LIVE_E2E_SANDBOX_PROVIDERS);
  for (const s of [...scenarios, ...providerScenarios]) {
    if (filter) {
      const byTag = filter.startsWith("@") && (s.tags ?? []).includes(filter.slice(1));
      if (!byTag && !s.name.includes(filter) && !s.tags?.includes("provider-execution")) continue;
    }
    const tags = s.tags ?? [];
    if (tags.includes("sandbox") && !env.sandbox) {
      skipped.push({
        name: s.name,
        status: "skip",
        attempts: 0,
        durationMs: 0,
        skipReason: "sandbox unavailable",
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
  const maxAttempts = scenario.tags?.includes("provider-execution") ? 1 : 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctx = new Ctx(env, scenario, attempt);
    const timeoutMs = scenario.timeoutMs ?? 4 * 60_000;
    let timer: NodeJS.Timeout | undefined;
    const operation = scenario.run(ctx);
    try {
      await Promise.race([
        operation,
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
      if (scenario.tags?.includes("provider-execution")) await operation.catch(() => {});
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(`  ❌ ${scenario.name} attempt ${attempt}: ${message.split("\n")[0]}`);
      const timeline = ctx.timeline.toJSON();
      const ids = await dumpTranscript(env, scenario, ctx).catch(() => [] as string[]);
      sessionIds.push(...ids);
      await ctx.cleanup().catch(() => {});
      if (attempt === maxAttempts) {
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
          attempts: maxAttempts,
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
  const releaseGate = process.env.LIVE_E2E_GATE === "1";
  await warmUp(env, releaseGate);
  const picked = selectScenarios(env);
  const { selected, skipped } = applyShard(picked.selected, picked.skipped);
  if (releaseGate) {
    for (const provider of selectSandboxProviderScenarios(process.env.LIVE_E2E_SANDBOX_PROVIDERS)) {
      if (!selected.some((scenario) => scenario.name === provider.name))
        throw new Error(`required provider scenario missing from release gate: ${provider.name}`);
    }
  }
  if (releaseGate && selected.length === 0) throw new Error("release gate selected no scenarios");
  for (const s of skipped) console.log(`  ⏭️  ${s.name}: skipped — ${s.skipReason}`);
  const concurrency = Number(process.env.LIVE_E2E_CONCURRENCY) || 8;
  console.log(
    `live-e2e run ${env.runId}: ${selected.length} scenarios (concurrency ${concurrency}), agent <@${env.botUserId}>, QA user <@${env.qaUserId}>`,
  );

  const providerLane = selected.filter((s) => s.tags?.includes("provider-execution"));
  const parallelLane = selected.filter((s) => s.lane === "parallel" && !s.tags?.includes("provider-execution"));
  const dmLane = selected.filter((s) => s.lane === "dm");
  const exclusiveLane = selected.filter((s) => s.lane === "exclusive");
  const [parallelResults, dmResults, providerResults] = await Promise.all([
    runLane(env, parallelLane, concurrency),
    runLane(env, dmLane, 1),
    runLane(env, providerLane, sandboxProviderScenarios.length),
  ]);
  const exclusiveResults = await runLane(env, exclusiveLane, 1);

  const results = [...parallelResults, ...dmResults, ...providerResults, ...exclusiveResults, ...skipped];
  results.sort((a, b) => a.name.localeCompare(b.name));
  const failures = results.filter((r) => r.status === "fail" && !r.quarantined);
  const quarantinedFails = results.filter((r) => r.status === "fail" && r.quarantined);
  const flaky = results.filter((r) => r.status === "flaky");
  const blockers = releaseGate ? releaseBlockers(results) : failures;

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

  if (blockers.length) {
    const runUrl =
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : "(local run)";
    const causeLines = blockers
      .filter((f) => f.coreErrors?.length)
      .map((f) => `• ${f.name}: ${f.coreErrors![0]!.slice(0, 300)}`);
    const text =
      `:rotating_light: live-e2e failed — ${blockers.map((f) => f.name).join(", ")}\n${runUrl}` +
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

  process.exitCode = liveRunExitCode(blockers.length, process.env.LIVE_E2E_OBSERVATIONAL === "1");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
