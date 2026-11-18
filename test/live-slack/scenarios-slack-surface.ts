import path from "node:path";
import { launchFirefox, SHOTS_DIR, slackPage, threadUrl } from "./browser.ts";
import { assert, type Ctx, type Scenario } from "./harness.ts";
import { sleep, type SlackMessage } from "./slack.ts";

const botReactions = (ctx: Ctx, message?: SlackMessage): string[] =>
  (message?.reactions ?? []).filter((r) => r.users.includes(ctx.env.botUserId)).map((r) => r.name);

export const slackSurfaceScenarios: Scenario[] = [
  {
    name: "group-dm-mention-reply",
    lane: "parallel",
    tags: ["group-dm", "slack-surface"],
    async run(ctx) {
      const gdm = await ctx.groupDm();
      const marker = ctx.marker();
      const root = await gdm.mention(`group DM check: include the exact token ${marker} in your reply.`);
      await gdm.waitForBotReply(root, { match: new RegExp(marker), includeChannel: true });
    },
  },
  {
    name: "group-dm-thread-followup",
    lane: "parallel",
    tags: ["group-dm", "slack-surface"],
    async run(ctx) {
      const gdm = await ctx.groupDm();
      const code = ctx.marker("code");
      const root = await gdm.mention(`remember the codeword ${code}; acknowledge briefly in this thread.`);
      await gdm.waitForBotReply(root);
      const follow = await gdm.mention("what was the codeword? Repeat it exactly.", root);
      const reply = await gdm.waitForBotReply(root, { afterTs: follow, match: new RegExp(code) });
      assert.equal(reply.thread_ts, root, "follow-up reply left the thread");
    },
  },
  {
    name: "react-tool-on-request",
    lane: "parallel",
    tags: ["slack-surface"],
    async run(ctx) {
      const ch = await ctx.freshChannel();
      const root = await ch.mention("React to this message with the :tada: emoji. No text reply is needed.");
      for (const deadline = Date.now() + 180_000; Date.now() < deadline; await sleep(1000)) {
        const [request] = await ctx.env.qa.replies(ch.id, root);
        if (botReactions(ctx, request).includes("tada")) return;
      }
      throw new Error("bot never added :tada: to the request");
    },
  },
  {
    name: "cron-fires-into-dm",
    lane: "dm",
    tags: ["sandbox", "slack-surface"],
    timeoutMs: 8 * 60_000,
    async run(ctx) {
      const dm = await ctx.dm();
      const marker = ctx.marker();
      const ask = await dm.send(
        `Schedule a one-off reminder to me for 1 minute from now with the exact text "${marker}", delivered here. Confirm briefly once scheduled.`,
      );
      const confirm = await dm.waitForBotReply(ask, { timeoutMs: 4 * 60_000 });
      await dm.waitForBotReply(confirm.ts, {
        match: new RegExp(marker),
        accept: (m) => Number(m.ts) - Number(ask) >= 50,
        timeoutMs: 4 * 60_000,
      });
    },
  },
  {
    name: "keychain-approval-real-click",
    lane: "dm",
    tags: ["browser", "sandbox", "keychain", "slack-surface"],
    timeoutMs: 12 * 60_000,
    async run(ctx) {
      const marker = ctx.marker();
      const service = `demo-click-${ctx.env.runId}`;
      const fixture = `fixture-${marker}`;
      const dm = await ctx.dm();
      const seed = await dm.send(
        `Register this synthetic test value in my keychain (it is not a real secret): POST /v1/keychain/credentials with service "${service}", envKey "DEMO_FIXTURE", secret "${fixture}". Reply DONE when saved.`,
      );
      await dm.waitForBotReply(seed, { match: /DONE/ });
      const ch = await ctx.freshChannel();
      const root = await ch.mention(
        `Using my ${service} credential, run \`printf %s "$DEMO_FIXTURE" | wc -c\` on your computer, requesting access through the keychain if needed, and reply COUNT=<number>.`,
      );
      await ch.waitForBotReply(root, {
        includeChannel: true,
        timeoutMs: 5 * 60_000,
        accept: (m) => (m.blocks ?? []).some((b) => b.type === "actions"),
      });
      const browser = await launchFirefox();
      try {
        const page = await slackPage(browser);
        await page.goto(threadUrl(ctx.env.teamId, ch.id, root), { waitUntil: "domcontentloaded" });
        const button = page.locator('[data-qa="threads_flexpane"] button', { hasText: "Allow once" }).last();
        await button.waitFor({ timeout: 60_000 });
        await page.screenshot({ path: path.join(SHOTS_DIR, `${marker}-before-click.png`) });
        await button.click();
        await sleep(3000);
        await page.screenshot({ path: path.join(SHOTS_DIR, `${marker}-after-click.png`) });
      } finally {
        await browser.close();
      }
      const count = new RegExp(`COUNT=\\s*${fixture.length}\\b`);
      await ch.waitForBotReply(root, { match: count, includeChannel: true, timeoutMs: 4 * 60_000 });
    },
  },
];
