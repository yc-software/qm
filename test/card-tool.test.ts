import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCard } from "../src/agent/agent-tools/card.ts";

const api = (routes: Record<string, [number, unknown]>) => async (path: string) => {
  const [status, body] = routes[path] ?? [404, { error: "not_found" }];
  return { status, body };
};

test("link_slack refuses when QM isn't installed in the company Slack", async () => {
  const check = await checkCard(
    api({ "/v1/composio/slack": [200, { connected: false, workspaceInstalled: false }] }),
    "link_slack",
  );
  assert.ok("error" in check);
  assert.match(check.error, /isn't in the company's Slack workspace yet/);
  assert.match(check.error, /add_to_slack/);
});

test("link_slack shows the card once installed, and nothing when already linked", async () => {
  assert.deepEqual(
    await checkCard(api({ "/v1/composio/slack": [200, { connected: false, workspaceInstalled: true }] }), "link_slack"),
    { card: { kind: "link_slack" }, note: "The Link your Slack account card is shown with your reply." },
  );
  const linked = await checkCard(
    api({ "/v1/composio/slack": [200, { connected: true, workspaceInstalled: true, user: "ada", workspace: "Acme" }] }),
    "link_slack",
  );
  assert.deepEqual(linked, { done: "Their Slack account is already linked (ada in Acme). No card needed." });
});

test("add_to_slack is only for admins and only before installation", async () => {
  const member = await checkCard(
    api({ "/v1/admin/slack-installation": [403, { error: "forbidden" }] }),
    "add_to_slack",
  );
  assert.ok("error" in member && /isn't one/.test(member.error));
  const installed = await checkCard(
    api({ "/v1/admin/slack-installation": [200, { configured: true }] }),
    "add_to_slack",
  );
  assert.ok("error" in installed && /link_slack/.test(installed.error));
  const ready = await checkCard(api({ "/v1/admin/slack-installation": [200, { configured: false }] }), "add_to_slack");
  assert.deepEqual(ready, { card: { kind: "add_to_slack" }, note: "The Add to Slack card is shown with your reply." });
});

test("apps validates the app id and uses the catalog's id", async () => {
  const routes = api({
    "/v1/composio/toolkits?toolkit=notion": [200, { items: [{ id: "notion", name: "Notion" }] }],
    "/v1/composio/toolkits?toolkit=nope": [200, { items: [] }],
    "/v1/composio/toolkits": [403, { error: "composio_unavailable", message: "App connections aren’t available" }],
  });
  assert.deepEqual(await checkCard(routes, "apps", "notion"), {
    card: { kind: "apps", toolkit: "notion" },
    note: "The Notion connect card is shown with your reply.",
  });
  const missing = await checkCard(routes, "apps", "nope");
  assert.ok("error" in missing && /No connectable app has the id "nope"/.test(missing.error));
  const unavailable = await checkCard(routes, "apps");
  assert.ok("error" in unavailable && /HTTP 403: App connections/.test(unavailable.error));
  const slack = await checkCard(routes, "apps", "slack");
  assert.ok("error" in slack && /link_slack/.test(slack.error));
});
