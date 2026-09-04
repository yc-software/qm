import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseProviderBaseUrl,
  providerBaseUrl,
  providerBaseUrlsFromEnv,
  setProviderBaseUrls,
} from "../src/model/provider-endpoints.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { loadConfig } from "../src/config.ts";

const BASE_ENV = { HARNESS: "mock" } as NodeJS.ProcessEnv;

afterEach(() => setProviderBaseUrls({}));

test("parseProviderBaseUrl normalizes trailing slashes and whitespace", () => {
  assert.equal(parseProviderBaseUrl("X", " https://gw.example.com/v1// "), "https://gw.example.com/v1");
});

test("parseProviderBaseUrl rejects bad values", () => {
  assert.throws(() => parseProviderBaseUrl("X", "not a url"));
  assert.throws(() => parseProviderBaseUrl("X", "ftp://gw.example.com"));
  assert.throws(() => parseProviderBaseUrl("X", "https://user:pw@gw.example.com"));
  assert.throws(() => parseProviderBaseUrl("X", "https://gw.example.com/?a=b"));
  assert.throws(() => parseProviderBaseUrl("X", "https://gw.example.com/#frag"));
});

test("providerBaseUrlsFromEnv reads the three provider variables", () => {
  const urls = providerBaseUrlsFromEnv({
    ANTHROPIC_BASE_URL: "https://a.example.com",
    OPENAI_BASE_URL: "https://o.example.com/v1/",
    OPENROUTER_BASE_URL: "  ",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(urls, { anthropic: "https://a.example.com", openai: "https://o.example.com/v1" });
});

test("providerBaseUrl answers only for configured, known providers", () => {
  setProviderBaseUrls({ anthropic: "https://a.example.com" });
  assert.equal(providerBaseUrl("anthropic"), "https://a.example.com");
  assert.equal(providerBaseUrl("openai"), undefined);
  assert.equal(providerBaseUrl("weird"), undefined);
});

test("resolveModel routes a built-in model through the override", () => {
  assert.equal(resolveModel("claude-opus-4-8")?.baseUrl, "https://api.anthropic.com");
  setProviderBaseUrls({ anthropic: "https://gw.example.com" });
  assert.equal(resolveModel("claude-opus-4-8")?.baseUrl, "https://gw.example.com");
  assert.equal(resolveModel("gpt-5.6-sol")?.baseUrl, "https://api.openai.com/v1");
});

test("a cloned model follows its template's override", () => {
  setProviderBaseUrls({ anthropic: "https://gw.example.com" });
  const clone = resolveModel("claude-opus-5");
  assert.equal(clone?.baseUrl, "https://gw.example.com");
  assert.equal(clone?.id, "claude-opus-5");
});

test("loadConfig parses provider base URLs and feeds the child harness envs", () => {
  const config = loadConfig({
    ...BASE_ENV,
    ANTHROPIC_BASE_URL: "https://a.example.com/",
    OPENAI_BASE_URL: "https://o.example.com/v1",
  });
  assert.deepEqual(config.providerBaseUrls, {
    anthropic: "https://a.example.com",
    openai: "https://o.example.com/v1",
  });
  assert.equal(config.claudeProcessEnv.ANTHROPIC_BASE_URL, "https://a.example.com");
  assert.equal(config.codexProcessEnv.OPENAI_BASE_URL, "https://o.example.com/v1");
});

test("loadConfig rejects an invalid provider base URL", () => {
  assert.throws(() => loadConfig({ ...BASE_ENV, OPENAI_BASE_URL: "nope" } as NodeJS.ProcessEnv));
});

test("loadConfig leaves child envs untouched when no override is set", () => {
  const config = loadConfig(BASE_ENV);
  assert.deepEqual(config.providerBaseUrls, {});
  assert.equal(config.claudeProcessEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(config.codexProcessEnv.OPENAI_BASE_URL, undefined);
});
