import type { DurableMap } from "../persistence/durable-map.ts";
import type { Deployment } from "./deploy-store.ts";
import type { StoredRenderDeploy } from "./render-deploy-provider.ts";
import { list, RenderApiError, type RenderApi } from "./render-api.ts";

interface Environment {
  id: string;
  name: string;
  projectId: string;
  networkIsolationEnabled: boolean;
}

export function createRenderAppNetwork(opts: {
  api: RenderApi;
  workspaceId: string;
  projectId: string;
  store: DurableMap<StoredRenderDeploy>;
  name(deployment: Deployment): string;
}) {
  const { api } = opts;
  function check(deployment: Deployment, environment: Environment | null | undefined): Environment {
    if (
      !environment ||
      environment.projectId !== opts.projectId ||
      !environment.networkIsolationEnabled ||
      environment.name !== opts.name(deployment)
    )
      throw new Error("Render app environment ownership or network isolation changed");
    return environment;
  }
  const assertEnvironment = async (deployment: Deployment, environmentId: string | undefined): Promise<Environment> => {
    if (!environmentId) throw new Error("The Render app has no retained isolated environment");
    return check(
      deployment,
      await api.request<Environment>("GET", `/environments/${encodeURIComponent(environmentId)}`),
    );
  };
  async function named(deployment: Deployment): Promise<Environment | undefined> {
    const name = opts.name(deployment);
    const found = await list<Environment>(api, "/environments", "environment", { projectId: opts.projectId, name });
    const matches = found.filter((env) => env.name === name && env.projectId === opts.projectId);
    return matches.sort((a, b) => a.id.localeCompare(b.id))[0];
  }
  return {
    assertEnvironment,
    async ensure(deployment: Deployment, initial: StoredRenderDeploy): Promise<StoredRenderDeploy> {
      if (initial.environmentId) {
        await assertEnvironment(deployment, initial.environmentId);
        return initial;
      }
      const project = await api.request<{ owner: { id: string } }>("GET", `/projects/${opts.projectId}`);
      if (project?.owner.id !== opts.workspaceId) throw new Error("Render project belongs to another workspace");
      let environment = await named(deployment);
      if (!environment) {
        try {
          const created = await api.request<Environment>("POST", "/environments", {
            name: opts.name(deployment),
            projectId: opts.projectId,
            networkIsolationEnabled: true,
            protectedStatus: "protected",
          });
          environment = (await named(deployment)) ?? created ?? undefined;
        } catch (error) {
          if (!(error instanceof RenderApiError && error.rejected)) throw error;
          environment = await named(deployment);
          if (!environment) throw error;
        }
      }
      if (environment && !environment.networkIsolationEnabled)
        throw new Error(
          "A Render environment with this app's name is not network-isolated; enable isolation or delete it",
        );
      const record = { ...initial, environmentId: check(deployment, environment).id };
      await opts.store.put(record.deploymentId, record);
      return record;
    },
  };
}
