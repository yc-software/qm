import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
const bundle = buildSync({
  entryPoints: [new URL("../ui/settings-memory.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "memoryCard",
  platform: "browser",
}).outputFiles[0].text;
const gateway = { kind: "embedding", id: "gateway/embed-large", name: "embed-large", provider: "qm:gateway" };
const direct = { kind: "embedding", id: "text-embedding-3-small", name: "Small", provider: "openai" };
function fixture(registered: any[] = []) {
  const dom = new JSDOM('<template data-settings-card="card-memory-recall"></template>', {
    runScripts: "outside-only",
  });
  dom.window.eval(bundle + ";window.memoryCard = memoryCard;");
  const ui = (dom.window as any).memoryCard;
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  ui.configureMemory({
    api: async (method: string, path: string, body?: unknown) => {
      calls.push(JSON.parse(JSON.stringify({ method, path, body })));
      if (path === "/api/model-registry")
        return {
          ok: true,
          data: {
            embeddingModels: [gateway, ...registered],
            models: registered.map((spec) => ({ spec, verifiedAt: 1 })),
          },
        };
      if (path.startsWith("/api/model-providers?"))
        return { ok: true, data: { providers: [{ provider: "openai", configured: false, source: "absent" }] } };
      return { ok: true, data: { ok: true } };
    },
  });
  ui.mountMemory();
  const $ = (id: string) => dom.window.document.getElementById(id) as any;
  const type = (id: string, text: string) => {
    $(id).value = text;
    $(id).dispatchEvent(new dom.window.Event(id === "memory-embedding-model" ? "change" : "input"));
  };
  return { dom, ui, calls, $, type };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("explains recency when no embedding model is selected and lists gateway models", async () => {
  const { ui, $ } = fixture();
  await ui.loadMemory({ memoryEmbeddingModel: null }, "org:acme");
  assert.match($("memory-recall-mode").textContent, /Recency[\s\S]*No embedding model is selected/);
  const options = [...$("memory-embedding-model").options].map((o: any) => o.textContent.trim());
  assert.deepEqual(options, ["None (use newest facts)", "embed-large · model gateway"]);
  assert.match($("memory-openai-key-status").textContent, /not set/);
});

test("explains the recency fallback when the saved model is unavailable", async () => {
  const { ui, $ } = fixture();
  await ui.loadMemory({ memoryEmbeddingModel: "gateway/retired" }, "org:acme");
  assert.match($("memory-recall-mode").textContent, /Recency fallback[\s\S]*gateway\/retired is unavailable/);
  assert.equal($("memory-embedding-model").value, "gateway/retired");
});

test("selecting a model saves the org setting and reports relevance ranking", async () => {
  const { ui, $, type, calls } = fixture();
  await ui.loadMemory({ memoryEmbeddingModel: null }, "org:acme");
  type("memory-embedding-model", gateway.id);
  $("memory-embedding-save").click();
  await settle();
  await settle();
  assert.deepEqual(
    calls.find((call) => call.method === "PUT"),
    {
      method: "PUT",
      path: "/api/scopes/org%3Aacme/memory-embedding-model",
      body: { modelId: gateway.id },
    },
  );
  assert.match($("memory-recall-mode").textContent, /Relevance ranking[\s\S]*embed-large \(model gateway\)/);
  type("memory-embedding-model", "");
  $("memory-embedding-save").click();
  await settle();
  await settle();
  assert.deepEqual(calls.filter((call) => call.method === "PUT").at(-1)?.body, { modelId: null });
});

test("saves the OpenAI key and registers an embedding model through the existing admin APIs", async () => {
  const { ui, $, type, calls } = fixture([direct]);
  await ui.loadMemory({ memoryEmbeddingModel: direct.id }, "org:acme");
  assert.match($("memory-recall-mode").textContent, /Small \(OpenAI, organization key\)/);
  type("memory-openai-key", " sk-test ");
  $("memory-openai-key-save").click();
  await settle();
  await settle();
  type("memory-embedding-id", "text-embedding-3-large");
  type("memory-embedding-name", "Large");
  $("memory-embedding-register").click();
  await settle();
  await settle();
  assert.deepEqual(
    calls.filter((call) => call.method === "PUT"),
    [
      { method: "PUT", path: "/api/model-providers/openai", body: { apiKey: "sk-test" } },
      {
        method: "PUT",
        path: "/api/model-registry/text-embedding-3-large",
        body: { kind: "embedding", name: "Large", provider: "openai", verify: true },
      },
    ],
  );
  assert.match($("st-memory-recall").textContent, /Large verified/);
});
