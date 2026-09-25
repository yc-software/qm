import assert from "node:assert/strict";
import { test } from "node:test";

import { connectorLinksIn, connectorService, stripConnectorLinks } from "../src/connector-link.ts";

const URL = "https://agent.example.com/connect/redeem/abc123?p=google";
const LEGACY_URL = "https://agent.example.com/v1/connectors/oauth/consent/redeem/abc123?p=google";
const AUTH_URL = "https://managed-auth.onkernel.com/login/abc123?code=xyz789";

test("a bold-wrapped consent link leaves no orphan asterisks", () => {
  const out = stripConnectorLinks(`Here's your link: **${URL}**`);
  assert.equal(out, "Here's your link:");
  assert.ok(!out.includes("*"));
});

test("a bold markdown-link is stripped whole, emphasis and all", () => {
  const out = stripConnectorLinks(`**[Connect Google](${URL})**`);
  assert.equal(out, "");
});

test("italic/underscore emphasis around the link is also consumed", () => {
  assert.equal(stripConnectorLinks(`*${URL}*`), "");
  assert.equal(stripConnectorLinks(`__${URL}__`), "");
});

test("the link is still detected for the widget regardless of emphasis", () => {
  const links = connectorLinksIn(`**${URL}**`);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.provider, "google");
  assert.equal(links[0]!.url, URL, "trailing emphasis must not bleed into the URL/provider");
});

test("a link glued to a long unbalanced emphasis run is rejected fast", () => {
  const started = performance.now();
  assert.deepEqual(connectorLinksIn(`${URL}${"*".repeat(60)}x`), []);
  assert.ok(performance.now() - started < 100);
});

test("the legacy /v1 consent link is still detected and stripped during the migration overlap", () => {
  assert.equal(stripConnectorLinks(`**${LEGACY_URL}**`), "");
  const links = connectorLinksIn(`tap ${LEGACY_URL}`);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.provider, "google");
  assert.equal(links[0]!.url, LEGACY_URL);
});

test("branded consent cards require the trusted origin and a known provider", () => {
  assert.equal(
    connectorLinksIn("https://evil.example/connect/redeem/x?p=google", "https://agent.example.com").length,
    0,
  );
  assert.equal(
    connectorLinksIn("https://agent.example.com/connect/redeem/x?p=unknown", "https://agent.example.com").length,
    0,
  );
  assert.equal(connectorLinksIn(URL, "https://agent.example.com").length, 1);
});

test("surrounding prose is preserved", () => {
  const out = stripConnectorLinks(`tap it: **${URL}**\n\nit expires soon.`);
  assert.equal(out, "tap it:\n\nit expires soon.");
});

test("a managed-auth login link is left untouched — it must render as an ordinary link in chat", () => {
  const text = `Here's your secure sign-in link:\n\n${AUTH_URL}\n\nTell me once you're through.`;
  assert.equal(stripConnectorLinks(text), text);
});

const COMPOSIO_URL = "https://connect.composio.dev/link/lk_example123";

test("Composio hosted consent links reuse the connector widget", () => {
  assert.deepEqual(connectorLinksIn(COMPOSIO_URL, "https://agent.example.com"), [
    { provider: "composio", url: COMPOSIO_URL },
  ]);
});

test("Composio supports bare, markdown, autolink and emphasized links", () => {
  for (const text of [
    COMPOSIO_URL,
    `**${COMPOSIO_URL}**`,
    `<${COMPOSIO_URL}>`,
    `[Connect Gmail](${COMPOSIO_URL})`,
    `**[Connect Gmail](<${COMPOSIO_URL}>)**`,
  ]) {
    const links = connectorLinksIn(text, "https://agent.example.com");
    assert.deepEqual(links, [
      {
        provider: "composio",
        url: COMPOSIO_URL,
        ...(text.includes("[Connect Gmail]") ? { label: "Connect Gmail" } : {}),
      },
    ]);
    assert.equal(stripConnectorLinks(text, links), "");
  }
});

test("Composio URLs retain query parameters and deduplicate", () => {
  const url = `${COMPOSIO_URL}?callback_url=https%3A%2F%2Fexample.com%2Fdone`;
  assert.deepEqual(connectorLinksIn(`${url}\n${url}`), [{ provider: "composio", url }]);
});

test("only HTTPS Composio hosted link URLs become cards", () => {
  for (const url of [
    "http://connect.composio.dev/link/lk_example123",
    "https://connect.composio.dev.evil.example/link/lk_example123",
    "https://evil.example/link/lk_example123",
    "https://user@connect.composio.dev/link/lk_example123",
    "https://connect.composio.dev:444/link/lk_example123",
    "https://connect.composio.dev/other/lk_example123",
    "https://connect.composio.dev/link/",
    "https://connect.composio.dev/link/lk_example123/extra",
  ]) {
    assert.deepEqual(connectorLinksIn(url, "https://agent.example.com"), [], url);
    assert.equal(stripConnectorLinks(url), url);
  }
});

test("stripping removes only links actually rendered as cards", () => {
  const foreign = "https://evil.example/connect/redeem/x?p=google";
  const text = `${COMPOSIO_URL}\n${foreign}`;
  assert.equal(stripConnectorLinks(text, connectorLinksIn(text, "https://agent.example.com")), foreign);
});

test("stripping a card does not remove the prefix of an unrecognized URL", () => {
  const other = `${URL}unknown`;
  const text = `${URL}\n${other}`;
  assert.equal(stripConnectorLinks(text, connectorLinksIn(text, "https://agent.example.com")), other);
});

test("multiple Composio cards retain their own arbitrary link labels and order", () => {
  const labels = ["Connect Calendar", "Connect Gmail", "Connect Google Drive", "Authorize Paper Lantern 🌙"];
  const text = labels.map((label, i) => `[${label}](https://connect.composio.dev/link/lk_test${i})`).join("\n");
  assert.deepEqual(
    connectorLinksIn(text),
    labels.map((label, i) => ({
      provider: "composio",
      url: `https://connect.composio.dev/link/lk_test${i}`,
      label,
    })),
  );
  assert.equal(stripConnectorLinks(text), "");
});

test("a labeled duplicate gives an earlier bare URL its label without another card", () => {
  const text = `${COMPOSIO_URL}\n[  Authorize anything  ](${COMPOSIO_URL})\n[Other label](${COMPOSIO_URL})`;
  assert.deepEqual(connectorLinksIn(text), [{ provider: "composio", url: COMPOSIO_URL, label: "Authorize anything" }]);
});

test("empty labels retain the generic fallback and native names cannot be relabeled", () => {
  assert.deepEqual(connectorLinksIn(`[  ](${COMPOSIO_URL})`), [{ provider: "composio", url: COMPOSIO_URL }]);
  assert.deepEqual(connectorLinksIn(`[Something else](${URL})`), [{ provider: "google", url: URL }]);
});

test("Slack bot setup uses one same-origin checklist, not a personal connection card", () => {
  const url = "https://agent.example.com/admin?slack=setup";
  const text = `[Set up Slack](${url})`;
  const links = connectorLinksIn(text, "https://agent.example.com");
  assert.deepEqual(links, [{ provider: "slack-bot", url }]);
  assert.equal(stripConnectorLinks(text, links), "");
  assert.deepEqual(connectorLinksIn(text, "https://other.example.com"), []);
  assert.deepEqual(connectorLinksIn(text), []);
  assert.deepEqual(connectorLinksIn(url + "&company=other", "https://agent.example.com"), []);
});

test("Composio service logos use recognizable names without changing the destination", () => {
  for (const [label, service] of [
    ["Connect Gmail", "gmail"],
    ["Authorize Google Calendar", "googlecalendar"],
    ["Connect Calendar", "googlecalendar"],
    ["Connect Google Drive", "googledrive"],
    ["Connect Google Sheets", "googlesheets"],
    ["Connect GitHub", "github"],
    ["Connect Slack", "slack"],
    ["Connect Notion", "notion"],
    ["Authorize Paper Lantern 🌙", ""],
    ["Connect Outlook Calendar", ""],
    ["Connect Gmail and Slack", ""],
    ["Connect linearly", ""],
  ]) {
    const [link] = connectorLinksIn(`[${label}](${COMPOSIO_URL})`);
    assert.equal(connectorService(link!), service, label);
    assert.equal(link!.url, COMPOSIO_URL);
    assert.equal(link!.label, label);
  }
  assert.equal(connectorService({ provider: "composio", url: COMPOSIO_URL }), "");
  assert.equal(connectorService({ provider: "github", url: URL, label: "Slack" }), "github");
});
