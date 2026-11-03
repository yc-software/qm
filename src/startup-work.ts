import { resolve } from "node:path";
import type { ScopeId } from "./types.ts";
import type { SkillStore } from "./skills/skill-store.ts";
import { installSeedSkills } from "./skills/seed.ts";
import { errMessage, reportFailureAs } from "./util/errors.ts";

const BLOB_TRANSFER_EXPIRY_DAYS = 1;

interface StartupWorkDeps {
  identity: { refresh(): Promise<unknown> };
  configStore: { hydrate?(): Promise<void> };
  deploymentLayer: { hydrate(): Promise<unknown> };
  mcp: { start(): void };
  blobTransfer: { ensureExpiry?(maxAgeDays: number): Promise<boolean> };
  listen: () => () => void;
  seedCatalogs?: () => Promise<void>;
  checkBrokerCredentials?: () => Promise<void>;
}

interface Startup {
  skills: Promise<void>;
  begin(): Promise<void>;
  stop(): void;
}

export function createStartup(deps: StartupWorkDeps): Startup {
  const skills = Promise.withResolvers<void>();
  let work: Promise<void> | undefined;
  let unlisten: (() => void) | undefined;
  const run = (): Promise<void> => {
    unlisten = deps.listen();
    void deps.identity.refresh().catch(reportFailureAs("startup: hydrate identity", undefined));
    void deps.configStore.hydrate?.().catch(reportFailureAs("startup: hydrate configuration", undefined));
    const deploymentLayer = deps.deploymentLayer.hydrate();
    deps.mcp.start();
    void deps.blobTransfer
      .ensureExpiry?.(BLOB_TRANSFER_EXPIRY_DAYS)
      .catch((e) =>
        console.error(
          "[blob-transfer] S3 lifecycle expiry install failed (sweep remains the fallback):",
          errMessage(e),
        ),
      );
    void deps.checkBrokerCredentials?.();
    const layerReady = deploymentLayer.then(
      () => undefined,
      (e) => console.error("[seed] deployment layer not ready:", errMessage(e)),
    );
    const seeded = deps
      .seedCatalogs?.()
      .catch((e) => console.error("[seed] failed to install seed skills:", errMessage(e)));
    const skillsSeeded = Promise.all([seeded, layerReady]).then(() => undefined);
    skills.resolve(skillsSeeded);
    return Promise.all([deploymentLayer, skillsSeeded]).then(() => undefined);
  };
  return {
    skills: skills.promise,
    begin: () => (work ??= run()),
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
