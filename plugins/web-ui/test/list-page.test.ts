import assert from "node:assert/strict";
import test from "node:test";
import { browserEnv } from "./browser-env.ts";

test("listPageTpl renders the rich empty state with its action", async () => {
  const env = await browserEnv();
  try {
    const { listPageTpl } = await env.vite.ssrLoadModule("/src/list-page.ts");
    const { render } = await env.vite.ssrLoadModule("lit");
    const { Bell } = await env.vite.ssrLoadModule("lucide");
    let clicked = 0;
    const host = document.createElement("div");
    document.body.append(host);
    render(
      listPageTpl({
        title: "Webhooks",
        rows: [],
        empty: "No webhooks yet.",
        emptyState: {
          icon: Bell,
          title: "No webhooks yet",
          body: "Endpoints that wake the agent will show up here.",
          action: {
            label: "New webhook",
            onClick: () => {
              clicked += 1;
            },
          },
        },
      }),
      host,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = host.querySelector(".list-empty-state");
    assert.ok(state, "the rich empty state replaces the plain message");
    assert.equal(state.querySelector(".list-empty-state-title")?.textContent, "No webhooks yet");
    assert.equal(
      state.querySelector(".list-empty-state-body")?.textContent,
      "Endpoints that wake the agent will show up here.",
    );
    assert.equal(host.querySelector(".empty.compact"), null, "the plain empty row is not rendered");
    const button = state.querySelector<HTMLButtonElement>(".list-empty-state-action");
    assert.ok(button);
    assert.equal(button.textContent?.trim(), "New webhook");
    button.click();
    assert.equal(clicked, 1);
  } finally {
    await env.close();
  }
});

test("listPageTpl falls back to the plain empty message without emptyState", async () => {
  const env = await browserEnv();
  try {
    const { listPageTpl } = await env.vite.ssrLoadModule("/src/list-page.ts");
    const { render } = await env.vite.ssrLoadModule("lit");
    const host = document.createElement("div");
    document.body.append(host);
    render(listPageTpl({ title: "Crons", rows: [], empty: "Loading crons…" }), host);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(host.querySelector(".list-empty-state"), null);
    assert.equal(host.querySelector(".empty.compact")?.textContent?.trim(), "Loading crons…");
  } finally {
    await env.close();
  }
});
