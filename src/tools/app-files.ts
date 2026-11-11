import type { DeployService, DeploymentSource, SourceEdit, SourceSaved } from "../deploy/deploy-service.ts";
import type { ScopeId } from "../types.ts";

export interface AppFiles {
  readonly app: string;
  source(paths?: string[], commit?: string): Promise<DeploymentSource>;
  save(edit: (read: (paths: string[]) => Promise<DeploymentSource>) => Promise<SourceEdit>): Promise<SourceSaved>;
}

export function createAppFiles(deps: {
  deploy: DeployService;
  app: string;
  actorId: string;
  botActor?: boolean;
  actingScopeId: ScopeId;
}): AppFiles {
  const { deploy, app } = deps;
  const assertMayEdit = async (): Promise<void> => {
    const caller = { actorId: deps.actorId, botActor: deps.botActor };
    if (!(await deploy.canManageDeployment(app, caller, deps.actingScopeId)))
      throw new Error(`you need write access to the app ${JSON.stringify(app)} to read or change its files`);
  };
  return {
    app,
    async source(paths, commit) {
      await assertMayEdit();
      const source = await deploy.source(app, paths, commit);
      if (!source) throw new Error(`${app} has no saved source; publish it again first`);
      return source;
    },
    async save(edit) {
      await assertMayEdit();
      return deploy.editSource(app, deps.actorId, edit);
    },
  };
}
