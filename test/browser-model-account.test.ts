import { setProviderBaseUrls } from "../src/model/provider-endpoints.ts";
import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { resolveBrowserModel } from "../src/model/browser-model.ts";
import { BrowserCompletionError, nativeBrowserCompletion } from "../src/model/browser-completion.ts";
import { zeroUsage } from "../src/harness/replay.ts";
import type { Context, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";

test("browser follows durable user AI access and personal model defaults", async () => {
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

test("ChatGPT browser inference uses refreshed subscription auth and native structured output", async () => {
  const built = buildApp(testConfig());
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: "original-access",
    refreshToken: "never-forward-refresh",
    expiresAt: Date.now() + 3600_000,
  });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const selection = await resolveBrowserModel({
    actorId: "U1",
    config: built.config,
    credentials: built.userModelCredentials,
    companyModel: "gpt-5.6-sol",
  });
  assert.equal(selection.model, "codex/gpt-5.6-sol");
  let derived = 0;
  let context: Context | undefined;
  let options: ModelsSimpleStreamOptions | undefined;
  const factory: NonNullable<Parameters<typeof nativeBrowserCompletion>[1]> = async (keys) => {
    assert.deepEqual(keys, { "openai-codex": "fresh-access" });
    return {
      completeSimple: async (model, suppliedContext, suppliedOptions) => {
        assert.equal(model.provider, "openai-codex");
        context = suppliedContext;
        options = suppliedOptions;
        return {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: zeroUsage(),
          timestamp: Date.now(),
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "result", name: "browser_result", arguments: { done: true } }],
        };
      },
    };
  };
  const result = await nativeBrowserCompletion(
    {
      selection,
      credentials: {
        ...built.userModelCredentials,
        derivedOAuth: async (actor, provider) => {
          assert.equal(actor, "U1");
          assert.equal(provider, "openai");
          derived++;
          return { accessToken: "fresh-access" };
        },
      },
      actorId: "U1",
      signal: new AbortController().signal,
      body: {
        messages: [
          { role: "system", content: "Browse safely" },
          {
            role: "user",
            content: [
              { type: "text", text: "Inspect" },
              { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
            ],
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { schema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] } },
        },
      },
    },
    factory,
  );
  assert.equal(derived, 1);
  assert.equal(result.choices[0]?.message.content, '{"done":true}');
  assert.ok(context?.systemPrompt?.includes("Browse safely"));
  assert.deepEqual(context?.messages[0]?.content, [
    { type: "text", text: "Inspect" },
    { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
  ]);
  const model = { api: "openai-codex-responses" } as Parameters<NonNullable<ModelsSimpleStreamOptions["onPayload"]>>[1];
  assert.deepEqual(await options?.onPayload?.({ model: "gpt-5.6-sol" }, model), {
    model: "gpt-5.6-sol",
    tool_choice: { type: "function", name: "browser_result" },
  });
});

test("Claude subscription browser requests fail without deriving or sending credentials", async () => {
  const built = buildApp(testConfig());
  await built.userModelCredentials.setOAuth("U1", "anthropic", {
    accessToken: "claude-subscription",
    expiresAt: Date.now() + 3600_000,
  });
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const selection = await resolveBrowserModel({
    actorId: "U1",
    config: built.config,
    credentials: built.userModelCredentials,
  });
  await assert.rejects(
    nativeBrowserCompletion(
      {
        selection,
        credentials: {
          ...built.userModelCredentials,
          derivedOAuth: async () => {
            throw new Error("must not derive");
          },
        },
        actorId: "U1",
        body: {},
        signal: new AbortController().signal,
      },
      async () => {
        throw new Error("must not call provider");
      },
    ),
    (error: unknown) => error instanceof BrowserCompletionError && error.status === 422,
  );
});

test("personal API keys bypass organization provider endpoint overrides", async (t) => {
  const built = buildApp(testConfig());
  setProviderBaseUrls({ openai: "https://organization.invalid/v1", anthropic: "https://organization.invalid" });
  t.after(() => setProviderBaseUrls({}));
  for (const provider of ["openai", "anthropic"] as const) {
    await built.userModelCredentials.setApiKey("U1", provider, `personal-${provider}`);
    await built.config.setPersonalModelAuth("U1", true, provider);
    const selection = await resolveBrowserModel({
      actorId: "U1",
      config: built.config,
      credentials: built.userModelCredentials,
      companyModel: "gateway/unavailable-company-model",
    });
    assert.equal(selection.routing?.provider, provider);
    const result = await nativeBrowserCompletion(
      {
        selection,
        actorId: "U1",
        credentials: built.userModelCredentials,
        body: { messages: [{ role: "user", content: "browser test" }] },
        signal: new AbortController().signal,
      },
      async (keys) => {
        assert.deepEqual(keys, { [provider]: `personal-${provider}` });
        return {
          completeSimple: async (model) => {
            assert.ok(!model.baseUrl.includes("organization.invalid"));
            return {
              role: "assistant",
              api: model.api,
              provider: model.provider,
              model: model.id,
              content: [{ type: "text", text: "done" }],
              usage: zeroUsage(),
              timestamp: Date.now(),
              stopReason: "stop",
            };
          },
        };
      },
    );
    assert.equal(result.choices[0]?.message.content, "done");
  }
});

test("company Codex subscription auth uses the native subscription transport without API-key fallback", async () => {
  const built = buildApp(
    testConfig({
      harness: "codex",
      codexProcessEnv: { CODEX_ACCESS_TOKEN: "company-access" },
      openaiApiKey: "must-not-fallback",
    }),
  );
  const selection = { account: "company" as const, model: "gpt-5.6-sol", routing: null };
  const keys = await built.resolveBrowserCompanyKeys();
  assert.equal(keys["openai-codex"], "company-access");
  assert.equal((await built.resolveBrowserCompanyKeys(false))["openai-codex"], undefined);
  const input = {
    selection,
    actorId: "U1",
    companyProviderKeys: keys,
    companySubscriptionProvider: "openai" as const,
    body: { messages: [{ role: "user", content: "test" }] },
    signal: new AbortController().signal,
  };
  const result = await nativeBrowserCompletion(input, async (auth) => {
    assert.deepEqual(auth, { "openai-codex": "company-access" });
    return {
      completeSimple: async (model) => {
        assert.equal(model.provider, "openai-codex");
        return {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: zeroUsage(),
          timestamp: Date.now(),
          stopReason: "stop",
          content: [{ type: "text", text: "done" }],
        };
      },
    };
  });
  assert.equal(result.choices[0]?.message.content, "done");
  await assert.rejects(
    nativeBrowserCompletion({ ...input, companyProviderKeys: { openai: "must-not-fallback" } }),
    (error: unknown) => error instanceof BrowserCompletionError && error.status === 503,
  );
  await assert.rejects(
    nativeBrowserCompletion({
      ...input,
      selection: { ...selection, model: "claude-opus-5" },
      companySubscriptionProvider: "anthropic",
    }),
    (error: unknown) => error instanceof BrowserCompletionError && error.status === 422,
  );
});
