import assert from "node:assert/strict";
import { test } from "node:test";
import { discordUserIdOf, recipientDiscordId } from "../src/discord/config.ts";

test("discordUserIdOf only strips the discord prefix", () => {
  assert.equal(discordUserIdOf("discord:42"), "42");
  assert.equal(discordUserIdOf("U42"), null);
});

test("recipientDiscordId keeps the addressed account among several linked ones, else the first linked", () => {
  const linked = () => ["1111", "2222"];
  assert.equal(recipientDiscordId("discord:2222", linked), "2222");
  assert.equal(recipientDiscordId("m@x.test", linked), "1111");
  assert.equal(recipientDiscordId("discord:3333", linked), "1111");
  assert.equal(
    recipientDiscordId("m@x.test", () => []),
    null,
  );
});
