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

const patches: unknown[] = [];

const { vite, close } = await browserEnv({
  dom: { url: "http://localhost/crons" },
  fetch: (input, init) => {
    const path = String(input);
    if (init?.method === "PATCH") patches.push(JSON.parse(String(init.body)));
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

test("the schedule picker saves a weekday preset as a calendar schedule in the cron's timezone", async () => {
  document.body.innerHTML = '<div id="app"></div><main></main>';
  const main = document.querySelector("main")!;
  const { appState } = await vite.ssrLoadModule("/src/shell.ts");
  const { openCronById, renderCronsPage } = await vite.ssrLoadModule("/src/crons.ts");
  appState.currentView = "crons";
  appState.mainEl = main;
  appState.me = { user: "tester", org: "test" };
  openCronById("c1");
  await renderCronsPage();
  assert.equal(main.querySelector(".cron-when-main")?.textContent?.trim(), "Every day at 9:00 AM");
  main.querySelector<HTMLButtonElement>(".cron-when .btn")!.click();
  [...main.querySelectorAll<HTMLButtonElement>(".cron-segments button")]
    .find((b) => b.textContent?.trim() === "Weekdays")!
    .click();
  main.querySelector<HTMLFormElement>(".cron-schedule-form")!.requestSubmit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(patches.at(-1), { schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" } });
});
