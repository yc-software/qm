import type { ConstructorOptions } from "jsdom";
import type { PluginOption } from "vite";
import { browserEnv } from "./browser-env.ts";
import { metadata } from "./model-metadata.ts";
export const inboxRuntime = {
  scopeId: "personal:taylor@example.com",
  modelCatalog: {
    "gpt-5.6-sol": metadata("gpt-5.6-sol", "GPT-5.6 Sol"),
    "gpt-5.6-terra": metadata("gpt-5.6-terra", "GPT-5.6 Terra"),
  },
  models: ["gpt-5.6-sol", "gpt-5.6-terra"],
  orgDefault: { modelId: "gpt-5.6-sol", revision: 0 },
  effective: { modelId: "gpt-5.6-sol", effortLevel: "medium", fastMode: false },
  fastModeModelIds: ["gpt-5.6-sol", "gpt-5.6-terra"],
  scopeOverride: null,
};

export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("composer did not settle");
}

export async function createInboxFixture(options: { dom?: ConstructorOptions; plugins?: PluginOption[] } = {}) {
  const env = await browserEnv({ dom: { pretendToBeVisual: false, ...options.dom }, plugins: options.plugins });
  const host = env.dom.window.document.getElementById("main")!;
  const close = async () => {
    try {
      const { render } = await env.vite.ssrLoadModule("lit");
      render(null, host);
    } finally {
      await env.close();
    }
  };
  return { dom: env.dom, vite: env.vite, host, close };
}
