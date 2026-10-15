import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { resolveBrowserModel } from "../src/model/browser-model.ts";

test("browse-lab model name follows durable user AI access and personal model defaults", async () => {
  const built = buildApp(testConfig());
  const input = {
    actorId: "U1",
    config: built.config,
    credentials: built.userModelCredentials,
    companyModel: "claude-opus-5",
  };
  assert.deepEqual(await resolveBrowserModel(input), { account: "company", model: "claude-opus-5", routing: null });
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai-key");
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-claude-key");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  let selected = await resolveBrowserModel(input);
  assert.equal(selected.account, "openai");
  assert.equal(selected.routing?.provider, "openai");
  assert.equal(selected.routing?.kind, "apikey");
  await built.config.setBaseModel("personal:U1", "gpt-5.6-terra");
  assert.equal((await resolveBrowserModel(input)).model, "gpt-5.6-terra");
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  selected = await resolveBrowserModel(input);
  assert.equal(selected.routing?.provider, "anthropic");
  assert.equal(selected.model, "claude-opus-5");
  await built.userModelCredentials.delete("U1", "anthropic");
  selected = await resolveBrowserModel(input);
  assert.equal(selected.account, "anthropic");
  assert.equal(selected.routing, null);
  assert.equal(selected.model, undefined);
});
