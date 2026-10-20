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

test("a failed reconnect leaves the existing connection in place", async () => {
  const disconnects: unknown[] = [];
  const h = await harness({
    path: "/s/sess-deep?composioReturn=return-nonce&status=failed&error=access_denied&connectedAccountId=ca_new",
    api: (path) => {
      if (path.startsWith("/api/composio/connections"))
        return Response.json({ items: [{ id: "ca_old", toolkit: "gmail", missingScopes: ["gmail.send"] }] });
      if (path === "/api/composio/disconnect") disconnects.push(path);
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
    await settle(() => /wasn’t connected/.test(widget.textContent ?? ""));
    assert.match(widget.textContent ?? "", /Gmail wasn’t connected/);
    assert.deepEqual(disconnects, []);
    assert.match(widget.textContent ?? "", /needs new permissions/);
  } finally {
    await h.close();
  }
});
