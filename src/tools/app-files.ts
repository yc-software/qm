import type { AppSourceReader, DeployService, AppSource, SourceEdit, SourceSaved } from "../deploy/deploy-service.ts";
import type { ScopeId } from "../types.ts";

export interface AppFiles {
  readonly app: string;
  sourceReader(): Promise<AppSourceReader | undefined>;
  source(paths?: string[], commit?: string): Promise<AppSource>;
  save(edit: (read: (paths: string[]) => Promise<AppSource>) => Promise<SourceEdit>): Promise<SourceSaved>;
}

export function createAppFiles(deps: {
  deploy: DeployService;
  app: string;
  actorId: string;
  botActor?: boolean;
  actingScopeId: ScopeId;
}): AppFiles {
  const { deploy, app } = deps;
  const caller = { actorId: deps.actorId, botActor: deps.botActor };
  const canManage = () => deploy.canManageApp(app, caller, deps.actingScopeId);
  const assertMayEdit = async (): Promise<void> => {
    if (!(await canManage()))
      throw new Error(`you need write access to the app ${JSON.stringify(app)} to read or change its files`);
  };
  const source: AppFiles["source"] = async (paths, commit) => {
    const saved = await deploy.source(app, paths, commit);
    if (!saved) throw new Error(`${app} has no saved source; publish it again first`);
    return saved;
  };
  return {
    app,
    async sourceReader() {
      return (await deploy.sourceReader(app, caller, deps.actingScopeId)) ?? undefined;
    },
    async source(paths, commit) {
      await assertMayEdit();
      return source(paths, commit);
    },
    async save(edit) {
      await assertMayEdit();
      return deploy.editSource(app, deps.actorId, edit);
    },
  };
}
