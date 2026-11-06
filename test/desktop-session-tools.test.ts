import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopComputerTool } from "../plugins/chassis/src/desktop-computer.ts";
import { scopeId } from "../src/types.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("desktop-created sessions retain the original tool schema when resumed elsewhere", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const first = await store.getOrCreateByThread(
    "web:alice:desktop",
    "dm",
    scopeId("personal", "alice"),
    undefined,
    "web",
    [desktopComputerTool],
  );
  const browser = await store.getOrCreateByThread(first.threadRef, "dm", first.scopeId, undefined, "web");
  assert.deepEqual(browser.clientTools, [desktopComputerTool]);
  const changed = await store.getOrCreateByThread(first.threadRef, "dm", first.scopeId, undefined, "web", [
    { ...desktopComputerTool, description: "changed" },
  ]);
  assert.deepEqual(changed.clientTools, [desktopComputerTool]);
});

test("opening an existing browser session in desktop does not change its tools", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const first = await store.getOrCreateByThread(
    "web:alice:browser",
    "dm",
    scopeId("personal", "alice"),
    undefined,
    "web",
  );
  const desktop = await store.getOrCreateByThread(first.threadRef, "dm", first.scopeId, undefined, "web", [
    desktopComputerTool,
  ]);
  assert.equal(desktop.clientTools, undefined);
});
