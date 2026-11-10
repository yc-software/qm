import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";
import { item } from "./item-fixture.ts";

async function settle(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "timed out waiting for the UI to settle");
}

const goal = (status: "active" | "paused" | "cancelled") => ({
  objective: "ship the fix",
  status,
  createdAt: 1000,
  updatedAt: 1000,
});

async function cancelFromBar(before: "active" | "paused", afterCancel: "active" | "cancelled") {
  let cancelled = false;
  let readsAfterCancel = 0;
  const h = await harness({
    path: `/s/${SESSION.id}`,
    api: (path) => {
      if (path === `/api/sessions/${SESSION.id}/goal/cancel`) {
        cancelled = true;
        return Response.json({ cancelled: true });
      }
      if (path === `/api/sessions/${SESSION.id}` || path.startsWith(`/api/sessions/${SESSION.id}?`)) {
        if (cancelled) readsAfterCancel++;
        return Response.json({
          session: SESSION,
          items: [
            item("UserMessage", { seq: 1, createdAt: 900, text: "ship the fix" }),
            ...(before === "paused" ? [item("Stop", { seq: 3, createdAt: 5000, body: { reason: "by user" } })] : []),
          ],
          goal: goal(cancelled ? afterCancel : before),
        });
      }
      return undefined;
    },
  });
  h.releaseSessions();
  await h.boot();
  const chat = h.visibleConversation();
  await settle(() => Boolean(chat.state.host?.querySelector(".goal-strip")));
  chat.state.host!.querySelector<HTMLButtonElement>('.goal-strip [aria-label="Cancel goal"]')!.click();
  await settle(() => cancelled && (before === "paused" || readsAfterCancel > 0));
  return { h, chat };
}

for (const before of ["active", "paused"] as const)
  test(`cancelling a goal that is ${before} removes its bar`, async () => {
    const { h, chat } = await cancelFromBar(before, "cancelled");
    try {
      await settle(() => !chat.state.host!.querySelector(".goal-strip"));
    } finally {
      await h.close();
    }
  });

test("a goal core still reports active after a cancel keeps its bar and a working cancel button", async () => {
  const { h, chat } = await cancelFromBar("active", "active");
  try {
    await settle(() => {
      const button = chat.state.host!.querySelector<HTMLButtonElement>('.goal-strip [aria-label="Cancel goal"]');
      return Boolean(button && !button.disabled);
    });
  } finally {
    await h.close();
  }
});
