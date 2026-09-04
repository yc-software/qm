import assert from "node:assert/strict";
import { test } from "node:test";

import { connectorLinksIn, stripConnectorLinks } from "../src/connector-link.ts";

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
