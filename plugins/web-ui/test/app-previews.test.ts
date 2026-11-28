import assert from "node:assert/strict";
import test, { after } from "node:test";
import { browserEnv } from "./browser-env.ts";

const listed: string[] = [];
const { vite, close } = await browserEnv({
  dom: { url: "https://qm.example.com/chat" },
  fetch: (input) => {
    listed.push(String(input));
    return Promise.resolve(
      Response.json({
        apps: [
          {
            id: "a1",
            name: "demo",
            displayName: "Demo board",
            status: "running",
            webUrl: "https://demo.apps.example.com/",
          },
          { id: "a2", name: "old", status: "stopped", webUrl: "https://old.apps.example.com/" },
        ],
      }),
    );
  },
});
after(close);

test("a reply linking a published app shows a live preview card for it and nothing for other links", async () => {
  const { appState } = await vite.ssrLoadModule("/src/shell.ts");
  appState.me = {
    user: "demo@example.com",
    personalScope: "personal:demo@example.com",
    org: "acme",
    appsDomain: "apps.example.com",
  };
  await vite.ssrLoadModule("/src/app-previews.ts");
  const previews = document.createElement("qm-app-previews") as HTMLElement & { text: string };
  document.body.append(previews);
  previews.text =
    "Built it: [Demo board](https://demo.apps.example.com/board?x=1), also https://demo.apps.example.com/ " +
    "and [stopped](https://old.apps.example.com/), [repo](https://github.com/acme/demo).";
  for (let i = 0; i < 100 && !previews.querySelector("iframe"); i++) await new Promise((r) => setTimeout(r, 5));
  const frames = [...previews.querySelectorAll("iframe")];
  assert.deepEqual(
    frames.map((frame) => frame.getAttribute("src")),
    ["https://demo.apps.example.com/board?x=1"],
  );
  assert.match(frames[0]!.getAttribute("sandbox")!, /allow-same-origin/);
  assert.equal(previews.querySelector(".file-html-title")!.textContent, "Demo board");
  assert.equal(
    previews.querySelector<HTMLAnchorElement>('a[target="_blank"]')!.href,
    "https://demo.apps.example.com/board?x=1",
  );
  previews.text = "Again: https://demo.apps.example.com/, https://docs.example.org/ and https://gone.apps.example.com/";
  for (
    let i = 0;
    i < 100 && previews.querySelector("iframe")?.getAttribute("src") !== "https://demo.apps.example.com/";
    i++
  )
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(previews.querySelector("iframe")!.getAttribute("src"), "https://demo.apps.example.com/");
  assert.deepEqual(listed, ["/api/apps", "/api/apps"]);
});
