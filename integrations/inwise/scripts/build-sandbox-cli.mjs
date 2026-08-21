import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "dist", "qm", "inwise");

await mkdir(dirname(output), { recursive: true });
await build({
  entryPoints: [resolve(root, "cli", "index.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  minify: true,
  legalComments: "none",
});
await chmod(output, 0o755);
console.log(`Built QM sandbox CLI: ${output}`);
