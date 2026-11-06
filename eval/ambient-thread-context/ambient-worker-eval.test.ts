import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createMirror } from "../src/slack/mirror.ts";

const OUT = process.env.EVAL_OUT ?? "/tmp/eval/worker.jsonl";
const RUNS = Number(process.env.EVAL_RUNS ?? 1);
const ONLY = process.env.EVAL_ONLY?.split(",");
const JUDGE = process.env.EVAL_JUDGE ?? "claude-haiku-5-5";
const WORKER = process.env.EVAL_WORKER ?? "claude-sonnet-5";
const LABEL = process.env.EVAL_LABEL ?? "?";

const DEAL_ORDERS = [
  "Watch the whole channel — top-level messages and all threads — for investment deal discussions, even when nobody mentions QM. Keep different companies strictly separate.",
  "When the conversation clearly supports participating in a deal, proactively post a concise summary (company, round, check size, cap or post-money, sponsor) and ask whether to create a new memo or update an existing memo and move it to Participating.",
  "Never suggest creating a memo for a pass. If a deal or decision is ambiguous, ask only the clarification strictly needed.",
  "Do not repeat an offer that is already pending for the same company; only re-offer if material terms change, and say what changed.",
  "If someone says to hold off after an offer, acknowledge that it is on hold. Otherwise stay silent.",
  "Suggestions only: never create or update memos.",
].join("\n");
const ALERT_ORDERS = "Triage new Monitor alerts: reply in the alert's thread with what is affected, how severe it is, and a suggested next step. Stay silent on chatter.";

type Msg = { id: string; user?: string; name?: string; qm?: boolean; bot?: string; text: string; thread?: string };
const A = { user: "UALICE", name: "Alice" }, B = { user: "UBOB", name: "Bob" }, C = { user: "UCAROL", name: "Carol" };
const filler: Msg[] = [
  { id: "f1", ...C, text: "Met the Gamma Robotics founders today, they're early but sharp." },
  { id: "f2", ...B, thread: "f1", text: "Nice, what are they building exactly?" },
  { id: "f3", ...C, thread: "f1", text: "Warehouse picking arms. Still pre-revenue." },
  { id: "f4", ...A, text: "Reminder: partner lunch moved to 1pm tomorrow." },
  { id: "f5", ...B, text: "Has anyone seen the new office seating chart?" },
  { id: "f6", ...C, thread: "f5", text: "It's pinned in the ops channel." },
  { id: "f7", ...A, text: "Delta Health sent over their Q3 update, looks steady." },
  { id: "f8", ...B, thread: "f7", text: "Thanks, I'll read it tonight." },
  { id: "f9", ...C, text: "Heads up, I'm out Friday afternoon." },
  { id: "f10", ...A, text: "Anyone have a good recruiter contact for robotics hires?" },
  { id: "f11", ...B, thread: "f10", text: "I'll dig one up." },
];
type Scenario = { orders: string; history: Msg[]; final: Msg; leak: RegExp; neighbour: RegExp; want: RegExp[] };
const SCENARIOS: Record<string, Scenario> = {
  "neighbouring deals": {
    orders: DEAL_ORDERS,
    history: [
      { id: "ex", ...A, text: "Example Co is raising a seed on a $10m post-money SAFE. References were strong — I think we should participate for $100k, Dana would sponsor." },
      { id: "offer", qm: true, thread: "ex", text: "Example Co — seed, $100k on a $10m post-money SAFE, sponsor Dana. Want me to create a new memo or update an existing one and move it to Participating?" },
      { id: "gamma", ...C, text: "Gamma Robotics update: $4m ARR, raising a $15m Series A at $90m pre. We're passing — too early for us." },
      { id: "beta", ...B, text: "Beta Labs is raising a seed round. Intro call went well." },
      { id: "beta2", ...C, thread: "beta", text: "Their retention cohort looks solid." },
    ],
    final: { id: "f", ...B, thread: "beta", text: "References checked out. Let's participate in Beta Labs for $150k on a $20m post-money SAFE; Eli sponsors." },
    leak: /\$100k|\$10m|Dana|\$4m|\$15m|\$90m/i,
    neighbour: /Example Co|Gamma/i,
    want: [/Beta Labs/i, /150/, /20m|20 ?M|\$20/i, /Eli/],
  },
  "neighbouring deals, partial terms": {
    orders: DEAL_ORDERS,
    history: [
      { id: "ex", ...A, text: "Example Co is raising a seed on a $10m post-money SAFE. References were strong — I think we should participate for $100k, Dana would sponsor." },
      { id: "offer", qm: true, thread: "ex", text: "Example Co — seed, $100k on a $10m post-money SAFE, sponsor Dana. Want me to create a new memo or update an existing one and move it to Participating?" },
      { id: "beta", ...B, text: "Beta Labs is raising a seed round. Intro call went well." },
    ],
    final: { id: "f", ...C, thread: "beta", text: "References checked out — let's participate in Beta Labs. Eli will sponsor." },
    leak: /\$100k|\$10m|Dana/i,
    neighbour: /Example Co/i,
    want: [/Beta Labs/i, /Eli/],
  },
  "keep: cross-thread hold": {
    orders: DEAL_ORDERS,
    history: [
      { id: "ex", ...A, text: "Example Co is raising a seed on a $10m post-money SAFE. References were strong — I think we should participate for $100k, Dana would sponsor." },
      { id: "offer", qm: true, thread: "ex", text: "Example Co — seed, $100k on a $10m post-money SAFE, sponsor Dana. Want me to create a new memo or update an existing one and move it to Participating?" },
      { id: "gamma", ...C, text: "Met the Gamma Robotics founders today, they're early but sharp." },
    ],
    final: { id: "f", ...B, thread: "gamma", text: "Unrelated to Gamma, but hold off on Example Co for now — legal flagged something." },
    leak: /\$4m|Series A/i,
    neighbour: /Gamma/i,
    want: [/Example Co/i, /hold|paus/i],
  },
  "keep: correction from another thread": {
    orders: DEAL_ORDERS,
    history: [
      { id: "ex", ...A, text: "Example Co is raising a seed on a $10m post-money SAFE. References were strong — I think we should participate for $100k, Dana would sponsor." },
      { id: "offer", qm: true, thread: "ex", text: "Example Co — seed, $100k on a $10m post-money SAFE, sponsor Dana. Want me to create a new memo or update an existing one and move it to Participating?" },
      { id: "corr", ...B, thread: "ex", text: "Small correction: Example Co is $150k on a $12m post-money SAFE." },
      { id: "gamma", ...C, text: "Met the Gamma Robotics founders today, they're early but sharp." },
    ],
    final: { id: "f", ...A, text: "Example Co: references are done, we're good to go — please set it up." },
    leak: /\$100k|\$10m/i,
    neighbour: /Gamma/i,
    want: [/Example Co/i, /150/, /12m|12 ?M|\$12/i],
  },
  "keep: thread follow-up after QM's offer scrolled out": {
    orders: DEAL_ORDERS,
    history: [
      { id: "ex", ...A, text: "Example Co is raising a seed on a $10m post-money SAFE. References were strong — I think we should participate for $100k, Dana would sponsor." },
      { id: "offer", qm: true, thread: "ex", text: "Example Co — seed, $100k on a $10m post-money SAFE, sponsor Dana. Want me to create a new memo or update an existing one and move it to Participating?" },
      ...filler,
    ],
    final: { id: "f", ...A, thread: "ex", text: "Update the existing one please." },
    leak: /Gamma|Delta|recruit|lunch/i,
    neighbour: /Gamma|Delta/i,
    want: [/Example Co/i],
  },
  "neighbouring alerts": {
    orders: ALERT_ORDERS,
    history: [
      { id: "a1", bot: "Monitor", text: "ALERT payments-api: 5xx error rate 7.2% in us-east-1 (threshold 2%)" },
      { id: "t1", qm: true, thread: "a1", text: "payments-api 5xx at 7.2% in us-east-1 — started right after the 14:02 deploy. Suggest rolling back that deploy." },
      { id: "a2", bot: "Monitor", text: "ALERT checkout-web: p95 latency 4.8s (threshold 2s)" },
      { id: "t2", qm: true, thread: "a2", text: "checkout-web p95 at 4.8s — upstream calls to payments-api are slow, likely the same incident. Watch after the rollback." },
      { id: "h1", ...B, thread: "a1", text: "Rolled back payments-api, error rate dropping." },
    ],
    final: { id: "f", bot: "Monitor", text: "ALERT search-indexer: queue lag 41 min (threshold 10 min)" },
    leak: /7\.2|us-east|4\.8|14:02|roll(ed|ing)? ?back/i,
    neighbour: /payments|checkout/i,
    want: [/search-indexer/i, /41/],
  },
};

for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (ONLY && !ONLY.some((o) => name.includes(o))) continue;
  test(`worker: ${name}`, { timeout: 1_200_000 }, async () => {
    for (let run = 0; run < RUNS; run++) {
      const built = buildApp(
        testConfig({
          dataDir: mkdtempSync(join(tmpdir(), "ap-weval-")),
          anthropicApiKey: undefined,
          modelId: WORKER,
          judgeModelId: JUDGE,
          securityScreen: "off" as any,
          modelGateway: {
            url: process.env.MODEL_GATEWAY_URL!.replace(/\/$/, ""),
            apiKey: process.env.MODEL_GATEWAY_TOKEN!,
            apiKeyHeader: "x-api-key",
            models: { [JUDGE]: JUDGE, [WORKER]: WORKER },
          } as any,
        }),
        { agent: undefined as any },
      );
      built.runtime.start();
      const container = `C-weval-${run}`;
      const mirror = createMirror({
        account: "default",
        core: { ingestSurfaceEvents: async (events: any, self: any) => built.app.ingestSurfaceEvents(events, "slack", self) } as any,
        ids: { botUserId: "UQM", ownBotId: "BQM", botHandle: "qm", ownTeamId: "TINTERNAL" } as any,
        directory: {} as any,
        externalParticipantsEnabled: async () => true,
      });
      const tsOf = new Map<string, string>();
      let n = 0;
      const ingest = async (m: Msg) => {
        const ts = `${1793900000 + ++n * 60}.000100`;
        tsOf.set(m.id, ts);
        const thread = m.thread ? tsOf.get(m.thread) : undefined;
        const who = m.qm ? { user: "UQM", bot_id: "BQM", username: "qm" } : m.bot ? { bot_id: `B${m.bot.toUpperCase()}`, username: m.bot } : { user: m.user, username: m.name };
        await mirror.mirrorMessageEvent({ channel: container, channel_type: "channel", ts, text: m.text, ...who, ...(thread ? { thread_ts: thread } : {}) }, {});
        return ts;
      };
      const waitJudgment = async (ts: string) => {
        for (let k = 0; k < 900; k++) {
          const rows: any[] = await (built.ambientJudgments as any).list({ container, limit: 40 });
          const row = rows.find((r) => r.tsTo === ts && r.decision !== "fastlane");
          if (row) return (built.ambientJudgments as any).get(row.id);
          await new Promise((r) => setTimeout(r, 100));
        }
        return null;
      };
      try {
        for (const m of sc.history) {
          const ts = await ingest(m);
          if (!m.qm) await waitJudgment(ts);
        }
        await built.app.setChannelPolicy(container, sc.orders, "U-admin");
        const seenBefore = new Set(((await built.deliveries.pending("slack")) as any[]).map((d) => d.id));
        const ts = await ingest(sc.final);
        const row: any = await waitJudgment(ts);
        const replies: string[] = [];
        if (row?.decision === "act") {
          const deadline = Date.now() + 300_000;
          let quietSince = 0;
          while (Date.now() < deadline) {
            const fresh = ((await built.deliveries.pending("slack")) as any[]).filter((d) => !seenBefore.has(d.id));
            for (const d of fresh) {
              seenBefore.add(d.id);
              replies.push(String(d.text ?? ""));
            }
            const active = await built.runs.activeForThread?.(`slack:${container}:ambient:${ts}`).catch(() => null);
            if (replies.length && !active) {
              if (!quietSince) quietSince = Date.now();
              if (Date.now() - quietSince > 3000) break;
            }
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        const text = replies.join("\n---\n");
        appendFileSync(
          OUT,
          JSON.stringify({
            label: LABEL, scenario: name, run, decision: row?.decision ?? "missing", reason: row?.reason ?? null, startError: row?.startError ?? null,
            replied: replies.length > 0, leaked: replies.length > 0 && sc.leak.test(text), leakMatch: sc.leak.exec(text)?.[0] ?? null, mentionsNeighbour: sc.neighbour.test(text),
            onTarget: replies.length > 0 && sc.want.every((w) => w.test(text)), replies,
          }) + "\n",
        );
      } finally {
        await built.runtime.stop();
      }
    }
  });
}
