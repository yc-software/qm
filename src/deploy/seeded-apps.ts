import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { personalScope } from "../types.ts";
import { DeployAccessError, type DeployFile, type DeployService, type SigningAppActor } from "./deploy-service.ts";
import type { PublishedApp } from "./deploy-store.ts";

const SEEDS_DIR = fileURLToPath(new URL("../../apps-seed/", import.meta.url));

interface SeedSpec {
  displayName: string;
  entrypoint: string;
  connectors: string[];
}

const SEEDS: Readonly<Record<string, SeedSpec>> = {
  calendar: { displayName: "Calendar", entrypoint: "node server.mjs", connectors: ["www.googleapis.com"] },
};

async function seedFiles(seed: string): Promise<DeployFile[]> {
  const root = join(SEEDS_DIR, seed);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const abs = join(entry.parentPath, entry.name);
        return { path: relative(root, abs).split(sep).join("/"), data: await readFile(abs) };
      }),
  );
}

function webUiOrigins(publicWebUrl: string | undefined): string[] {
  const url = publicWebUrl && URL.canParse(publicWebUrl) ? new URL(publicWebUrl) : null;
  return url?.protocol === "https:" ? [url.origin] : [];
}

export async function ensureSeededApp(
  deps: { deploy: DeployService; lock: AdvisoryLock; publicWebUrl?: string | undefined },
  person: string,
  seed: string,
  opts: { reset?: boolean; signOff: SigningAppActor["signOff"] },
): Promise<PublishedApp> {
  const spec = Object.hasOwn(SEEDS, seed) ? SEEDS[seed] : undefined;
  if (!spec) throw new DeployAccessError("not_found", `no seeded app named ${seed}`);
  return deps.lock.withLock(`seeded-app:${person.toLowerCase()}:${seed}`, async () => {
    const existing = await deps.deploy.seededApp(person, seed);
    if (existing?.connectors && !opts.reset) return existing;
    const lend = { createdBy: person, signOff: opts.signOff };
    if (existing && !opts.reset) return deps.deploy.setAppConnectors(existing.id, spec.connectors, lend);
    const version = { entrypoint: spec.entrypoint, files: await seedFiles(seed), stampEnv: { QM_APP_OWNER: person } };
    const id = existing
      ? (await deps.deploy.redeploy(existing.id, { ...version, actor: person })).id
      : (
          await deps.deploy.deploy({
            ...version,
            ownerScopeId: personalScope(person),
            createdBy: person,
            seed,
          })
        ).id;
    await deps.deploy.setAppDisplayName(id, spec.displayName);
    const origins = webUiOrigins(deps.publicWebUrl);
    if (origins.length) await deps.deploy.setAppEmbedAncestors(id, origins);
    return deps.deploy.setAppConnectors(id, spec.connectors, lend);
  });
}
