import { readFileSync } from "node:fs";
import type { DeployFile } from "../deploy/deploy-service.ts";

export function starterFiles(kind: "org" | "personal"): DeployFile[] {
  return ["index.html", "org-design.css", "server.mjs", "DESIGN.md", "gallery.js"].map((path) => {
    let data = readFileSync(new URL(`./starter/${path}`, import.meta.url), "utf8");
    if (path === "index.html")
      data = data.replaceAll(
        "Organization design system",
        kind === "org" ? "Organization design system" : "My design customizations",
      );
    if (path === "DESIGN.md" && kind === "personal")
      data =
        "# Personal design customizations\n\nInherit the organization design system. No overrides yet. Add only the differences you want here, with supporting examples and assets in this app. The starter gallery is illustrative, not an override of the organization.\n";
    return { path, data };
  });
}
