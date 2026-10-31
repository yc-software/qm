import assert from "node:assert/strict";
import test from "node:test";
import { harness } from "./deep-link-boot-fixture.ts";

export function slackReturnTest(outcome: "success" | "expired" | "cancelled" | "wrong-account", session = false) {
  test(`Slack callback survives real router boot: ${outcome}`, async () => {
    const h = await harness({
      welcome: session,
      path: `${session ? "/s/sess-deep?" : "/settings?"}slackReturn=qa-slack-nonce${outcome === "cancelled" ? "&error=access_denied" : ""}`,
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
      if (session) {
        assert.equal(location.pathname, "/s/sess-deep");
        assert.equal(h.visibleConversation().state.sessionId, "sess-deep");
      }
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

export function discordReturnTest(
  outcome:
    | "success"
    | "expired"
    | "cancelled"
    | "wrong-account"
    | "admin-link"
    | "both-code-and-error"
    | "complete-failed"
    | "state-mismatch",
  session = false,
) {
  test(`Discord callback survives real router boot: ${outcome}`, async () => {
    let query = "state=qa-discord-state";
    if (outcome === "cancelled") {
      query += "&error=access_denied";
    } else if (outcome === "both-code-and-error") {
      query += "&code=abc&error=access_denied";
    } else {
      query += "&code=abc";
    }
    const h = await harness({
      welcome: session,
      path: `${session ? "/s/sess-deep?" : "/settings?"}${query}`,
      discordReturn: outcome,
    });
    try {
      h.releaseSessions();
      await h.boot();
      const expected = {
        success: /Connected as ana_d/,
        "admin-link": /Linked by an administrator/,
        cancelled: /Discord authorization was cancelled/,
        "both-code-and-error": /Discord authorization was cancelled/,
        expired: /expired or was started in another/,
        "wrong-account": /expired or was started in another/,
        "complete-failed": /Discord did not confirm the account/,
        "state-mismatch": /expired or was started in another/,
      }[outcome];
      for (let i = 0; i < 200 && !expected.test(h.mainText()); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.match(h.mainText(), expected);
      if (session) {
        assert.equal(location.pathname, "/s/sess-deep");
        assert.equal(h.visibleConversation().state.sessionId, "sess-deep");
      }
      const shouldCallComplete = outcome === "success" || outcome === "admin-link" || outcome === "complete-failed";
      assert.equal(
        h.requests.some((p) => p.includes("/api/discord/link/complete")),
        shouldCallComplete,
      );
      if (
        outcome === "success" ||
        outcome === "admin-link" ||
        outcome === "complete-failed" ||
        outcome === "state-mismatch"
      ) {
        assert.equal(sessionStorage.getItem("qm-discord-account"), null);
      }
      if (outcome === "admin-link") {
        const discordAccount = document.querySelector("qm-discord-account");
        assert.ok(discordAccount);
        assert.equal(discordAccount.querySelector("button"), null);
      }
      if (outcome === "success") {
        const discordAccount = document.querySelector("qm-discord-account");
        assert.ok(discordAccount);
        const button = discordAccount.querySelector("button");
        assert.ok(button);
        assert.equal(button.textContent, "Disconnect");
      }
    } finally {
      await h.close();
    }
  });
}
