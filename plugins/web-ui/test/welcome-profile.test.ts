import assert from "node:assert/strict";
import test from "node:test";
import { harness, runtimeConfig, stubMotion } from "./deep-link-boot-fixture.ts";
import { welcomeIdeaRows } from "../src/welcome-ideas.ts";

test("a company's welcome profile lists its ideas, adds a connected app's ideas, and a click fills the composer unsent", async () => {
  const profile = {
    ideas: [
      { id: "crm", icon: "📇", title: "Build a tracker for the harbor pilots we are courting", src: "from your goals" },
      { id: "outreach", icon: "✉️", title: "Draft notes to last week's demo attendees" },
    ],
    connectors: {
      gmail: [{ id: "g1", icon: "📥", title: "Find the pilot replies I still owe", replaces: "outreach" }],
    },
  };
  const me = { displayName: "Maya Lin", welcomeProfile: profile };
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
  } finally {
    await h.close();
    restoreMotion();
  }
});

test("ideas from the app a person just connected are marked new, and the list stays at five", () => {
  const ideas = ["a", "b", "c", "d", "e"].map((id) => ({ id, icon: "📌", title: `Idea ${id}` }));
  const connectors = { gmail: [{ id: "g1", icon: "📥", title: "From mail" }] };
  const rows = welcomeIdeaRows({ ideas, connectors }, [{ id: "gmail", name: "Gmail" }], "gmail");
  assert.deepEqual(
    rows.map((row) => [row.activity.id, row.note?.text]),
    [
      ["g1", "New · from Gmail"],
      ["a", undefined],
      ["b", undefined],
      ["c", undefined],
      ["d", undefined],
    ],
  );
});
