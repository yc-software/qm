import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

export function buildGovernanceUI(): string {
  const result = buildSync({
    entryPoints: [fileURLToPath(new URL("../ui/admin.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "governanceUI",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    nodePaths: [fileURLToPath(new URL("../node_modules", import.meta.url))],
  });
  return result.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
}
