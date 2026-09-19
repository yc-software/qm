import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { buildGovernanceUI } from "../src/governance-bundle.ts";

export function readAdminSource(): string {
  const shell = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(shell, { runScripts: "outside-only" });
  dom.window.structuredClone = structuredClone;
  try {
    dom.window.eval(buildGovernanceUI() + ";window.governanceUI = governanceUI; governanceUI.mountCards();");
    return (
      shell
        .replace(/<template data-onboarding-ui="([^"]+)"><\/template>/g, (_, kind) => {
          const selectors: Record<string, string> = {
            steps: ".setup-grid",
            provider: "#onboarding-model-save",
            registry: "#model-registry-save",
          };
          const element = dom.window.document.querySelector(selectors[kind])!;
          return (kind === "steps" ? element : element.closest("section")!).outerHTML;
        })
        .replace(/<template data-(?:governance|settings|integrations)-card="([^"]+)"><\/template>/g, (_, id) => {
          const card = dom.window.document.getElementById(id)!;
          return card.outerHTML.replace(/class="\s+/g, 'class="').replace(/\s+" id=/g, '" id=');
        }) + dom.window.eval('governanceUI.createCard("card-governance-org-ambient").outerHTML')
    );
  } finally {
    dom.window.close();
  }
}
