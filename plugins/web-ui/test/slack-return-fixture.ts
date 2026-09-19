import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

export function slackReturnTest(outcome: "success" | "expired" | "cancelled" | "wrong-account") {
  test(`Slack callback survives real router boot: ${outcome}`, async () => {
    const h = await harness({
      path: `/?view=settings&slackReturn=qa-slack-nonce${outcome === "cancelled" ? "&error=access_denied" : ""}`,
      slackReturn: outcome,
    });
    try {
      h.releaseSessions();
      await h.boot();
      const expected = {
        success: /Your Slack account is linked/,
        cancelled: /authorization was cancelled/,
        expired: /expired or was started in another/,
        "wrong-account": /expired or was started in another/,
      }[outcome];
      for (let i = 0; i < 100 && !expected.test(h.mainText()); i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.match(h.mainText(), expected);
      assert.equal(
        h.requests.some((p) => p.includes("/api/composio/slack/complete")),
        outcome === "success",
      );
      if (outcome === "success") assert.equal(sessionStorage.getItem("qm-slack-account"), null);
    } finally {
      await h.close();
    }
  });
}
