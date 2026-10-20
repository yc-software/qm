import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

const settle = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

function gmailWidget(): HTMLElement {
  const widget = Object.assign(document.createElement("qm-onboarding-welcome"), {
    me: { org: "test", user: "tester" },
    widget: "apps",
    setupOnly: true,
    toolkit: "gmail",
    returnKey: "reply:1:0:0",
  });
  document.querySelector(".message-stack")!.append(widget);
  return widget;
}

test("a verified reconnect removes the replaced connection only after the new one is active", async () => {
  const disconnects: unknown[] = [];
  let items = [
    { id: "ca_old", toolkit: "gmail", missingScopes: ["gmail.send"] },
    { id: "ca_new", toolkit: "gmail", missingScopes: [] },
  ];
  const h = await harness({
    path: "/s/sess-deep?composioReturn=return-nonce&status=success&connectedAccountId=ca_new",
    api: (path, init) => {
      if (path.startsWith("/api/composio/connections")) return Response.json({ items, nextCursor: null });
      if (path === "/api/composio/disconnect") {
        const body = JSON.parse(String(init?.body));
        disconnects.push(body);
        items = items.filter((item) => item.id !== body.accountId);
        return Response.json({ disconnected: body.accountId, toolkit: "gmail" });
      }
      return undefined;
    },
  });
  sessionStorage.setItem(
    "qm-connection-return:test:tester",
    JSON.stringify({
      state: "return-nonce",
      user: "test:tester",
      path: "/s/sess-deep",
      service: { id: "gmail", name: "Gmail" },
      accountId: "ca_new",
      replaces: "ca_old",
      widget: "reply:1:0:0",
      expiresAt: Date.now() + 60000,
      picker: { query: "", expanded: false },
      scrollTop: 0,
    }),
  );
  try {
    await h.boot();
    const widget = gmailWidget();
    await settle(() => disconnects.length > 0 && /Gmail\s+connected/.test(widget.textContent ?? ""));
    assert.deepEqual(disconnects, [{ accountId: "ca_old" }]);
    assert.equal(widget.querySelectorAll(".connection-connected > span").length, 1);
    assert.doesNotMatch(widget.textContent ?? "", /needs new permissions/);
  } finally {
    await h.close();
  }
});
