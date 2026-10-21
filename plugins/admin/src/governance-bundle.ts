import { build } from "esbuild";
import emojiSource from "emoji-datasource/emoji.json" with { type: "json" };
import { fileURLToPath } from "node:url";
import { emojiTableModule } from "../../web-ui/src/emoji-source.ts";

const EMOJI_TABLE = fileURLToPath(new URL("../../web-ui/src/emoji-table.ts", import.meta.url));

export async function buildGovernanceUI(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../ui/admin.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "governanceUI",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    plugins: [
      {
        name: "emoji-table",
        setup(build) {
          build.onLoad({ filter: /emoji-table\.ts$/ }, ({ path }) =>
            path === EMOJI_TABLE ? { contents: emojiTableModule(emojiSource), loader: "js" } : undefined,
          );
        },
      },
    ],
    alias: Object.fromEntries(
      ["lit", "lucide"].map((name) => [name, fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url))]),
    ),
  });
  return result.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
}
