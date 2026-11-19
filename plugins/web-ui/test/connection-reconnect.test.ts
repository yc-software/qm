import assert from "node:assert/strict";
import test from "node:test";
import { connectWidget, harness, settle } from "./deep-link-boot-fixture.ts";

test("a connection missing configured permissions can be reconnected or disconnected", async () => {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  let items = [{ id: "ca_old", toolkit: "gmail", missingScopes: ["gmail.send"] }];
  const h = await harness({
    path: "/s/sess-deep",
    api: (path, init) => {
      if (path.startsWith("/api/composio/connections")) return Response.json({ items, nextCursor: null });
      if (init?.method !== "POST" || !path.startsWith("/api/composio/")) return undefined;
      const body = JSON.parse(String(init.body));
      posts.push({ path, body });
      if (path === "/api/composio/disconnect") {
        items = [];
        return Response.json({ disconnected: body.accountId, toolkit: "gmail" });
      }
      return Response.json({ url: "https://connect.composio.dev/link/lk_test", accountId: "ca_new" });
    },
  });
  try {
    await h.boot();
    const widget = connectWidget();
    await settle(() => Boolean(widget.querySelector(".connection-card .btn.primary")));
    const app = widget.querySelector<HTMLButtonElement>(".connection-card .btn.primary")!;
    assert.equal(app.disabled, false);
    assert.equal(app.getAttribute("aria-label"), "Reconnect Gmail");
    assert.equal(widget.querySelector(".connection-card-status")?.textContent?.trim(), "Needs new permissions");
    app.click();
    await settle(() => JSON.parse(sessionStorage.getItem("qm-connection-return:test:tester") ?? "{}").accountId);
    assert.deepEqual(
      posts.map((post) => [post.path, post.body.toolkit]),
      [["/api/composio/authorize", "gmail"]],
    );
    const attempt = JSON.parse(sessionStorage.getItem("qm-connection-return:test:tester")!);
    assert.deepEqual([attempt.accountId, attempt.replaces], ["ca_new", "ca_old"]);

    await settle(() => !widget.querySelector<HTMLButtonElement>(".connection-card .kc-text-action")?.disabled);
    const disconnect = widget.querySelector<HTMLButtonElement>(".connection-card .kc-text-action")!;
    assert.equal(disconnect.getAttribute("aria-label"), "Disconnect Gmail");
    const answers = [false, true];
    window.confirm = () => answers.shift()!;
    disconnect.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(posts.length, 1);
    disconnect.click();
    const primary = () => widget.querySelector(".connection-card .btn.primary")?.getAttribute("aria-label");
    await settle(() => primary() === "Connect Gmail");
    assert.deepEqual(posts.at(-1), { path: "/api/composio/disconnect", body: { accountId: "ca_old" } });
    assert.equal(widget.querySelector(".connection-card-status")?.textContent?.trim(), "Not connected");
    assert.equal(widget.querySelector(".connection-card .kc-text-action"), null);
  } finally {
    await h.close();
  }
});
