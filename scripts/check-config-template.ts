import { readFileSync } from "node:fs";
import { CORE_ENV_NAMES } from "../cli/src/target-env-defaults.ts";

function configEnvNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/\benv\??\.([A-Z][A-Z0-9_]+)\b/g)) names.add(m[1]!);
  for (const m of source.matchAll(/\benv\[\s*"([A-Z][A-Z0-9_]+)"\s*\]/g)) names.add(m[1]!);
  for (const m of source.matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{3,})"/g)) names.add(m[1]!);
  return names;
}

const read = configEnvNames(readFileSync(new URL("../src/config.ts", import.meta.url), "utf8"));
const template = new Set(CORE_ENV_NAMES);
const missing = [...read].filter((name) => !template.has(name)).sort();
const stale = [...template].filter((name) => !read.has(name)).sort();
if (missing.length || stale.length) {
  if (missing.length)
    console.error(`src/config.ts reads names missing from cli/src/target-env-defaults.ts: ${missing.join(", ")}`);
  if (stale.length)
    console.error(`cli/src/target-env-defaults.ts lists names src/config.ts no longer reads: ${stale.join(", ")}`);
  process.exit(1);
}
console.log(`config template covers all ${read.size} names src/config.ts reads`);
