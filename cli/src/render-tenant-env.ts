import { envVars, type RenderRequest } from "./render-api.ts";
import { isTenantImport, isTenantSetting } from "./tenant-setting-names.ts";
import type { DeployedTenantEnv } from "./tenant-settings.ts";

const PRECEDENCE = ["core", "portal", "auth"];

export function tenantEnvIn(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => isTenantSetting(name)));
}

function rank(name: string): number {
  const index = PRECEDENCE.indexOf(name);
  return index < 0 ? PRECEDENCE.length : index;
}

export async function renderDeployedTenantEnv(
  request: RenderRequest,
  services: Readonly<Record<string, { id: string }>>,
): Promise<DeployedTenantEnv> {
  const names = Object.keys(services)
    .filter((name) => name !== "minio")
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const found: Array<{ id: string; keys: string[] }> = [];
  const values: Record<string, string> = {};
  for (const name of names) {
    const id = services[name]!.id;
    const env = await envVars(request, id);
    const keys = Object.keys(env).filter(isTenantSetting).sort();
    if (keys.length) found.push({ id, keys });
    for (const [key, value] of Object.entries(env))
      if (isTenantImport(key) && value.trim() && values[key] === undefined) values[key] = value;
  }
  return {
    values,
    remove: async () => {
      for (const { id, keys } of found)
        for (const key of keys) await request(`/services/${id}/env-vars/${encodeURIComponent(key)}`, "DELETE");
      return [...new Set(found.flatMap(({ keys }) => keys))].sort();
    },
  };
}
