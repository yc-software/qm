import assert from "node:assert/strict";
import test from "node:test";
import { validateSlackInstallation } from "../src/surfaces/slack-installation.ts";

const botToken = "xoxb-test-secret";
const appToken = "xapp-test-secret";

test("Slack validation explains provider throttling without trying to parse a non-JSON response", async () => {
  await assert.rejects(
    validateSlackInstallation(
      botToken,
      appToken,
      async () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    ),
    /in 30 seconds.*existing connection has not changed/,
  );
});

test("Slack validation identifies which token needs a scope", async () => {
  const fetchImpl: typeof fetch = async (input) =>
    new Response(
      JSON.stringify(
        String(input).endsWith("auth.test") ? { ok: true, app_id: "A1" } : { ok: false, error: "missing_scope" },
      ),
    );
  await assert.rejects(
    validateSlackInstallation(botToken, appToken, fetchImpl),
    /App-level token needs connections:write/,
  );
});

test("Slack validation gives a recoverable bot-token error without revealing credentials", async () => {
  await assert.rejects(
    validateSlackInstallation(
      botToken,
      appToken,
      async () => new Response(JSON.stringify({ ok: false, error: "token_revoked" })),
    ),
    (error: Error) => {
      assert.match(error.message, /Bot token was rejected.*current token/);
      assert.doesNotMatch(error.message, /test-secret/);
      return true;
    },
  );
});
