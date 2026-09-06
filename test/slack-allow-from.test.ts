import assert from "node:assert/strict";
import { test } from "node:test";
import { createActorGate, createDenyResponder, normalizeAllowFrom, parseAllowFrom } from "../src/slack/allow-from.ts";
import { slackAccountConfigsFromEnv } from "../src/slack/config.ts";

test("parseAllowFrom splits, lowercases, strips @-prefixes, and dedupes", () => {
  assert.deepEqual(parseAllowFrom("Alice@Example.com, @example.org example.org\nbob@example.com"), [
    "alice@example.com",
    "example.org",
    "bob@example.com",
  ]);
  assert.deepEqual(parseAllowFrom(undefined), []);
  assert.deepEqual(parseAllowFrom("  ,  "), []);
});

test("normalizeAllowFrom accepts only strings", () => {
  assert.deepEqual(normalizeAllowFrom(["YC.com", 7, null, "a@b.co"]), ["yc.com", "a@b.co"]);
  assert.deepEqual(normalizeAllowFrom(undefined), []);
});

test("createActorGate admits exact emails and whole domains, nothing else", () => {
  const gate = createActorGate(["example.org", "guest@partner.co"])!;
  assert.equal(gate({ externalId: "josh@example.org", isExternalGuest: false }), true);
  assert.equal(gate({ externalId: "Josh@example.org", isExternalGuest: false }), true);
  assert.equal(gate({ externalId: "guest@partner.co", isExternalGuest: false }), true);
  assert.equal(gate({ externalId: "founder@startup.io", isExternalGuest: false }), false);
  assert.equal(gate({ externalId: "other@partner.co", isExternalGuest: false }), false);
  assert.equal(gate({ externalId: "josh@example.org", isExternalGuest: true }), false);
  assert.equal(gate({ externalId: "B123", isExternalGuest: false, isBot: true }), false);
  assert.equal(gate({ externalId: "U123", isExternalGuest: false }), false);
});

test("createActorGate is absent when no entries are configured", () => {
  assert.equal(createActorGate(undefined), undefined);
  assert.equal(createActorGate([]), undefined);
});

test("slackAccountConfigsFromEnv parses accounts as non-singleton email-keyed configs", () => {
  const accounts = slackAccountConfigsFromEnv({
    SLACK_ACCOUNTS: JSON.stringify([
      {
        id: "w26",
        botToken: "xoxb-a",
        appToken: "xapp-a",
        allowFrom: ["YC.com", "alice@example.com"],
        denyMessage: " Staff only. ",
      },
      {
        id: "s26",
        botToken: "xoxb-b",
        eventsMode: "http",
        signingSecret: "sig",
        eventsPort: 3111,
        apiUrl: "https://twin.example/api",
        allowFrom: "yc.com",
      },
    ]),
  });
  assert.equal(accounts.length, 2);
  assert.deepEqual(
    accounts.map((a) => [a.accountId, a.coreSingleton, a.identityEmail, a.allowFrom]),
    [
      ["w26", false, "1", ["yc.com", "alice@example.com"]],
      ["s26", false, "1", ["yc.com"]],
    ],
  );
  assert.equal(accounts[0]!.denyMessage, "Staff only.");
  assert.equal(accounts[1]!.denyMessage, undefined);
  assert.equal(accounts[1]!.eventsMode, "http");
  assert.equal(accounts[1]!.eventsPort, 3111);
});

test("slackAccountConfigsFromEnv is empty without SLACK_ACCOUNTS and fails closed on bad input", () => {
  assert.deepEqual(slackAccountConfigsFromEnv({}), []);
  assert.throws(() => slackAccountConfigsFromEnv({ SLACK_ACCOUNTS: "{not json" }), /not valid JSON/);
  assert.throws(() => slackAccountConfigsFromEnv({ SLACK_ACCOUNTS: "{}" }), /JSON array/);
  assert.throws(() => slackAccountConfigsFromEnv({ SLACK_ACCOUNTS: JSON.stringify([{ botToken: "x" }]) }), /"id"/);
  assert.throws(
    () =>
      slackAccountConfigsFromEnv({
        SLACK_ACCOUNTS: JSON.stringify([
          { id: "a", botToken: "x", appToken: "y" },
          { id: "a", botToken: "x2", appToken: "y2" },
        ]),
      }),
    /duplicate id/,
  );
  assert.throws(
    () => slackAccountConfigsFromEnv({ SLACK_ACCOUNTS: JSON.stringify([{ id: "a", botToken: "xoxb-only" }]) }),
    /missing required tokens/,
  );
});

test("createDenyResponder returns undefined for empty messages", () => {
  assert.equal(createDenyResponder(undefined), undefined);
  assert.equal(createDenyResponder("  "), undefined);
});

test("createDenyResponder throttles repeats per key but not across keys", () => {
  const r = createDenyResponder("no entry", 60_000)!;
  assert.equal(r.message, "no entry");
  assert.equal(r.shouldSend("C1:U2"), true);
  assert.equal(r.shouldSend("C1:U2"), false);
  assert.equal(r.shouldSend("C1:U3"), true);
  assert.equal(r.shouldSend("D9:U2"), true);
});
