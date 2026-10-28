import type { StoresModule } from "./stores.ts";
import type { Head } from "./late.ts";
import { loadDeploymentLayer, emptyDeploymentLayer, type DeploymentLayerRuntime } from "../deployment/load-layer.ts";
import { resolve } from "node:path";
import { perTenant, tenant } from "../tenant.ts";
import { createPostgresAuditLog } from "../admin/postgres-audit-log.ts";
import {
  createDeploymentLayerStore,
  LAYER_CREATED_BY,
  LAYER_REVIEWER,
  type DeploymentLayerStore,
} from "../deployment/deployment-layer-store.ts";
import { installSeedSkills } from "../skills/seed.ts";
import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { reportFailureAs } from "../util/errors.ts";

type DeploymentLayerInputs = Pick<Head, "config"> & { stores: StoresModule };

export function buildDeploymentLayer(deps: DeploymentLayerInputs) {
  const { config } = deps;
  const { databaseUrl, skills, skillBundles, advisoryLock } = deps.stores;

  const deploymentLayer = tenantDeploymentLayer(
    config.deploymentLayerDir ? loadDeploymentLayer(config.deploymentLayerDir) : emptyDeploymentLayer(),
  );
  const layerSkillsDir = config.deploymentLayerDir ? resolve(deploymentLayer.dir, "skills") : undefined;
  const brokeredTools = deploymentLayer.brokeredTools;
  const auditLog = createPostgresAuditLog(databaseUrl);
  const layerStore = createDeploymentLayerStore({
    databaseUrl,
    runtime: deploymentLayer,
    skills,
    skillBundles,
    advisoryLock,
    auditPersisted: (record) => {
      const { orgScope } = tenant();
      return auditLog.recordOnce!(`deployment-layer:${orgScope}:${record.version}`, {
        at: record.updatedAt,
        principalId: record.updatedBy,
        action: "deployment_layer.updated",
        resource: record.contentHash,
        scopeLabel: orgScope,
      });
    },
    ...(config.seedSkills && layerSkillsDir
      ? {
          seedFallback: () =>
            installSeedSkills(skills, {
              dir: layerSkillsDir,
              scopeId: tenant().orgScope,
              createdBy: LAYER_CREATED_BY,
              reviewer: LAYER_REVIEWER,
            }),
        }
      : {}),
  });
  const deploymentLayerChanged = createPostgresNotifyBus<null>(databaseUrl, "deployment_layer", "deployment layer");
  const deploymentLayerStore: DeploymentLayerStore = {
    ...layerStore,
    put: (bundle, by) => layerStore.put(bundle, by).finally(() => deploymentLayerChanged.emit(null)),
  };
  const rehydrateLayer = () => void layerStore.hydrate().catch(reportFailureAs("deployment layer refresh", undefined));
  deploymentLayerChanged.subscribe(rehydrateLayer, { onResync: rehydrateLayer });
  const installCatalogs = async (): Promise<void> => {
    const { orgScope } = tenant();
    await installSeedSkills(skills, { dir: resolve("./skills-seed"), scopeId: orgScope, respectArchived: true });
    for (const dir of config.pluginSkillDirs) {
      if (layerSkillsDir && resolve(dir) === layerSkillsDir) continue;
      await installSeedSkills(skills, {
        dir,
        scopeId: orgScope,
        createdBy: "system:plugin-skills",
        reviewer: "system:plugin-skills-reviewer",
        respectArchived: true,
      });
    }
  };
  return { deploymentLayerStore, installCatalogs, deploymentLayer, auditLog, brokeredTools, deploymentLayerChanged };
}

export type DeploymentLayerModule = ReturnType<typeof buildDeploymentLayer>;

type LayerList = Exclude<keyof DeploymentLayerRuntime, "dir">;
const LAYER_LISTS: LayerList[] = [
  "tools",
  "advertisedTools",
  "hints",
  "credentialPaths",
  "splitEnvTemplates",
  "brokeredTools",
  "commandRules",
  "installFiles",
];

function tenantDeploymentLayer(base: DeploymentLayerRuntime): DeploymentLayerRuntime {
  const layers = perTenant((): DeploymentLayerRuntime => ({
    ...base,
    ...Object.fromEntries(LAYER_LISTS.map((key) => [key, [...base[key]]])),
  }));
  const list = (key: LayerList) =>
    new Proxy([], {
      get: (_target, property) => Reflect.get(layers()[key], property),
      set: (_target, property, value) => Reflect.set(layers()[key], property, value),
      deleteProperty: (_target, property) => Reflect.deleteProperty(layers()[key], property),
      has: (_target, property) => Reflect.has(layers()[key], property),
    });
  const view = Object.fromEntries(LAYER_LISTS.map((key) => [key, list(key)])) as unknown as Omit<
    DeploymentLayerRuntime,
    "dir"
  >;
  return {
    ...view,
    get dir() {
      return layers().dir;
    },
    set dir(dir: string) {
      layers().dir = dir;
    },
  };
}
