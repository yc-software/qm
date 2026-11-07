import assert from "node:assert/strict";
import test, { after } from "node:test";
import { browserEnv } from "./browser-env.ts";

const crons: Array<Record<string, unknown> & { id: string }> = [
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
    if (path === "/api/crons/c2/runs") return Promise.resolve(Response.json({ runs: [] }));
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

test("opening a cron rereads it, so Last fired is current rather than from when the page opened", async () => {
  document.body.innerHTML = '<div id="app"></div><main></main>';
  const main = document.querySelector("main")!;
  const { appState } = await vite.ssrLoadModule("/src/shell.ts");
  const { renderCronsPage } = await vite.ssrLoadModule("/src/crons.ts");
  appState.currentView = "crons";
  appState.mainEl = main;
  appState.me = { user: "tester", org: "test" };
  await renderCronsPage();
  const firedAt = Date.UTC(2026, 10, 4, 18, 0);
  crons[1] = { ...crons[1]!, lastFiredAt: firedAt };
  const row = [...main.querySelectorAll<HTMLElement>(".cron-row-main")].find((el) =>
    el.textContent?.includes("Gmail digest"),
  )!;
  row.click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const lastFired = [...main.querySelectorAll("label")].find((l) => l.textContent === "Last fired")!;
  assert.equal(lastFired.nextElementSibling?.textContent?.trim(), new Date(firedAt).toLocaleString());
});
