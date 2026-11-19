import type { FileArtifact, FileArtifactStore, FilePage } from "./file-artifact-store.ts";
import { personalScope } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { privateSourceAllowed, inheritContextSources, type PrivateContext } from "../sessions/private-context.ts";

export function contextualFiles(
  files: FileArtifactStore,
  sessions: Pick<SessionStore, "recordContextProvenance">,
  context: PrivateContext,
): FileArtifactStore {
  async function shown(rows: readonly FileArtifact[]) {
    const blocked = await inheritContextSources(
      sessions,
      context,
      rows.map((file) => ({
        id: file.id,
        ownerScopeId: file.ownerScopeId,
        personalOnly: file.personalOnly,
        sourceProvenance: file.sourceProvenance,
      })),
    );
    return rows.filter((file) => !blocked.has(file.id));
  }
  async function page(result: FilePage): Promise<FilePage> {
    return { ...result, files: await shown(result.files) };
  }
  const ids = (input: { contextSessionIds?: readonly string[] }) => [
    ...new Set([...(input.contextSessionIds ?? []), ...(context.sessionId ? [context.sessionId] : [])]),
  ];
  return {
    ...files,
    put: (input) => files.put({ ...input, contextSessionIds: ids(input) }),
    publish: (input, transaction) => files.publish({ ...input, contextSessionIds: ids(input) }, transaction),
    getMany: async (tenant, ids, opts) => shown(await files.getMany(tenant, ids, opts)),
    async get(id, opts) {
      const file = await files.get(id, opts);
      return file ? ((await shown([file]))[0] ?? null) : null;
    },
    async open(id) {
      const opened = await files.open(id);
      if (!opened) return null;
      if (!(await shown([opened.artifact])).length) {
        opened.stream.destroy();
        return null;
      }
      return opened;
    },
    listContext: async (scopes, opts) =>
      shown(
        await files.listContext(scopes, {
          ...opts,
          excludePersonalOnly:
            opts?.excludePersonalOnly || !privateSourceAllowed(context, personalScope(context.actorId)),
        }),
      ),
    listOwnedByScopes: async (scopes, opts) =>
      page(
        await files.listOwnedByScopes(scopes, {
          ...opts,
          excludePersonalOnly:
            opts?.excludePersonalOnly || !privateSourceAllowed(context, personalScope(context.actorId)),
        }),
      ),
    listDocuments: async (scopes, refs, opts) =>
      page(
        await files.listDocuments(scopes, refs, {
          ...opts,
          excludePersonalOnly:
            opts?.excludePersonalOnly || !privateSourceAllowed(context, personalScope(context.actorId)),
        }),
      ),
    resolveByIds: async (...args) => shown(await files.resolveByIds(...args)),
  };
}
