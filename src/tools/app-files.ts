import type { PrivateContext } from "../sessions/private-context.ts";
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
  context?: () => PrivateContext;
}): AppFiles {
  const { deploy, app } = deps;
  const caller = () => deps.context?.() ?? { actorId: deps.actorId, botActor: deps.botActor };
  const canManage = () => deploy.canManageApp(app, caller(), deps.actingScopeId);
  const assertMayEdit = async (): Promise<void> => {
    if (!(await canManage()))
      throw new Error(`you need write access to the app ${JSON.stringify(app)} to read or change its files`);
  };
  const source: AppFiles["source"] = async (paths, commit) => {
    const reader = await deploy.sourceReader(app, caller(), deps.actingScopeId);
    if (!reader) throw new Error(`${app} has no readable source in this conversation`);
    return reader.source(paths, commit);
  };
  return {
    app,
    async sourceReader() {
      return (await deploy.sourceReader(app, caller(), deps.actingScopeId)) ?? undefined;
    },
    async source(paths, commit) {
      await assertMayEdit();
      return source(paths, commit);
    },
    async save(edit) {
      await assertMayEdit();
      return deploy.editSource(app, deps.context?.() ?? deps.actorId, edit);
    },
  };
}
