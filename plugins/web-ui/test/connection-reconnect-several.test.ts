import assert from "node:assert/strict";
import test from "node:test";
import { connectWidget, harness, settle } from "./deep-link-boot-fixture.ts";

test("with several accounts for one app, each is reconnected from its own row", async () => {
  const h = await harness({
    path: "/s/sess-deep",
    api: (path, init) => {
      if (path.startsWith("/api/composio/connections"))
        return Response.json({
          items: ["ca_work", "ca_home"].map((id) => ({ id, toolkit: "gmail", missingScopes: ["gmail.send"] })),
          nextCursor: null,
        });
      if (init?.method !== "POST" || path !== "/api/composio/authorize") return undefined;
      return Response.json({ url: "https://connect.composio.dev/link/lk_test", accountId: "ca_new" });
    },
  });
  try {
    await h.boot();
    const widget = connectWidget();
    const rows = () => [...widget.querySelectorAll<HTMLElement>(".connection-connected > span")];
    await settle(() => rows().length === 2);
    assert.equal(widget.querySelector(".connection-card-status")?.textContent?.trim(), "Needs new permissions");
    assert.equal(widget.querySelector(".connection-card button"), null);
    rows()[1]!.querySelector<HTMLButtonElement>(".kc-text-action")!.click();
    const attempt = () => JSON.parse(sessionStorage.getItem("qm-connection-return:test:tester") ?? "{}");
    await settle(() => attempt().accountId);
    assert.deepEqual([attempt().accountId, attempt().replaces], ["ca_new", "ca_home"]);
  } finally {
    await h.close();
  }
});
