import assert from "node:assert";
import { SlackClient, sleep, type SlackMessage } from "./slack.ts";
import { CoreClient } from "./core.ts";

export interface Scenario {
  name: string;
  lane: "parallel" | "dm" | "exclusive";
  tags?: string[];
  actors?: string[];
  timeoutMs?: number;
  run(ctx: Ctx): Promise<void>;
}

export interface ScenarioResult {
  name: string;
  status: "pass" | "fail" | "flaky" | "skip";
  attempts: number;
  durationMs: number;
  error?: string;
  coreErrors?: string[];
  permalink?: string;
  skipReason?: string;
  quarantined?: boolean;
  timeline?: TimelineSnapshot;
}

export function liveRunExitCode(failures: number, observational: boolean): 0 | 1 {
  return failures > 0 && !observational ? 1 : 0;
}

export type TimelineSnapshot = ReturnType<Timeline["toJSON"]>;

export interface Env {
  runId: string;
  qa: SlackClient;
  bot: SlackClient;
  core: CoreClient;
  botUserId: string;
  qaUserId: string;
  teamId: string;
  anthropicApiKey: string;
  judgeModel: string;
  targetChannel?: string;
  sandbox: boolean;
  actors: Map<string, Actor>;
  twin?: import("./arga.ts").TwinAdmin;
}

export interface Actor {
  readonly name: string;
  readonly handle: string;
  readonly client: SlackClient;
  readonly userId: string;
  readonly mention: string;
}

export interface ActorPoster {
  mention(text: string, threadTs?: string): Promise<string>;
  say(text: string, threadTs?: string): Promise<string>;
  threadReply(rootTs: string, text: string): Promise<string>;
}

export const TICKER_FRAME_RE = /^(?:[⚙⏳]|:gear:|:hourglass_flowing_sand:) .*… \d+s/u;
export const INLINE_LIVE_STATUS_RE =
  /\n\n(?:(?:[⚙⏳]|:gear:|:hourglass_flowing_sand:) .*… \d+s|(?:💭|:thought_balloon:) )/u;
export function isLiveStatusText(text: string): boolean {
  if (TICKER_FRAME_RE.test(text)) return true;
  if (/^(?:💭|:thought_balloon:) /u.test(text)) return true;
  if (INLINE_LIVE_STATUS_RE.test(text)) return true;
  if (text.trimEnd().endsWith("▌")) return true;
  return false;
}

const POLL_MS = 2500;
const STABLE_MS = 5000;

export interface WaitOpts {
  timeoutMs?: number;
  match?: RegExp;
  afterTs?: string;
  onFrame?: (text: string) => void;
  record?: (msgTs: string, text: string) => void;
}

async function waitForFinalBotMessage(
  fetchMessages: () => Promise<SlackMessage[]>,
  botUserId: string,
  afterTs: string,
  opts: WaitOpts = {},
): Promise<SlackMessage> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const deadline = Date.now() + timeoutMs;
  const seen = new Map<string, { text: string; firstSeen: number }>();
  let lastSeen = "";
  while (Date.now() < deadline) {
    const messages = await fetchMessages();
    const fromBot = messages.filter((m) => m.user === botUserId && Number(m.ts) > Number(afterTs));
    for (const m of fromBot) {
      const text = m.text ?? "";
      if (text !== lastSeen) {
        lastSeen = text;
        opts.onFrame?.(text);
      }
      const prev = seen.get(m.ts);
      if (!prev || prev.text !== text) {
        seen.set(m.ts, { text, firstSeen: Date.now() });
        opts.record?.(m.ts, text);
      }
    }
    for (const m of fromBot) {
      const text = m.text ?? "";
      if (isLiveStatusText(text)) continue;
      if (opts.match && !opts.match.test(text)) continue;
      const entry = seen.get(m.ts);
      if (entry && entry.text === text && Date.now() - entry.firstSeen >= STABLE_MS) return m;
    }
    await sleep(POLL_MS);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for a final bot reply${opts.match ? ` matching ${opts.match}` : ""} (last seen: ${JSON.stringify(lastSeen.slice(0, 200))})`,
  );
}

export interface TimelineVersion {
  text: string;
  atMs: number;
}

export interface TimelinePost {
  atMs: number;
  channelId: string;
  rootTs: string;
  author: string;
  text: string;
  msgTs: string;
  kind: "channel" | "dm";
}

export interface TimelineBotMessage {
  key: string;
  channelId: string;
  ts: string;
  firstMs: number;
  versions: TimelineVersion[];
  permalink?: string;
}

export interface TimelineThread {
  channelId: string;
  rootTs: string;
  kind: "channel" | "dm";
  permalink?: string;
}

export class Timeline {
  readonly startMs = Date.now();
  readonly posts: TimelinePost[] = [];
  readonly threads: TimelineThread[] = [];
  private readonly bots = new Map<string, TimelineBotMessage>();

  private elapsed(): number {
    return Date.now() - this.startMs;
  }

  private registerThread(channelId: string, rootTs: string, kind: "channel" | "dm"): void {
    if (!this.threads.some((t) => t.channelId === channelId && t.rootTs === rootTs)) {
      this.threads.push({ channelId, rootTs, kind });
    }
  }

  recordPost(
    channelId: string,
    rootTs: string,
    author: string,
    text: string,
    msgTs: string,
    kind: "channel" | "dm",
  ): void {
    this.registerThread(channelId, rootTs, kind);
    this.posts.push({ atMs: this.elapsed(), channelId, rootTs, author, text, msgTs, kind });
  }

  recordBotVersion(channelId: string, ts: string, text: string): void {
    const key = `${channelId}:${ts}`;
    let msg = this.bots.get(key);
    if (!msg) {
      msg = { key, channelId, ts, firstMs: this.elapsed(), versions: [] };
      this.bots.set(key, msg);
    }
    const last = msg.versions[msg.versions.length - 1];
    if (!last || last.text !== text) msg.versions.push({ text, atMs: this.elapsed() });
  }

  async resolvePermalink(client: SlackClient, channelId: string, ts: string): Promise<void> {
    const msg = this.bots.get(`${channelId}:${ts}`);
    if (msg && !msg.permalink) msg.permalink = await client.getPermalink(channelId, ts).catch(() => undefined);
  }

  botMessages(): TimelineBotMessage[] {
    return [...this.bots.values()].sort((a, b) => a.firstMs - b.firstMs);
  }

  toJSON(): { posts: TimelinePost[]; threads: TimelineThread[]; botMessages: TimelineBotMessage[] } {
    return { posts: this.posts, threads: this.threads, botMessages: this.botMessages() };
  }
}

export class ChannelHandle {
  private readonly ctx: Ctx;
  private readonly env: Env;
  readonly id: string;
  readonly name: string;

  constructor(ctx: Ctx, id: string, name: string) {
    this.ctx = ctx;
    this.env = ctx.env;
    this.id = id;
    this.name = name;
  }

  async mention(text: string, threadTs?: string): Promise<string> {
    return this.postAs(this.env.qa, "qa", `<@${this.env.botUserId}> ${text}`, `@agent ${text}`, threadTs);
  }

  async threadReply(rootTs: string, text: string): Promise<string> {
    return this.postAs(this.env.qa, "qa", text, text, rootTs);
  }

  as(actor: Actor): ActorPoster {
    return {
      mention: (text, threadTs) =>
        this.postAs(actor.client, actor.name, `<@${this.env.botUserId}> ${text}`, `@agent ${text}`, threadTs),
      say: (text, threadTs) => this.postAs(actor.client, actor.name, text, text, threadTs),
      threadReply: (rootTs, text) => this.postAs(actor.client, actor.name, text, text, rootTs),
    };
  }

  private async postAs(
    client: SlackClient,
    author: string,
    wire: string,
    recorded: string,
    threadTs?: string,
  ): Promise<string> {
    const ts = await client.post(this.id, wire, threadTs);
    this.ctx.timeline.recordPost(this.id, threadTs ?? ts, author, recorded, ts, "channel");
    return ts;
  }

  async waitForBotReply(rootTs: string, opts: WaitOpts = {}): Promise<SlackMessage> {
    const msg = await waitForFinalBotMessage(
      () => this.env.qa.replies(this.id, rootTs),
      this.env.botUserId,
      opts.afterTs ?? rootTs,
      {
        ...opts,
        record: (ts, text) => this.ctx.timeline.recordBotVersion(this.id, ts, text),
      },
    );
    await this.ctx.timeline.resolvePermalink(this.env.qa, this.id, msg.ts);
    return msg;
  }

  async botMessagesInThread(rootTs: string): Promise<SlackMessage[]> {
    const msgs = await this.env.qa.replies(this.id, rootTs);
    return msgs.filter((m) => m.user === this.env.botUserId);
  }
}

export class DmHandle {
  private readonly ctx: Ctx;
  private readonly env: Env;
  readonly id: string;

  constructor(ctx: Ctx, id: string) {
    this.ctx = ctx;
    this.env = ctx.env;
    this.id = id;
  }

  async send(text: string): Promise<string> {
    const ts = await this.env.qa.post(this.id, text);
    this.ctx.timeline.recordPost(this.id, ts, "qa", text, ts, "dm");
    return ts;
  }

  async waitForBotReply(afterTs: string, opts: WaitOpts = {}): Promise<SlackMessage> {
    const msg = await waitForFinalBotMessage(() => this.env.qa.history(this.id, afterTs), this.env.botUserId, afterTs, {
      ...opts,
      record: (ts, text) => this.ctx.timeline.recordBotVersion(this.id, ts, text),
    });
    await this.ctx.timeline.resolvePermalink(this.env.qa, this.id, msg.ts);
    return msg;
  }
}

export class Ctx {
  readonly createdChannels: Array<{ id: string; rootTs?: string }> = [];
  private dmChannel: DmHandle | null = null;
  readonly env: Env;
  readonly scenario: Scenario;
  readonly timeline = new Timeline();
  private readonly attempt: number;

  constructor(env: Env, scenario: Scenario, attempt: number) {
    this.env = env;
    this.scenario = scenario;
    this.attempt = attempt;
  }

  marker(suffix = ""): string {
    return `ci-${this.env.runId}-${slug(this.scenario.name)}${this.attempt > 1 ? `-r${this.attempt}` : ""}${suffix ? `-${suffix}` : ""}`;
  }

  async freshChannel(): Promise<ChannelHandle> {
    const name = this.marker()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 75);
    const id = await this.env.qa.createChannel(name);
    this.createdChannels.push({ id });
    await this.env.qa.invite(id, this.env.botUserId);
    for (const name of this.scenario.actors ?? []) {
      await this.env.qa.invite(id, this.actor(name).userId);
    }
    return new ChannelHandle(this, id, name);
  }

  actor(name: string): Actor {
    const a = this.env.actors.get(name.toLowerCase());
    if (!a) throw new Error(`actor "${name}" not available (declare it in the scenario's actors[] and set its token)`);
    return a;
  }

  async dm(): Promise<DmHandle> {
    if (!this.dmChannel) {
      const id = await this.env.qa.openDm(this.env.botUserId);
      this.dmChannel = new DmHandle(this, id);
    }
    return this.dmChannel;
  }

  get dmChannelId(): string | null {
    return this.dmChannel?.id ?? null;
  }

  get core(): CoreClient {
    return this.env.core;
  }

  async judge(question: string, content: string): Promise<void> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.env.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.env.judgeModel,
        max_tokens: 300,
        system: `You are a strict test judge for an AI assistant's Slack replies. Today's date is ${new Date().toISOString().slice(0, 10)}. Answer with exactly PASS or FAIL on the first line, then a one-sentence reason. Judge only what is asked; tone and verbosity are irrelevant unless the question asks about them.`,
        messages: [{ role: "user", content: `Question: ${question}\n\nContent to judge:\n${content}` }],
      }),
    });
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    if (!res.ok) throw new Error(`judge call failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    const verdict = (data.content?.[0]?.text ?? "").trim();
    assert.ok(/^PASS\b/i.test(verdict), `judge failed: ${question}\n${verdict}`);
  }

  async cleanup(): Promise<void> {
    for (const ch of this.createdChannels) await this.env.qa.archive(ch.id);
    try {
      const { crons } = await this.env.core.listCrons();
      for (const c of crons) {
        if ((c.message ?? c.action)?.includes(this.marker())) await this.env.core.deleteCron(c).catch(() => {});
      }
    } catch {
      void 0;
    }
  }
}

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export { assert };
