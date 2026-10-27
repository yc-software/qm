import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

const settle = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

function gmailWidget(): HTMLElement {
  const widget = Object.assign(document.createElement("qm-connect-apps"), {
    me: { org: "test", user: "tester" },
    widget: "apps",
    toolkit: "gmail",
    returnKey: "reply:1:0:0",
  });
  document.querySelector(".message-stack")!.append(widget);
  return widget;
}

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
    const widget = gmailWidget();
    await settle(() => Boolean(widget.querySelector(".connection-picker-app")));
    const app = widget.querySelector<HTMLButtonElement>(".connection-picker-app")!;
    assert.equal(app.disabled, false);
    assert.equal(app.getAttribute("aria-label"), "Reconnect Gmail");
    assert.match(widget.textContent ?? "", /Gmail needs new permissions/);
    app.click();
    await settle(() => JSON.parse(sessionStorage.getItem("qm-connection-return:test:tester") ?? "{}").accountId);
    assert.deepEqual(
      posts.map((post) => [post.path, post.body.toolkit]),
      [["/api/composio/authorize", "gmail"]],
    );
    const attempt = JSON.parse(sessionStorage.getItem("qm-connection-return:test:tester")!);
    assert.deepEqual([attempt.accountId, attempt.replaces], ["ca_new", "ca_old"]);

    const disconnect = [...widget.querySelectorAll<HTMLButtonElement>(".connection-connected button")].find(
      (button) => button.textContent?.trim() === "Disconnect",
    )!;
    const answers = [false, true];
    window.confirm = () => answers.shift()!;
    disconnect.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(posts.length, 1);
    disconnect.click();
    await settle(() => !widget.querySelector(".connection-connected"));
    assert.deepEqual(posts.at(-1), { path: "/api/composio/disconnect", body: { accountId: "ca_old" } });
    assert.equal(widget.querySelector(".connection-picker-app")?.getAttribute("aria-label"), "Connect Gmail");
  } finally {
    await h.close();
  }
});
