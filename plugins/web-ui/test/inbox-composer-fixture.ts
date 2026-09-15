import { metadata } from "./model-metadata.ts";
export const inboxRuntime = {
  modelCatalog: {
    "gpt-5.6-sol": metadata("gpt-5.6-sol", "GPT-5.6 Sol"),
    "gpt-5.6-terra": metadata("gpt-5.6-terra", "GPT-5.6 Terra"),
  },
  approvedHarnesses: ["pi"],
  modelsByHarness: { pi: ["gpt-5.6-sol", "gpt-5.6-terra"] },
  orgDefault: { harnessId: "pi", modelId: "gpt-5.6-sol", revision: 0 },
  effective: { harnessId: "pi", modelId: "gpt-5.6-sol", effortLevel: "medium", fastMode: false },
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
