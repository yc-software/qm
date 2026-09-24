import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("Slack authorization returns to the page where the account card was clicked", async () => {
  const h = await harness({ path: "/settings" });
  const previousFetch = globalThis.fetch;
  const returns: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/composio/slack/authorize") {
      returns.push(JSON.parse(String(init?.body)).returnTo);
      return Response.json({ message: "Test authorization stopped" }, { status: 503 });
    }
    return previousFetch(input, init);
  };
  try {
    h.releaseSessions();
    await h.boot();
    const card = document.querySelector("qm-slack-account")!;
    for (const path of ["/settings", "/s/sess-deep?layout=single"]) {
      history.replaceState(null, "", path);
      (card.querySelector("button") as HTMLButtonElement).click();
      await (card as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
      for (let i = 0; i < 100 && card.querySelector("button")?.disabled; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(returns.at(-1), path);
    }
    assert.equal(returns.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    await h.close();
  }
});
