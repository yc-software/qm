import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
const bundle = buildSync({
  entryPoints: [new URL("../ui/settings.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "settingsUI",
  platform: "browser",
}).outputFiles[0]!.text;
const gateway = { kind: "embedding", id: "gateway/embed-large", name: "embed-large", provider: "qm:gateway" };
const direct = { kind: "embedding", id: "text-embedding-3-small", name: "Small", provider: "openai" };
function setup(memoryEmbeddingModel: string | null) {
  const dom = new JSDOM(readFileSync(new URL("../public/index.html", import.meta.url), "utf8"), {
    runScripts: "outside-only",
  });
  dom.window.structuredClone = structuredClone;
  dom.window.eval(bundle + "; window.settingsUI=settingsUI; settingsUI.mountCards();");
  const data = { memoryEmbeddingModel, memoryEmbeddingOptions: [gateway, direct] };
  dom.window.eval(`settingsUI.load(${JSON.stringify(data)}, "org:test", "memory-embedding-model")`);
  const $ = (id: string) => dom.window.document.getElementById(id) as HTMLSelectElement;
  return { dom, $, mode: () => $("memory-recall-mode").textContent!.replace(/\s+/g, " ") };
}

test("memory recall explains recency until an embedding model is saved", () => {
  const { dom, $, mode } = setup(null);
  try {
    assert.match(mode(), /Recency\. No embedding model is selected/);
    assert.deepEqual(
      [...$("memory-embedding-model").options].map((o) => o.textContent),
      ["None (use newest facts)", "embed-large · model gateway", "Small · OpenAI, organization key"],
    );
    $("memory-embedding-model").value = gateway.id;
    $("memory-embedding-model").dispatchEvent(new dom.window.Event("change"));
    assert.deepEqual(
      dom.window.eval('JSON.stringify(settingsUI.collect("memory-embedding-model"))'),
      '{"modelId":"gateway/embed-large"}',
    );
    assert.match(mode(), /Recency\./);
    dom.window.eval('settingsUI.commit("memory-embedding-model", { modelId: "gateway/embed-large" })');
    assert.match(mode(), /Relevance ranking\. embed-large \(model gateway\)/);
    $("memory-embedding-model").value = "";
    $("memory-embedding-model").dispatchEvent(new dom.window.Event("change"));
    assert.equal(dom.window.eval('JSON.stringify(settingsUI.collect("memory-embedding-model"))'), '{"modelId":null}');
  } finally {
    dom.window.close();
  }
});

test("memory recall names an unavailable saved model and falls back to recency", () => {
  const { dom, $, mode } = setup("gateway/retired");
  try {
    assert.match(mode(), /Recency fallback\. gateway\/retired is unavailable/);
    assert.equal($("memory-embedding-model").value, "gateway/retired");
    assert.equal($("memory-embedding-model").selectedOptions[0]!.textContent, "gateway/retired (unavailable)");
  } finally {
    dom.window.close();
  }
});
