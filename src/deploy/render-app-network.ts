import type { DurableMap } from "../persistence/durable-map.ts";
import type { PublishedApp } from "./deploy-store.ts";
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
  name(publishedApp: PublishedApp): string;
}) {
  const { api } = opts;
  function check(publishedApp: PublishedApp, environment: Environment | null | undefined): Environment {
    if (
      !environment ||
      environment.projectId !== opts.projectId ||
      !environment.networkIsolationEnabled ||
      environment.name !== opts.name(publishedApp)
    )
      throw new Error("Render app environment ownership or network isolation changed");
    return environment;
  }
  const assertEnvironment = async (
    publishedApp: PublishedApp,
    environmentId: string | undefined,
  ): Promise<Environment> => {
    if (!environmentId) throw new Error("The Render app has no retained isolated environment");
    return check(
      publishedApp,
      await api.request<Environment>("GET", `/environments/${encodeURIComponent(environmentId)}`),
    );
  };
  async function named(publishedApp: PublishedApp): Promise<Environment | undefined> {
    const name = opts.name(publishedApp);
    const found = await list<Environment>(api, "/environments", "environment", { projectId: opts.projectId, name });
    const matches = found.filter((env) => env.name === name && env.projectId === opts.projectId);
    return matches.sort((a, b) => a.id.localeCompare(b.id))[0];
  }
  return {
    assertEnvironment,
    async ensure(publishedApp: PublishedApp, initial: StoredRenderDeploy): Promise<StoredRenderDeploy> {
      if (initial.environmentId) {
        await assertEnvironment(publishedApp, initial.environmentId);
        return initial;
      }
      const project = await api.request<{ owner: { id: string } }>("GET", `/projects/${opts.projectId}`);
      if (project?.owner.id !== opts.workspaceId) throw new Error("Render project belongs to another workspace");
      let environment = await named(publishedApp);
      if (!environment) {
        try {
          const created = await api.request<Environment>("POST", "/environments", {
            name: opts.name(publishedApp),
            projectId: opts.projectId,
            networkIsolationEnabled: true,
            protectedStatus: "protected",
          });
          environment = (await named(publishedApp)) ?? created ?? undefined;
        } catch (error) {
          if (!(error instanceof RenderApiError && error.rejected)) throw error;
          environment = await named(publishedApp);
          if (!environment) throw error;
        }
      }
      if (environment && !environment.networkIsolationEnabled)
        throw new Error(
          "A Render environment with this app's name is not network-isolated; enable isolation or delete it",
        );
      const record = { ...initial, environmentId: check(publishedApp, environment).id };
      await opts.store.put(record.deploymentId, record);
      return record;
    },
  };
}
