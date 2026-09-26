import assert from "node:assert/strict";
import test from "node:test";
import { harness, SESSION } from "./deep-link-boot-fixture.ts";

test("a restored tab finishes loading after becoming hidden while its transcript is pending", async () => {
  const sessions = [
    SESSION,
    ...["b", "c"].map((id) => ({
      id,
      threadRef: `web:tester:${id}`,
      scopeId: "personal:tester",
      title: id,
    })),
  ];
  const h = await harness({
    path: "/",
    welcome: true,
    holdTranscript: true,
    listSessions: sessions,
    entries: [{ seq: 1, type: "assistant", createdAt: 1, payload: { text: "Restored target transcript" } }],
    remoteCanvas: {
      v: 2,
      active: true,
      layout: {
        grid: {
          root: {
            type: "branch",
            data: [
              { type: "leaf", data: { views: [SESSION.id, "b"], activeView: "b", id: "stack" } },
              { type: "leaf", data: { views: ["c"], activeView: "c", id: "other" } },
            ],
          },
          width: 1000,
          height: 800,
          orientation: "HORIZONTAL",
        },
        panels: Object.fromEntries(
          sessions.map((session) => [
            session.id,
            {
              id: session.id,
              contentComponent: "pane",
              tabComponent: "pane",
              params: { sessionId: session.id, threadRef: session.threadRef },
              title: session.title,
            },
          ]),
        ),
        activeGroup: "stack",
      },
    },
  });
  const booted = h.boot();
  try {
    for (let i = 0; i < 100 && document.querySelectorAll(".dv-tab").length < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const tabs = Array.from(document.querySelectorAll(".dv-tab"));
    assert.equal(tabs.length, 3);
    assert.equal(h.sessionsState.loaded, false);
    const select = (tab: Element): void => {
      tab.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    };
    const pane = (): Element | null => document.querySelector(`[data-pane-id="${SESSION.id}"]`);
    select(tabs[0]!);
    assert.ok(pane()?.querySelector(".chat-loading"));
    select(tabs[1]!);
    h.releaseSessions();
    h.releaseTranscript();
    await booted;
    const otherTile = document.querySelector('[data-pane-id="c"]');
    assert.ok(otherTile);
    for (let i = 0; i < 100 && !otherTile.textContent?.includes("Restored target transcript"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(otherTile.querySelector(".chat-loading"), null, "the other tile has loaded");
    assert.match(otherTile.textContent ?? "", /Restored target transcript/);
    assert.doesNotMatch(otherTile.textContent ?? "", /Couldn't load this conversation/);
    select(tabs[0]!);
    for (let i = 0; i < 100 && !pane()?.textContent?.includes("Restored target transcript"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(h.requests.includes(`/api/sessions/${SESSION.id}?tailTurns=25`));
    assert.equal(pane()?.querySelector(".chat-loading"), null, "the returning tab must replace its loading spinner");
    assert.match(pane()?.textContent ?? "", /Restored target transcript/);
  } finally {
    h.releaseSessions();
    await booted;
    await h.close();
  }
});
