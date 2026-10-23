import assert from "node:assert/strict";
import { test } from "node:test";
import { browserEnv } from "./browser-env.ts";
import { harness } from "./deep-link-boot-fixture.ts";

test("the keychain takes names and descriptions from the provider list", async () => {
  const env = await browserEnv({
    fetch: async (input) =>
      String(input).includes("/api/connectors")
        ? Response.json({
            providers: {
              google: { label: "Google Workspace", description: "Gmail, Calendar, Drive, Sheets", available: true },
              acme: { label: "Acme CRM", description: "Deals & contacts", available: true },
              bare: { available: true },
            },
          })
        : Response.json({}),
  });
  try {
    const { appState } = await env.vite.ssrLoadModule("/src/shell.ts");
    const { noteConnectorResult, renderConnectors } = await env.vite.ssrLoadModule("/src/connectors.ts");
    const main = document.getElementById("main")!;
    appState.mainEl = main;
    appState.currentView = "keychain";
    noteConnectorResult("acme", "connected");
    await renderConnectors();
    assert.equal(main.querySelector(".status")!.textContent, "Acme CRM: connected.");
    const rows = [...main.querySelectorAll(".kc-account")].map((row) => ({
      name: row.querySelector("h3")!.textContent,
      description: row.querySelector(".kc-resource-meta")?.textContent ?? "",
      logo: row.querySelector(".connector-logo")!.getAttribute("data-service"),
    }));
    assert.deepEqual(rows, [
      { name: "Google Workspace", description: "Gmail, Calendar, Drive, Sheets", logo: "google" },
      { name: "Acme CRM", description: "Deals & contacts", logo: null },
      { name: "Bare", description: "", logo: null },
    ]);
  } finally {
    await env.close();
  }
});

test("a chat connect card picks up the provider label once the provider list loads", async () => {
  let releaseConnectors = (): void => {};
  const held = new Promise<void>((resolve) => (releaseConnectors = resolve));
  const h = await harness({
    path: "/s/sess-deep",
    entries: [
      {
        seq: 1,
        type: "assistant",
        createdAt: 1,
        payload: { text: "[Connect](http://localhost/connect/redeem/x?p=acme)" },
      },
    ],
    api: (path) =>
      path === "/api/connectors"
        ? held.then(() => Response.json({ providers: { acme: { label: "Acme CRM" } } }))
        : undefined,
  });
  const cardTitle = () => document.querySelector(".connector-widget strong")?.textContent;
  try {
    await h.boot();
    for (let i = 0; i < 100 && !cardTitle(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cardTitle(), "Connect Acme");
    releaseConnectors();
    for (let i = 0; i < 100 && cardTitle() !== "Connect Acme CRM"; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cardTitle(), "Connect Acme CRM");
    assert.equal(document.querySelector(".connector-widget .connector-logo")!.hasAttribute("data-service"), false);
  } finally {
    releaseConnectors();
    await h.close();
  }
});
