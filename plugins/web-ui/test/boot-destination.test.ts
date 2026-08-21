import assert from "node:assert/strict";
import test from "node:test";
import { resolveBootDestination } from "../src/boot-destination.ts";
import { appState, claimMainSurface, mainSurfaceIsCurrent } from "../src/shell-state.ts";

test("boot destination resolves each route once", () => {
  assert.deepEqual(
    resolveBootDestination({
      wanted: "app-edit",
      sessionId: "session-ignored",
      item: null,
      connectedProvider: null,
      appSlug: "Fixture-App",
    }),
    { kind: "app-edit", slug: "fixture-app" },
  );
  assert.deepEqual(
    resolveBootDestination({
      wanted: "contexts",
      sessionId: "session-ignored",
      item: "project:fixture",
      connectedProvider: null,
      appSlug: null,
    }),
    { kind: "view", view: "contexts", item: "project:fixture" },
  );
  assert.deepEqual(
    resolveBootDestination({
      wanted: "chats",
      sessionId: "session-1",
      item: null,
      connectedProvider: null,
      appSlug: null,
    }),
    { kind: "session", sessionId: "session-1" },
  );
  assert.deepEqual(
    resolveBootDestination({
      wanted: null,
      sessionId: null,
      item: null,
      connectedProvider: "fixture-provider",
      appSlug: null,
    }),
    { kind: "provider", provider: "fixture-provider" },
  );
  assert.deepEqual(
    resolveBootDestination({ wanted: null, sessionId: null, item: null, connectedProvider: null, appSlug: null }),
    { kind: "bare" },
  );
});

test("main surface claims invalidate work that started before user intent", () => {
  const before = appState.mainSurfaceRevision;
  assert.equal(mainSurfaceIsCurrent(before), true);
  const claimed = claimMainSurface();
  assert.equal(claimed, before + 1);
  assert.equal(mainSurfaceIsCurrent(before), false);
  assert.equal(mainSurfaceIsCurrent(claimed), true);
});
