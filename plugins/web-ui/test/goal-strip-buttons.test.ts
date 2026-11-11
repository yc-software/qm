import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";
import { metadata } from "./model-metadata.ts";

type Status = "active" | "paused" | "cancelled";

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "timed out waiting for the UI to settle");
}

const goal = (status: Status) => ({ objective: "ship the fix", status, createdAt: 1000, updatedAt: 1000 });

async function openGoalBar(action: "resume" | "cancel", before: Status, after: Status) {
  const posts: string[] = [];
  const h = await harness({
    path: `/s/${SESSION.id}`,
    api: (path, init) => {
      if (path === `/api/sessions/${SESSION.id}/goal/${action}`) {
        posts.push(`${init?.method} ${path}`);
        return Response.json(action === "resume" ? { resumed: true, goal: goal("active") } : { cancelled: true });
      }
      if (path.startsWith("/api/runtime-config"))
        return Response.json({
          scopeId: SESSION.scopeId,
          models: ["m"],
          modelCatalog: { m: metadata("m", "Model") },
          orgDefault: { modelId: "m", revision: 0 },
          effective: { modelId: "m" },
          scopeOverride: null,
        });
      if (path === `/api/sessions/${SESSION.id}` || path.startsWith(`/api/sessions/${SESSION.id}?`))
        return Response.json({
          session: SESSION,
          items: [
            item("UserMessage", { seq: 1, createdAt: 900, text: "ship the fix" }),
            item("ToolCall", { seq: 2, createdAt: 1000, tool: "goal", callId: "c1", body: { action: "create" } }),
            item("ToolResult", {
              seq: 3,
              createdAt: 1001,
              tool: "goal",
              callId: "c1",
              body: { action: "create", goal: goal("active") },
            }),
            ...(before === "paused" ? [item("Stop", { seq: 4, createdAt: 5000, body: { reason: "by user" } })] : []),
          ],
          goal: goal(posts.length ? after : before),
        });
      return undefined;
    },
  });
  h.releaseSessions();
  await h.boot();
  const chat = h.visibleConversation();
  const bar = () => chat.state.host?.querySelector(".goal-strip") ?? null;
  await settle(() => Boolean(bar()));
  return { h, chat, posts, bar };
}

test("the play button on a paused goal bar resumes the goal and sends the turn that continues it", async () => {
  const { h, chat, posts, bar } = await openGoalBar("resume", "paused", "paused");
  try {
    assert.match(bar()!.textContent ?? "", /Goal paused/);
    const sent: unknown[] = [];
    const agent = chat.state.agent!;
    agent.prompt = (async (message: unknown) => {
      sent.push(message);
      Object.assign(agent.state, { isStreaming: true });
    }) as typeof agent.prompt;

    const draft = "half-typed thought";
    chat.state.host!.querySelector("textarea")!.value = draft;
    chat.state.host!.querySelector("textarea")!.dispatchEvent(new window.Event("input", { bubbles: true }));

    bar()!.querySelector<HTMLButtonElement>('[aria-label="Resume goal"]')!.click();
    await settle(() => sent.length > 0);

    assert.deepEqual(posts, [`POST /api/sessions/${SESSION.id}/goal/resume`]);
    assert.match(JSON.stringify(sent[0]), /Continue the goal\./);
    assert.equal(chat.state.host!.querySelector("textarea")!.value, draft, "the person's own draft stays put");
    chat.drawActiveChat();
    assert.match(bar()!.textContent ?? "", /Pursuing goal/, "the bar follows the goal core reports, not the stop");
    assert.equal(bar()!.querySelector('[aria-label="Resume goal"]'), null, "no play button while a reply runs");
  } finally {
    await h.close();
  }
});

for (const [name, before, after] of [
  ["cancelling an active goal removes its bar", "active", "cancelled"],
  ["cancelling a paused goal whose reply was stopped removes its bar", "paused", "cancelled"],
  ["a goal core still reports active after a cancel keeps its bar and a working cancel button", "active", "active"],
] as const)
  test(name, async () => {
    const { h, posts, bar } = await openGoalBar("cancel", before, after);
    try {
      const button = () => bar()?.querySelector<HTMLButtonElement>('[aria-label="Cancel goal"]');
      button()!.click();
      await settle(() => posts.length > 0 && (after === "cancelled" ? !bar() : button()?.disabled === false));
    } finally {
      await h.close();
    }
  });
