import { build } from "esbuild";
import { mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL(".", import.meta.url));
const output = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL("../../.generated/connector-sdk/", import.meta.url));
const result = await build({
  stdin: { contents: 'export { Composio } from "@composio/core";', resolveDir: root },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: true,
  legalComments: "none",
  write: false,
});
const data = result.outputFiles[0].contents;
const sha = createHash("sha256").update(data).digest("hex");
await mkdir(output, { recursive: true });
await writeFile(`${output}/sdk.cjs`, data);
await writeFile(`${output}/sha256`, `${sha}\n`);
console.log(`Connector SDK: ${data.length} bytes, sha256 ${sha}`);

const lock = JSON.parse(await readFile(`${root}/package-lock.json`, "utf8"));
const licenses = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || entry.dev || entry.devOptional) continue;
  const names = await readdir(`${root}/${path}`);
  for (const name of names.filter((name) => /^licen[sc]e(?:\.|$)/i.test(name))) {
    licenses.push(`${path}@${entry.version}\n${await readFile(`${root}/${path}/${name}`, "utf8")}`);
  }
}
await writeFile(`${output}/LICENSES.txt`, licenses.join("\n\n"));
