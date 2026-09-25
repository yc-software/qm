import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("generation coalesces requests, honors empty fallback, and stays disabled by default", async () => {
  const oldFetch = globalThis.fetch;
  const oldNow = Date.now;
  let calls = 0;
  let time = 1000;
  let activities: unknown[] = [
    { id: "app", title: "Build my project tracker", prompt: "Help build my tracker.", icon: "🛠️" },
  ];
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ activities });
  };
  Date.now = () => time;
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { loadGeneratedActivities } = await vite.ssrLoadModule("/src/generated-activities.ts");
    await loadGeneratedActivities({ user: "off", org: "test" });
    assert.equal(calls, 0);
    const me = { user: "alice", org: "test", suggestedActivitiesGeneration: true, suggestedActivities: [] };
    await Promise.all([loadGeneratedActivities(me), loadGeneratedActivities(me)]);
    assert.equal(calls, 1);
    assert.deepEqual(me.suggestedActivities, activities);
    activities = [];
    time += 5 * 60_000;
    await loadGeneratedActivities(me);
    assert.deepEqual(me.suggestedActivities, []);
    assert.equal(calls, 2);
    await loadGeneratedActivities({ user: "bob", org: "test", suggestedActivitiesGeneration: true });
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
    await vite.close();
  }
});

test("a pending refresh displays its cached result and then publishes the completed result", async (t) => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  const first = [{ id: "first", title: "Review my current work", prompt: "Review my work.", icon: "📚" }];
  const second = [{ id: "second", title: "Plan my next steps", prompt: "Plan my next steps.", icon: "🧭" }];
  globalThis.fetch = async () =>
    Response.json(++calls === 1 ? { activities: first, pending: true } : { activities: second, pending: false });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { loadGeneratedActivities } = await vite.ssrLoadModule("/src/generated-activities.ts");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const me = { user: "alice", org: "test", suggestedActivitiesGeneration: true, suggestedActivities: [] };
    const seen: unknown[] = [];
    const pending = loadGeneratedActivities(me, () => seen.push(structuredClone(me.suggestedActivities)));
    await new Promise(setImmediate);
    assert.deepEqual(seen, [first]);
    t.mock.timers.tick(10_000);
    await pending;
    assert.deepEqual(seen, [first, second]);
    assert.deepEqual(me.suggestedActivities, second);
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = oldFetch;
    await vite.close();
  }
});
