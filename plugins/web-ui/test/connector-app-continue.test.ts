import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("an app connected on its connector's own site continues the chat once", async () => {
  let items: unknown[] = [];
  const h = await harness({
    path: "/",
    api: (path) => {
      if (path.startsWith("/api/composio/connections")) return Response.json({ items, nextCursor: null });
      if (path.startsWith("/api/composio/toolkits"))
        return Response.json({
          items: [
            {
              id: "granola",
              name: "Granola",
              description: "",
              connectUrl: "https://partner.example/integrations#granola",
              connector: "partner",
            },
          ],
          nextCursor: null,
        });
    },
  });
  const opened: string[] = [];
  const continued: string[] = [];
  try {
    h.releaseSessions();
    await h.boot();
    window.open = ((url: string) => {
      opened.push(url);
      return null;
    }) as typeof window.open;
    const card = Object.assign(document.createElement("qm-onboarding-welcome"), {
      me: { org: "test", user: "tester" },
      widget: "apps",
      setupOnly: true,
      toolkit: "granola",
      returnKey: "reply:2:0:0",
      onConnected: (name: string) => continued.push(name),
    });
    document.querySelector(".message-stack")!.append(card);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    for (let i = 0; i < 100 && !card.querySelector('button[aria-label="Connect Granola"]'); i++) await settle();
    card.querySelector<HTMLButtonElement>('button[aria-label="Connect Granola"]')!.click();
    await settle();
    assert.deepEqual(opened, ["https://partner.example/integrations#granola"]);
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.deepEqual(continued, []);
    items = [{ id: "", toolkit: "granola", connector: "partner", missingScopes: [] }];
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.deepEqual(continued, ["Granola"]);
  } finally {
    await h.close();
  }
});
