import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import { mkdtempSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createMirror } from "../src/slack/mirror.ts";
import { countTokens } from "../src/util/tokens.ts";

const OUT = process.env.EVAL_OUT ?? "/tmp/eval/judge.jsonl";
const RUNS = Number(process.env.EVAL_RUNS ?? 1);
const ONLY = process.env.EVAL_ONLY?.split(",");
const JUDGE = process.env.EVAL_JUDGE ?? "claude-haiku-5-5";
const LABEL = process.env.EVAL_LABEL ?? "?";
const SYSTEM = /AMBIENT_JUDGE_SYSTEM = `([\s\S]*?)`;/.exec(readFileSync(new URL("../src/surface-cache/ambient-judge.ts", import.meta.url), "utf8"))?.[1] ?? "";

export const DEAL_ORDERS = [
  "Watch the whole channel — top-level messages and all threads — for investment deal discussions, even when nobody mentions QM. Keep different companies strictly separate.",
  "When the conversation clearly supports participating in a deal, proactively post a concise summary (company, round, check size, cap or post-money, sponsor) and ask whether to create a new memo or update an existing memo and move it to Participating.",
  "Never suggest creating a memo for a pass. If a deal or decision is ambiguous, ask only the clarification strictly needed.",
  "Do not repeat an offer that is already pending for the same company; only re-offer if material terms change, and say what changed.",
  "If someone says to hold off after an offer, acknowledge that it is on hold. Otherwise stay silent.",
  "Suggestions only: never create or update memos.",
].join("\n");

type Msg = { id: string; user?: string; name?: string; qm?: boolean; text: string; thread?: string };
const A = { user: "UALICE", name: "Alice" }, B = { user: "UBOB", name: "Bob" }, C = { user: "UCAROL", name: "Carol" };
const offerHistory: Msg[] = [
  { id: "deal", ...A, text: "Example Co is raising a seed on a $10m post-money SAFE. References were strong — I think we should participate for $100k, Dana would sponsor." },
  { id: "offer", qm: true, thread: "deal", text: "Example Co — seed, $100k on a $10m post-money SAFE, sponsor Dana. Want me to create a new memo or update an existing one and move it to Participating?" },
  { id: "gamma", ...C, text: "Met the Gamma Robotics founders today, they're early but sharp." },
];
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
type Scenario = { history: Msg[]; final: Msg; expect: "act" | "ignore"; asked?: boolean; kind: string };
export const SCENARIOS: Record<string, Scenario> = {
  "h2h: deck request between people": { kind: "h2h", history: offerHistory, final: { id: "f", ...B, text: "Carol, can you send me the Beta Labs deck before Friday?" }, expect: "ignore" },
  "h2h: question in a person's thread": { kind: "h2h", history: offerHistory, final: { id: "f", ...B, thread: "gamma", text: "Did they say when the round closes?" }, expect: "ignore" },
  "h2h: who takes the reference calls": { kind: "h2h", history: offerHistory, final: { id: "f", ...A, text: "Bob, are you taking the Example Co reference calls or should I?" }, expect: "ignore" },
  "h2h: check size between partners": { kind: "h2h", history: offerHistory, final: { id: "f", ...A, thread: "gamma", text: "Carol what check size would you want if Gamma raises?" }, expect: "ignore" },
  "h2h: can you take a look": { kind: "h2h", history: offerHistory, final: { id: "f", ...C, text: "@Bob can you take a look at the Example Co data room tonight?" }, expect: "ignore" },
  "h2h: add notes to a colleague's memo": { kind: "h2h", history: [...offerHistory, { id: "carol-memo", ...C, text: "I'll draft the Example Co memo tonight." }], final: { id: "f", ...B, thread: "carol-memo", text: "Great — can you add the reference call notes too?" }, expect: "ignore" },
  "h2h: share link in a thread": { kind: "h2h", history: [...offerHistory, { id: "q", ...B, text: "Who has the Gamma Robotics data room link?" }, { id: "r", ...C, thread: "q", text: "I do." }], final: { id: "f", ...B, thread: "q", text: "Can you share it with me and Alice?" }, expect: "ignore" },
  "h2h: summary request in a person's thread": { kind: "h2h", history: [...offerHistory, { id: "sync", ...A, text: "Notes from today's Example Co sync are in the doc." }, { id: "sr", ...B, thread: "sync", text: "Thanks, reading now." }], final: { id: "f", ...A, thread: "sync", text: "Can you summarize where we landed on terms so I can send it to Dana?" }, expect: "ignore" },
  "h2h: move it after a person's update": { kind: "h2h", history: [...offerHistory, { id: "up", ...C, text: "Updated the Example Co memo with the final terms." }], final: { id: "f", ...A, thread: "up", text: "Thanks! Can you move it to Participating too?" }, expect: "ignore" },
  "h2h: check numbers with a colleague": { kind: "h2h", history: [...offerHistory, { id: "num", ...B, text: "I'm putting together the Q4 pipeline numbers." }], final: { id: "f", ...C, thread: "num", text: "Can you double-check the Example Co check size there before you send it?" }, expect: "ignore" },
  "keep: participation decided in a person's thread": { kind: "keep", history: [...offerHistory, { id: "beta", ...B, text: "Beta Labs is raising a seed round. Intro call went well." }], final: { id: "f", ...C, thread: "beta", text: "References checked out — let's participate in Beta Labs for $150k on a $20m post-money SAFE, Eli sponsors." }, expect: "act" },
  "keep: named request in a person's thread": { kind: "keep", history: [...offerHistory, { id: "sync", ...A, text: "Notes from today's Example Co sync are in the doc." }], final: { id: "f", ...B, thread: "sync", text: "qm, can you pull the Example Co terms we agreed on?" }, expect: "act", asked: true },
  "keep: thread follow-up after QM's offer scrolled out": { kind: "keep", history: [offerHistory[0]!, offerHistory[1]!, ...filler], final: { id: "f", ...A, thread: "deal", text: "Update the existing one please." }, expect: "act" },
  "keep: thread question after QM's offer scrolled out": { kind: "keep", history: [offerHistory[0]!, offerHistory[1]!, ...filler], final: { id: "f", ...A, thread: "deal", text: "Which memo would that update?" }, expect: "act", asked: true },
  "h2h: person's thread after QM's offer scrolled out": { kind: "h2h", history: [offerHistory[0]!, offerHistory[1]!, ...filler], final: { id: "f", ...C, thread: "f7", text: "Can you send me the Delta Health numbers too?" }, expect: "ignore" },
  "keep: first participation": { kind: "keep", history: [offerHistory[2]!], final: { id: "f", ...A, text: "Beta Labs is raising a $3m seed on a $20m post-money SAFE. I think we should participate for $150k; Eli would sponsor." }, expect: "act" },
  "keep: first hold": { kind: "keep", history: offerHistory, final: { id: "f", ...A, text: "Hold off on Example Co. We found an issue. Do not proceed." }, expect: "act" },
  "keep: correction": { kind: "keep", history: offerHistory, final: { id: "f", ...A, text: "Correction on Example Co: it's $150k on a $12m post-money SAFE." }, expect: "act" },
  "keep: cross-thread hold": { kind: "keep", history: offerHistory, final: { id: "f", ...B, thread: "gamma", text: "Unrelated to Gamma, but hold off on Example Co for now — legal flagged something." }, expect: "act" },
  "keep: duplicate restatement": { kind: "keep", history: offerHistory, final: { id: "f", ...B, text: "FYI team: we're participating in Example Co, $100k on a $10m post-money SAFE, Dana sponsoring." }, expect: "ignore" },
  "keep: unmentioned question to QM": { kind: "keep", history: offerHistory, final: { id: "f", ...A, text: "Which memo would that update — is there already one for Example Co?" }, expect: "act", asked: true },
};

for (const [name, sc] of Object.entries(SCENARIOS)) {
  if (ONLY && !ONLY.some((o) => name.includes(o))) continue;
  test(`judge: ${name}`, { timeout: 600_000 }, async () => {
    for (let run = 0; run < RUNS; run++) {
      const built = buildApp(
        testConfig({
          dataDir: mkdtempSync(join(tmpdir(), "ap-eval-")),
          anthropicApiKey: undefined,
          judgeModelId: JUDGE,
          securityScreen: "off" as any,
          modelGateway: {
            url: process.env.MODEL_GATEWAY_URL!.replace(/\/$/, ""),
            apiKey: process.env.MODEL_GATEWAY_TOKEN!,
            apiKeyHeader: "x-api-key",
            models: { [JUDGE]: JUDGE },
          } as any,
        }),
        { agent: undefined as any, canClaimRuns: () => false },
      );
      built.runtime.start();
      const container = `C-eval-${run}`;
      const mirror = createMirror({
        account: "default",
        core: { ingestSurfaceEvents: async (events: any, self: any) => built.app.ingestSurfaceEvents(events, "slack", self) } as any,
        ids: { botUserId: "UQM", ownBotId: "BQM", botHandle: "qm", ownTeamId: "TINTERNAL" } as any,
        directory: {} as any,
        externalParticipantsEnabled: async () => true,
      });
      const tsOf = new Map<string, string>();
      let n = 0;
      const post = async (m: Msg) => {
        const ts = `${1793900000 + ++n * 60}.000100`;
        tsOf.set(m.id, ts);
        const thread = m.thread ? tsOf.get(m.thread) : undefined;
        await mirror.mirrorMessageEvent(
          { channel: container, channel_type: "channel", ts, text: m.text, ...(m.qm ? { user: "UQM", bot_id: "BQM", username: "qm" } : { user: m.user, username: m.name }), ...(thread ? { thread_ts: thread } : {}) },
          {},
        );
        if (m.qm) return { ts, row: null };
        let row: any;
        for (let k = 0; k < 900 && !row; k++) {
          const rows: any[] = await (built.ambientJudgments as any).list({ container, limit: 40 });
          row = rows.find((r) => r.tsTo === ts && r.decision !== "fastlane");
          if (!row) await new Promise((r) => setTimeout(r, 100));
        }
        return { ts, row: row ? await (built.ambientJudgments as any).get(row.id) : null };
      };
      try {
        await built.app.setChannelPolicy(container, DEAL_ORDERS, "U-admin");
        for (const m of sc.history) await post(m);
        const { ts, row } = await post(sc.final);
        const prompt: string = row?.prompt ?? "";
        appendFileSync(
          OUT,
          JSON.stringify({
            label: LABEL, scenario: name, kind: sc.kind, run, expect: sc.expect,
            decision: row?.decision ?? "missing", correct: (row?.decision === "act") === (sc.expect === "act"),
            askedBy: row?.askedBy ?? null, askedOk: sc.asked ? row?.askedBy === ts : undefined,
            reason: row?.reason ?? null, latencyMs: row?.latencyMs ?? null,
            promptTokens: countTokens(SYSTEM) + countTokens(prompt), promptChars: prompt.length,
            prompt,
          }) + "\n",
        );
      } finally {
        await built.runtime.stop();
      }
    }
  });
}
