import assert from "node:assert/strict";
import test, { after } from "node:test";
import { browserEnv } from "./browser-env.ts";

const crons = [
  {
    id: "c1",
    ownerScopeId: "personal:tester",
    owner: "tester",
    message: "Please summarize the **open PRs** in qm: list each one with its author and age.",
    schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
    enabled: true,
    createdAt: 2,
  },
  {
    id: "c2",
    ownerScopeId: "personal:tester",
    owner: "tester",
    title: "Gmail digest",
    message: "check gmail",
    schedule: { cron: "0 8 * * *" },
    enabled: true,
    createdAt: 1,
  },
  {
    id: "c3",
    ownerScopeId: "personal:tester",
    owner: "tester",
    message: "",
    schedule: { cron: "0 7 * * *" },
    enabled: true,
    createdAt: 0,
  },
];

const { vite, close } = await browserEnv({
  dom: { url: "http://localhost/crons" },
  fetch: (input) => {
    const path = String(input);
    if (path === "/api/contexts") return Promise.resolve(Response.json({ contexts: [] }));
    if (path === "/api/crons") return Promise.resolve(Response.json({ crons }));
    return Promise.resolve(Response.json({}));
  },
});
after(close);

test("an untitled cron is listed by its clipped task text, a titled one by its title", async () => {
  document.body.innerHTML = '<div id="app"></div><main></main>';
  const main = document.querySelector("main")!;
  const { appState } = await vite.ssrLoadModule("/src/shell.ts");
  const { renderCronsPage } = await vite.ssrLoadModule("/src/crons.ts");
  appState.currentView = "crons";
  appState.mainEl = main;
  appState.me = { user: "tester", org: "test" };
  await renderCronsPage();
  assert.deepEqual(
    [...main.querySelectorAll(".cron-title-line")].map((row) => row.textContent?.trim()),
    ["Please summarize the open PRs in qm: list each one with…", "Gmail digest", "(untitled cron)"],
  );
});
