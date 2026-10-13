import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelReply, ModelRequest } from "./support/fake-gateway.ts";
import { journeyTestOptions, startJourneyApp, waitFor } from "./support/journey-app.ts";

type Failure = { status: number; body: unknown };
interface Case {
  topic: string;
  failure: Failure;
  failCalls: number;
  says?: RegExp;
}

const anthropicError = (status: number, type: string, message: string): Failure => ({
  status,
  body: { type: "error", error: { type, message } },
});

const CASES: Case[] = [
  {
    topic: "hiring",
    failure: {
      status: 400,
      body: {
        error: {
          message: "Budget has been exceeded! Current cost: 10.02, Max budget: 10.0",
          type: "budget_exceeded",
          param: null,
          code: "400",
        },
      },
    },
    failCalls: Infinity,
    says: /model budget/,
  },
  {
    topic: "fundraising",
    failure: { status: 402, body: { error: { message: "Insufficient credits. Add more credits to continue." } } },
    failCalls: Infinity,
    says: /model budget/,
  },
  {
    topic: "roadmap",
    failure: anthropicError(529, "overloaded_error", "Overloaded"),
    failCalls: Infinity,
    says: /overloaded/,
  },
  {
    topic: "pipeline",
    failure: anthropicError(
      429,
      "rate_limit_error",
      "Number of request tokens has exceeded your per-minute rate limit",
    ),
    failCalls: Infinity,
    says: /rate-limiting/,
  },
  {
    topic: "churn",
    failure: anthropicError(404, "not_found_error", "model: journey/claude"),
    failCalls: Infinity,
    says: /model .*isn't available/,
  },
  {
    topic: "inventory",
    failure: anthropicError(529, "overloaded_error", "Overloaded"),
    failCalls: 1,
  },
];

const ACTOR = "analyst@example.com";

function requestText(req: ModelRequest): string {
  return JSON.stringify(req.messages);
}

test("a model provider failure is explained and retry works", journeyTestOptions(240_000), async () => {
  const app = await startJourneyApp({
    maxRequestBytes: 10 * 1024 * 1024,
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_000,
  });
  const calls = new Map<string, number>();
  const healthy = new Set<string>();
  app.gateway.respond = (req): ModelReply => {
    if (JSON.stringify(req.system).includes("security boundary classifier")) return { text: '{"decision":"auto"}' };
    if (!req.tools?.length) return { text: "Weekly summary" };
    const hit = CASES.find((c) => requestText(req).includes(`my ${c.topic} week`));
    if (!hit) return { text: "unexpected request" };
    const n = (calls.get(hit.topic) ?? 0) + 1;
    calls.set(hit.topic, n);
    return healthy.has(hit.topic) || n > hit.failCalls
      ? { text: `Your ${hit.topic} week looked steady.` }
      : { failure: hit.failure };
  };
  const transcript = async (threadRef: string) => {
    const session = await app.built.sessions.getByThread(threadRef);
    return session ? app.built.sessions.getEntries(session.id, { limit: 100 }) : [];
  };
  const failureNotes = (entries: Awaited<ReturnType<typeof transcript>>) =>
    entries
      .map((e) => e.payload as { kind?: string; message?: string } | null)
      .filter((p) => p?.kind === "turn_failure")
      .map((p) => p!.message ?? "");
  try {
    const threads = new Map(CASES.map((c) => [c.topic, `web:${ACTOR}:${c.topic}-${Date.now()}`]));
    const outcomes = await Promise.all(
      CASES.map(async (c) => {
        const threadRef = threads.get(c.topic)!;
        const queued = await app.built.app.turn({
          surface: "web",
          actor: { externalId: ACTOR },
          conversation: { kind: "dm", threadRef },
          text: `Summarize my ${c.topic} week.`,
          async: true,
        });
        assert.equal(queued.status, "queued", `${c.topic}: ${queued.reason}`);
        const entries = await waitFor(
          async () => {
            const all = await transcript(threadRef);
            return all.some((e) => e.type === "assistant" || failureNotes([e]).length) && all;
          },
          `${c.topic} turn to end`,
          200_000,
        );
        return { c, threadRef, entries };
      }),
    );
    for (const { c, threadRef, entries } of outcomes) {
      const notes = failureNotes(entries);
      if (!c.says) {
        assert.deepEqual(notes, [], `${c.topic}: a one-off provider hiccup is retried without bothering the user`);
        assert.ok(
          entries.some((e) => e.type === "assistant"),
          `${c.topic}: the user still gets the answer`,
        );
        continue;
      }
      assert.equal(notes.length, 1, `${c.topic}: exactly one failure note, got ${JSON.stringify(notes)}`);
      const note = notes[0]!;
      assert.match(note, c.says, `${c.topic}: the note names the cause: ${note}`);
      assert.ok(note.length <= 160, `${c.topic}: the note is short: ${note}`);
      assert.doesNotMatch(note, /[{}]|_error|API error|\b\d{3}\b/, `${c.topic}: no raw provider payload: ${note}`);
      assert.equal(
        entries.filter((e) => e.type === "user" && (e.payload as { hidden?: boolean }).hidden !== true).length,
        1,
        `${c.topic}: the user's message appears once: ${JSON.stringify(entries.map((e) => e.type))}`,
      );
      healthy.add(c.topic);
      const again = await app.webTurn(ACTOR, threadRef, "Try that again please.");
      assert.equal(again.status, "ok", `${c.topic}: retry ${again.reason}`);
      assert.equal(again.reply, `Your ${c.topic} week looked steady.`);
    }
  } finally {
    await app.stop();
  }
});
