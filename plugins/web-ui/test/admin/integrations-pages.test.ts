import assert from "node:assert/strict";
import test from "node:test";
import { mountPage, type Route } from "./fixture.ts";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
type Page = Awaited<ReturnType<typeof mountPage>>;
const type = (admin: Page, selector: string, value: string, event = "input") => {
  const input = admin.document.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new admin.window.Event(event, { bubbles: true }));
};
const click = (admin: Page, selector: string) => admin.document.querySelector<HTMLButtonElement>(selector)!.click();

const slackRoutes = (
  saves: unknown[],
  installation: object = { configured: true, source: "admin", teamName: "Acme" },
) => {
  const record: Route = ({ path, body }) => (saves.push([decodeURIComponent(path), body]), { ok: true });
  return {
    "/scopes/org:acme": { externalSlackParticipants: false, channelHeaderPinDefault: true, ackEmoji: ["eyes"] },
    "/slack-installation": installation,
    "/slack-emoji": {
      emoji: {},
      standard: [
        ["eyes", "👀", "People"],
        ["tada", "🎉", "Activities"],
      ],
    },
    "PUT /scopes/org:acme/external-slack-participants": record,
    "PUT /scopes/org:acme/channel-header-pin-default": record,
    "PUT /scopes/org:acme/ack-emoji": record,
    "PUT /slack-installation": ({ body }: { body: unknown }) => (
      saves.push(["/slack-installation", body]),
      { ok: true }
    ),
  };
};

test("Slack settings review the audience change, save toggles, and save picked emoji at once", async () => {
  const saves: unknown[] = [];
  const admin = await mountPage("/settings/slack-settings", slackRoutes(saves));
  await admin.settle();
  assert.equal(admin.document.getElementById("slack-installation-state")!.textContent, "Acme");
  click(admin, '[name="external-slack-choice"][value="on"]');
  click(admin, '[data-save="external-slack-participants"]');
  await admin.settle();
  click(admin, "#governance-review-cancel");
  await admin.settle();
  assert.deepEqual(saves, []);
  click(admin, '[data-save="external-slack-participants"]');
  await admin.settle();
  assert.match(admin.document.getElementById("governance-review-title")!.textContent!, /Allow external Slack/);
  click(admin, "#governance-review-confirm");
  await admin.settle();
  click(admin, "#channel-header-pin-default");
  click(admin, '[data-save="channel-header-pin-default"]');
  await admin.settle();
  click(admin, "#ack-emoji-open");
  click(admin, '#ack-emoji-results [aria-label="tada"]');
  await admin.settle();
  assert.deepEqual(plain(saves), [
    ["/scopes/org:acme/external-slack-participants", { on: true }],
    ["/scopes/org:acme/channel-header-pin-default", { on: false }],
    ["/scopes/org:acme/ack-emoji", { names: ["eyes", "tada"] }],
  ]);
  assert.equal(admin.document.querySelector(".card.dirty"), null);
  admin.close();
});

test("Slack connection validates token drafts before submitting", async () => {
  const saves: unknown[] = [];
  const admin = await mountPage("/settings/slack-settings", slackRoutes(saves, { configured: false }));
  await admin.settle();
  assert.equal(admin.document.querySelector<HTMLDetailsElement>("#slack-own-app-guide")!.open, true);
  click(admin, "#slack-enter-tokens");
  type(admin, "#slack-bot-token", "xoxb-1");
  click(admin, "#slack-installation-save");
  await admin.settle();
  assert.equal(admin.document.getElementById("st-slack-installation")!.textContent, "Both Slack tokens are required.");
  type(admin, "#slack-app-token", "xapp-1");
  click(admin, "#slack-installation-save");
  await admin.settle();
  assert.deepEqual(plain(saves), [["/slack-installation", { botToken: "xoxb-1", appToken: "xapp-1" }]]);
  admin.close();
});

test("connectors save the OAuth client and delete it", async () => {
  const saves: unknown[] = [];
  let list: object[] = [];
  const admin = await mountPage("/settings/connectors", {
    "/connector-catalog": {
      catalog: [
        {
          provider: "github",
          redirectPath: "github",
          scopes: ["repo"],
          setupGuide: { url: "https://example.com", console: "GitHub", steps: ["Create app"] },
        },
      ],
    },
    "/scopes/org:acme": () => ({ connectors: list }),
    "PUT /scopes/org:acme/connectors": ({ body }) => {
      saves.push(body);
      list = body.delete ? [] : [{ provider: body.provider, clientId: body.clientId, hasSecret: true }];
      return { ok: true };
    },
  });
  await admin.settle();
  assert.match(admin.document.getElementById("built-in-connectors")!.textContent!, /Github/);
  click(admin, "#add-oauth-app");
  assert.match(
    admin.document.getElementById("conn-guide")!.textContent!,
    /Callback URL: http:\/\/localhost\/v1\/connectors\/oauth\/github/,
  );
  type(admin, "#conn-client-id", " cid ");
  type(admin, "#conn-client-secret", "secret");
  click(admin, "#conn-save");
  await admin.settle();
  assert.match(admin.document.getElementById("conn-list")!.textContent!, /client cid/);
  click(admin, '#conn-list [aria-label="Delete Github"]');
  await admin.settle();
  assert.deepEqual(plain(saves), [
    { provider: "github", clientId: "cid", clientSecret: "secret", enabled: true },
    { provider: "github", delete: true },
  ]);
  admin.close();
});
