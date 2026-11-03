import { resolve } from "node:path";
import type { ScopeId } from "./types.ts";
import type { SkillStore } from "./skills/skill-store.ts";
import { installSeedSkills } from "./skills/seed.ts";
import { errMessage } from "./util/errors.ts";

const BLOB_TRANSFER_EXPIRY_DAYS = 1;

interface StartupWorkDeps {
  blobTransfer: { ensureExpiry?(maxAgeDays: number): Promise<boolean> };
  listen: () => () => void;
}

interface Startup {
  begin(): void;
  stop(): void;
}

export function createStartup(deps: StartupWorkDeps): Startup {
  let unlisten: (() => void) | undefined;
  return {
    begin() {
      if (unlisten) return;
      unlisten = deps.listen();
      void deps.blobTransfer
        .ensureExpiry?.(BLOB_TRANSFER_EXPIRY_DAYS)
        .catch((e) =>
          console.error(
            "[blob-transfer] S3 lifecycle expiry install failed (sweep remains the fallback):",
            errMessage(e),
          ),
        );
    },
    stop: () => unlisten?.(),
  };
}

export function seedCatalogs(
  skills: SkillStore,
  opts: { seedDir: string; pluginDirs: readonly string[]; layerSkillsDir?: string; scopeId: ScopeId },
): () => Promise<void> {
  return async () => {
    await installSeedSkills(skills, { dir: opts.seedDir, scopeId: opts.scopeId, respectArchived: true });
    for (const dir of opts.pluginDirs) {
      if (opts.layerSkillsDir && resolve(dir) === opts.layerSkillsDir) continue;
      await installSeedSkills(skills, {
        dir,
        scopeId: opts.scopeId,
        createdBy: "system:plugin-skills",
        reviewer: "system:plugin-skills-reviewer",
        respectArchived: true,
      });
    }
  };
}

export function brokerCredentialCheck(
  store: { listServiceCredentials(scope: ScopeId): Promise<readonly { slug: string }[]> },
  scope: ScopeId,
  slugs: readonly string[],
): () => Promise<void> {
  const reserved = new Set(slugs);
  return () =>
    store.listServiceCredentials(scope).then(
      (stored) => {
        const shadowed = stored.filter((c) => reserved.has(c.slug)).map((c) => c.slug);
        if (shadowed.length)
          console.warn(`[broker-credentials] BROKER_CREDENTIALS overrides stored credentials: ${shadowed.join(", ")}`);
      },
      (error) =>
        console.warn(`[broker-credentials] could not check for overridden stored credentials: ${errMessage(error)}`),
    );
}
