import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "timed out waiting for the UI to settle");
}

const goal = (status: "paused" | "cancelled") => ({
  objective: "ship the fix",
  status,
  createdAt: 1000,
  updatedAt: 1000,
});

test("cancelling a goal after stopping its reply shows the cancellation in the transcript without a reload", async () => {
  let cancelled = false;
  const h = await harness({
    path: `/s/${SESSION.id}`,
    api: (path) => {
      if (path === `/api/sessions/${SESSION.id}/goal/cancel`) {
        cancelled = true;
        return Response.json({ cancelled: true });
      }
      if (path === `/api/sessions/${SESSION.id}` || path.startsWith(`/api/sessions/${SESSION.id}?`))
        return Response.json({
          session: SESSION,
          items: [
            item("UserMessage", { seq: 1, createdAt: 900, text: "ship the fix" }),
            item("Stop", { seq: 2, createdAt: 5000, body: { reason: "by user" } }),
            ...(cancelled
              ? [
                  item("Wake", {
                    seq: 3,
                    createdAt: 6000,
                    body: { kind: "goal_cancelled", objective: "ship the fix", cancelledBy: "u1" },
                  }),
                ]
              : []),
          ],
          goal: goal(cancelled ? "cancelled" : "paused"),
        });
      return undefined;
    },
  });
  try {
    h.releaseSessions();
    await h.boot();
    const chat = h.visibleConversation();
    await settle(() => Boolean(chat.state.host?.querySelector(".goal-strip")));
    assert.match(h.mainText(), /You stopped/);
    assert.doesNotMatch(h.mainText(), /Goal cancelled/);
    chat.state.host!.querySelector<HTMLButtonElement>('.goal-strip [aria-label="Cancel goal"]')!.click();
    await settle(() => /Goal cancelled/.test(h.mainText()));
    assert.match(h.mainText(), /You stopped/);
  } finally {
    await h.close();
  }
});
