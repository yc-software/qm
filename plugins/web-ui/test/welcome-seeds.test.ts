import assert from "node:assert/strict";
import test from "node:test";
import { harness, runtimeConfig, SESSION, stubMotion } from "./deep-link-boot-fixture.ts";
import { welcomeActivities } from "../src/welcome-ideas.ts";

const idea = (id: string, icon: string, title: string) => ({ id, icon, title, prompt: title });

test("a new person sees their company's seeded activities, only apps they connected themselves add theirs, and a click fills the composer unsent", async () => {
  const welcome = {
    activities: [
      { ...idea("crm", "📇", "Build a tracker for the harbor pilots we are courting"), source: "from your goals" },
      idea("outreach", "✉️", "Draft notes to last week's demo attendees"),
    ],
    apps: {
      gmail: [{ ...idea("g1", "📥", "Find the pilot replies I still owe"), replaces: "outreach" }],
      slack: [idea("s1", "💬", "Summarize the channels I missed")],
    },
  };
  const me = { displayName: "Maya Lin", welcome, suggestedActivitiesGeneration: true };
  const h = await harness({
    path: "/",
    listSessions: [],
    connectionReturn: true,
    api: (path) => {
      if (path === "/me") return Response.json({ user: "tester", org: "test", permissions: [], ...me });
      return path.startsWith("/api/runtime-config") ? Response.json(runtimeConfig) : undefined;
    },
  });
  const restoreMotion = stubMotion();
  try {
    h.releaseSessions();
    await h.boot();
    const rows = () =>
      [
        ...document.querySelectorAll(
          "qm-onboarding-welcome .suggested-activity-row:not(.is-leaving) .suggested-activity",
        ),
      ].map((row) => row.textContent!.replace(/\s+/g, " ").trim());
    for (let i = 0; i < 100 && !rows()[0]?.includes("Gmail"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(h.mainText(), /Hi Maya!\s*Welcome to QM/);
    assert.deepEqual(
      rows().map((row) => row.replace(/^\S+ /, "")),
      [
        "Find the pilot replies I still owe from Gmail",
        "Build a tracker for the harbor pilots we are courting from your goals",
      ],
    );
    document.querySelector<HTMLButtonElement>("qm-onboarding-welcome .suggested-activity")!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      document.querySelector<HTMLTextAreaElement>(".composer-input")!.value,
      "Find the pilot replies I still owe",
    );
    assert.ok(!h.requests.includes("/api/turn"));
    assert.match(h.mainText(), /Connect your accounts/);
    assert.doesNotMatch(h.mainText(), /Connect your apps/);
  } finally {
    await h.close();
    restoreMotion();
  }
});

test("activities from the app a person just connected are marked new and none of the company's are dropped", () => {
  const activities = ["a", "b", "c", "d", "e"].map((id) => idea(id, "📌", `Idea ${id}`));
  const apps = { gmail: [idea("g1", "📥", "From mail")] };
  const shown = welcomeActivities({ activities, apps }, [{ id: "gmail", name: "Gmail" }], "gmail");
  assert.deepEqual(
    shown.activities.map((activity) => [activity.id, activity.source]),
    [
      ["g1", "from Gmail"],
      ["a", undefined],
      ["b", undefined],
      ["c", undefined],
      ["d", undefined],
      ["e", undefined],
    ],
  );
  assert.deepEqual([...shown.fresh], ["g1"]);
});

test("/onboard shows the welcome to a person who already has conversations", async () => {
  const welcome = { activities: [idea("crm", "📇", "Build a tracker for the harbor pilots")], apps: {} };
  const h = await harness({
    path: "/onboard",
    listSessions: [{ ...SESSION, createdAt: 1 }],
    api: (path) => {
      if (path === "/me") return Response.json({ user: "tester", org: "test", permissions: [], welcome });
      return path.startsWith("/api/runtime-config") ? Response.json(runtimeConfig) : undefined;
    },
  });
  const restoreMotion = stubMotion();
  try {
    h.releaseSessions();
    await h.boot();
    assert.ok(h.sessionsState.list.length > 0);
    assert.match(h.mainText(), /Welcome to QM!\s*Where to start/);
    assert.equal(location.pathname, "/");
  } finally {
    await h.close();
    restoreMotion();
  }
});
