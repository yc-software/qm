import type { DeployService, DeploymentSource, SourceEdit, SourceSaved } from "../deploy/deploy-service.ts";
import type { ScopeId } from "../types.ts";

export interface AppFiles {
  readonly app: string;
  sourceReader(): Promise<AppFiles["source"] | undefined>;
  source(paths?: string[], at?: string | Pick<DeploymentSource, "commit" | "tree">): Promise<DeploymentSource>;
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
  const canManage = () =>
    deploy.canManageDeployment(app, { actorId: deps.actorId, botActor: deps.botActor }, deps.actingScopeId);
  const assertMayEdit = async (): Promise<void> => {
    if (!(await canManage()))
      throw new Error(`you need write access to the app ${JSON.stringify(app)} to read or change its files`);
  };
  const source: AppFiles["source"] = async (paths, at) => {
    const saved = await deploy.source(app, paths, at);
    if (!saved) throw new Error(`${app} has no saved source; publish it again first`);
    return saved;
  };
  return {
    app,
    async sourceReader() {
      return (await canManage()) ? source : undefined;
    },
    async source(paths, at) {
      await assertMayEdit();
      return source(paths, at);
    },
    async save(edit) {
      await assertMayEdit();
      return deploy.editSource(app, deps.actorId, edit);
    },
  };
}
