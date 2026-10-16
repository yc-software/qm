import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

test("Slack account linking selects native OAuth and preserves the conversation return path", async () => {
  const h = await harness({ path: "/settings" });
  const previousFetch = globalThis.fetch;
  const starts: string[] = [];
  let composioStarts = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/composio/slack")
      return Response.json({ connected: false, nativeOAuth: true, workspaceInstalled: true });
    if (String(input) === "/api/connectors/slack/start") {
      starts.push(JSON.parse(String(init?.body)).returnTo);
      return Response.json({ authorizeUrl: "https://untrusted.test/oauth/v2/authorize" });
    }
    if (String(input) === "/api/composio/slack/authorize") composioStarts++;
    return previousFetch(input, init);
  };
  try {
    h.releaseSessions();
    await h.boot();
    const card = document.querySelector("qm-slack-account")!;
    history.replaceState(null, "", "/s/sess-deep?layout=single");
    (card.querySelector("button") as HTMLButtonElement).click();
    for (let i = 0; i < 100 && !card.textContent?.includes("Could not verify"); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(starts, ["/s/sess-deep?layout=single"]);
    assert.equal(composioStarts, 0);
    assert.match(card.textContent ?? "", /Could not verify the Slack authorization link/);
    assert.equal(location.pathname, "/s/sess-deep");
  } finally {
    globalThis.fetch = previousFetch;
    await h.close();
  }
});
