import { JSDOM } from "jsdom";
import { buildGovernanceUI } from "../src/governance-bundle.ts";

export function litFixture() {
  const dom = new JSDOM('<!doctype html><body><main id="root"></main></body>', {
    runScripts: "outside-only",
    url: "http://localhost/admin",
  });
  dom.window.structuredClone = structuredClone;
  dom.window.eval(buildGovernanceUI() + ";window.ui = governanceUI;");
  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    root: dom.window.document.getElementById("root")!,
    ui: (dom.window as any).ui,
  };
}
