import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";
import { metadata } from "./model-metadata.ts";

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "timed out waiting for the UI to settle");
}

const goal = (status: "active" | "paused") => ({
  objective: "ship the fix",
  status,
  createdAt: 1000,
  updatedAt: 1000,
});

test("the play button on a paused goal bar resumes the goal and sends the turn that continues it", async () => {
  const posts: string[] = [];
  const h = await harness({
    path: `/s/${SESSION.id}`,
    api: (path, init) => {
      if (path === `/api/sessions/${SESSION.id}/goal/resume`) {
        posts.push(`${init?.method} ${path}`);
        return Response.json({ resumed: true, goal: goal("active") });
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
            item("AgentMessage", { seq: 2, createdAt: 1100, text: "Stopped." }),
          ],
          goal: goal("paused"),
        });
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    const chat = h.visibleConversation();
    await settle(() => Boolean(chat.state.host?.querySelector(".goal-strip")));
    const host = chat.state.host!;
    assert.match(host.querySelector(".goal-strip")!.textContent ?? "", /Goal paused/);
    const sent: unknown[] = [];
    const agent = chat.state.agent!;
    agent.prompt = (async (message: unknown) => void sent.push(message)) as typeof agent.prompt;

    const draft = "half-typed thought";
    chat.state.host!.querySelector("textarea")!.value = draft;
    chat.state.host!.querySelector("textarea")!.dispatchEvent(new window.Event("input", { bubbles: true }));

    const play = host.querySelector<HTMLButtonElement>(".goal-strip-resume")!;
    assert.equal(play.getAttribute("aria-label"), "Resume goal");
    play.click();
    await settle(() => sent.length > 0);

    assert.deepEqual(posts, [`POST /api/sessions/${SESSION.id}/goal/resume`]);
    assert.match(JSON.stringify(sent[0]), /Continue the goal\./);
    assert.equal(chat.state.host!.querySelector("textarea")!.value, draft, "the person's own draft stays put");
    assert.doesNotMatch(chat.state.host!.querySelector(".goal-strip")!.textContent ?? "", /Goal paused/);

    Object.assign(agent.state, { isStreaming: true });
    chat.drawActiveChat();
    assert.equal(chat.state.host!.querySelector(".goal-strip-resume"), null, "no play button while a reply runs");
  } finally {
    await h.close();
  }
});
