import assert from "node:assert/strict";
import test, { after } from "node:test";
import { browserEnv } from "./browser-env.ts";

const activity = (id: string) => ({ id, title: `Do ${id}`, prompt: `Let's do ${id}.`, icon: "📊" });
const requests: { path: string; body: Record<string, unknown> }[] = [];
const served = ["a", "d", "e", "f"].map(activity);

const { vite, close } = await browserEnv({
  fetch: (input, init) => {
    const path = String(input);
    requests.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    if (path === "/api/suggested-activities")
      return Promise.resolve(Response.json({ activities: served, pending: false }));
    return Promise.resolve(Response.json({ dismissed: true }));
  },
});
after(close);

const { render } = await import("lit");
const { suggestedActivities } = await vite.ssrLoadModule("/src/suggested-activities.ts");
const { dismissGeneratedActivity } = await vite.ssrLoadModule("/src/generated-activities.ts");
const flush = () => new Promise((resolve) => setImmediate(resolve));

function mount(initial: ReturnType<typeof activity>[], dismissible = true) {
  const host = document.createElement("div");
  let list = initial;
  const draw = () =>
    render(
      suggestedActivities(list, {
        onSelect: () => {},
        ...(dismissible
          ? {
              onDismiss: (dismissed: { id: string }) => {
                list = list.filter((candidate) => candidate.id !== dismissed.id);
                draw();
              },
            }
          : {}),
        redraw: draw,
      }),
      host,
    );
  draw();
  const rows = () =>
    [...host.querySelectorAll(".suggested-activity-row")].map((row) =>
      [
        row.querySelector(".suggested-activity-title")!.textContent,
        ...["entering", "leaving"].filter((motion) => row.classList.contains(`is-${motion}`)),
      ]
        .join(" ")
        .trim(),
    );
  const dismiss = (title: string) =>
    host
      .querySelector<HTMLButtonElement>(`.suggested-activity-dismiss[aria-label="Dismiss suggestion: ${title}"]`)!
      .click();
  return {
    host,
    rows,
    dismiss,
    replace: (next: ReturnType<typeof activity>[]) => {
      list = next;
      draw();
    },
  };
}

test("three suggestions show at first without motion; dismissing one collapses it while a reserve row slides in", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const view = mount(["a", "b", "c", "d", "e"].map(activity));
  assert.deepEqual(view.rows(), ["Do a", "Do b", "Do c"]);
  view.dismiss("Do b");
  assert.deepEqual(view.rows(), ["Do a", "Do b leaving", "Do c", "Do d entering"]);
  t.mock.timers.tick(220);
  assert.deepEqual(view.rows(), ["Do a", "Do c", "Do d entering"]);
});

test("when the reserve runs out fewer rows show, and the refreshed set animates in", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const view = mount(["a", "b", "c", "d"].map(activity));
  view.dismiss("Do a");
  view.dismiss("Do b");
  t.mock.timers.tick(220);
  assert.deepEqual(view.rows(), ["Do c", "Do d entering"]);
  view.dismiss("Do c");
  view.dismiss("Do d");
  t.mock.timers.tick(220);
  assert.deepEqual(view.rows(), []);
  assert.ok(view.host.querySelector(".suggested-activities.is-empty"));
  view.replace(["x", "y", "z", "w"].map(activity));
  assert.deepEqual(view.rows(), ["Do x entering", "Do y entering", "Do z entering"]);
});

test("suggestions without generation have no dismiss control and render nothing when empty", () => {
  const view = mount(["a", "b"].map(activity), false);
  assert.equal(view.host.querySelectorAll(".suggested-activity-dismiss").length, 0);
  assert.deepEqual(view.rows(), ["Do a", "Do b"]);
  view.replace([]);
  assert.equal(view.host.querySelector(".suggested-activities"), null);
});

test("each dismissal is saved at once, and a burst of dismissals asks for one refresh after a quiet moment", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const me = {
    user: "tester",
    org: "test",
    suggestedActivitiesGeneration: true,
    suggestedActivities: ["a", "b", "c", "d", "e"].map(activity),
  };
  let changes = 0;
  const onChange = () => changes++;
  dismissGeneratedActivity(me, activity("a"), onChange);
  t.mock.timers.tick(1_000);
  dismissGeneratedActivity(me, activity("b"), onChange);
  t.mock.timers.tick(1_000);
  dismissGeneratedActivity(me, activity("c"), onChange);
  await flush();
  assert.deepEqual(
    me.suggestedActivities.map((candidate: { id: string }) => candidate.id),
    ["d", "e"],
  );
  assert.deepEqual(
    requests.map((request) => [request.path, request.body.id]),
    [
      ["/api/suggested-activities/dismiss", "a"],
      ["/api/suggested-activities/dismiss", "b"],
      ["/api/suggested-activities/dismiss", "c"],
    ],
  );
  t.mock.timers.tick(2_999);
  await flush();
  assert.equal(requests.length, 3);
  t.mock.timers.tick(1);
  await flush();
  await flush();
  assert.equal(requests.length, 4);
  assert.equal(requests[3]!.path, "/api/suggested-activities");
  assert.equal(requests[3]!.body.refresh, true);
  assert.deepEqual(
    me.suggestedActivities.map((candidate: { id: string }) => candidate.id),
    ["d", "e", "f"],
  );
  assert.equal(changes, 4);
});
