import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PluginSecret, QmConfig } from "./config.ts";
import { pluginNameError } from "./services.ts";

export interface ResolvedPlugin {
  name: string;
  kind: "source" | "image";
  image?: string;
  sourceDir?: string;
  dockerfile?: string;
  env: Record<string, string>;
  secrets?: PluginSecret[];
}

const subdirs = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
};

export function discoverPlugins(configDir: string, config: QmConfig): { plugins: ResolvedPlugin[]; errors: string[] } {
  const pluginsRoot = join(configDir, "plugins");
  const sourceDirs = new Set(subdirs(pluginsRoot).filter((d) => existsSync(join(pluginsRoot, d, "Dockerfile"))));
  const byName = new Map(config.plugins.map((p) => [p.name, p]));

  const names = [...new Set([...sourceDirs, ...byName.keys()])].sort();
  const plugins: ResolvedPlugin[] = [];
  const errors: string[] = [];

  for (const name of names) {
    const entry = byName.get(name);
    const image = entry?.image;
    const env = entry?.env ?? {};
    const secrets = entry?.secrets ?? [];
    const hasDockerfile = sourceDirs.has(name);
    const dir = join(pluginsRoot, name);

    const nameError = pluginNameError(name);
    if (nameError) {
      errors.push(`plugin "${name}" ${nameError}`);
      continue;
    }
    if (image && hasDockerfile) {
      errors.push(`plugin "${name}" is both a source folder (plugins/${name}/Dockerfile) and an image — pick one`);
      continue;
    }
    if (image) {
      plugins.push({ name, kind: "image", image, env, secrets });
      continue;
    }
    if (hasDockerfile) {
      plugins.push({
        name,
        kind: "source",
        sourceDir: dir,
        dockerfile: join(dir, "Dockerfile"),
        env,
        secrets,
      });
      continue;
    }
    if (existsSync(dir)) {
      errors.push(`plugin "${name}" has a plugins/${name}/ folder but no Dockerfile, and no image is configured`);
    } else {
      errors.push(`plugin "${name}" names neither an image nor a plugins/${name}/ source folder`);
    }
  }

  return { plugins, errors };
}
