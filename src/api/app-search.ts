import { samePerson } from "../directory/person.ts";
import { createCoreSearch, type BackendSearchHit, type SearchBackend } from "../search/core-search.ts";
import { createIntersectionBackend } from "../search/backends.ts";
import { matchesSearchTerms, searchSnippet, searchTerms } from "../sessions/entry-search.ts";
import type { Principal } from "../types.ts";
import { collectBytes } from "../util/bytes.ts";
import type { App, AppDeps } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";

function conversationBackend(app: App): SearchBackend {
  return createIntersectionBackend({
    name: "conversations",
    key: (hit) => hit.id,
    searchForPrincipal: async (principal, query, limit) =>
      (await app.searchSessions(principal.id, query, limit)).map((hit) => ({
        id: `${hit.sessionId}:${hit.seq}`,
        type: "conversation" as const,
        ...(hit.title ? { title: hit.title } : {}),
        snippet: hit.snippet,
        createdAt: hit.createdAt,
        metadata: {
          sessionId: hit.sessionId,
          seq: hit.seq,
          scopeId: hit.scopeId,
          entryType: hit.entryType,
          ...(hit.surface ? { surface: hit.surface } : {}),
          ...(hit.channelName ? { channelName: hit.channelName } : {}),
          ...(hit.author ? { author: hit.author } : {}),
        },
      })),
  });
}
function searchableFile(mimetype: string, name: string): boolean {
  return (
    mimetype.startsWith("text/") ||
    /(?:json|xml|yaml|csv|markdown)/i.test(mimetype) ||
    /\.(?:txt|md|markdown|json|jsonl|csv|tsv|xml|ya?ml)$/i.test(name)
  );
}
function fileBackend(deps: AppDeps, app: App, helpers: AppHelpers): SearchBackend {
  return {
    name: "files",
    async search(request) {
      const libraries = await Promise.all(
        request.principals.map(async (p) => {
          const scopes = await helpers.currentResourceScopesForViewer(p.id);
          const [owned, handles] = await Promise.all([
            deps.files.listOwnedByScopes(scopes, { limit: 200 }),
            deps.acl.handlesFor(scopes),
          ]);
          const shared = await deps.files.resolveByOwnerPaths(
            handles.map((h) => ({ ownerScopeId: h.ownerScopeId, path: h.ownerPath })),
          );
          return [
            ...owned.files,
            ...shared.filter((f) => !scopes.includes(f.ownerScopeId)).sort((a, b) => b.updatedAt - a.updatedAt),
          ];
        }),
      );
      const [first, ...rest] = libraries;
      if (!first) return [];
      const common = rest.map((files) => new Set(files.map((file) => file.id)));
      const files = first.filter((file) => common.every((ids) => ids.has(file.id)));
      const terms = searchTerms(request.query);
      const hits: BackendSearchHit[] = [];
      for (const file of files) {
        let text = file.name;
        if (searchableFile(file.mimetype, file.name)) {
          const opened = await app.openFileForViewer(file.id, request.principals[0]!.id);
          if (opened) {
            const collected = await collectBytes(opened.stream, { maxBytes: 512 * 1024 }).catch(() => null);
            if (collected) text += `\n${collected.data.toString("utf8")}`;
          }
        }
        if (!matchesSearchTerms(text, terms)) continue;
        hits.push({
          id: file.id,
          type: "file",
          title: file.name,
          snippet: searchSnippet(text, terms),
          createdAt: file.createdAt,
          metadata: { ownerScopeId: file.ownerScopeId, sizeBytes: file.sizeBytes, direction: file.direction },
        });
        if (hits.length >= request.limit) break;
      }
      return hits;
    },
  };
}
function slackBackend(deps: AppDeps, app: App): SearchBackend | null {
  if (!deps.surfaceCache) return null;
  const canSee = async (principal: Principal, container: string): Promise<boolean> => {
    const state = await deps.surfaceCache!.containerState(container);
    if (!state) return false;
    if (state.kind === "group") return deps.directory.groupMember(container, principal.id);
    if (state.kind === "dm") {
      const members = await deps.surfaceCache!.members(container);
      return members.some((member) => samePerson(member, principal.id));
    }
    return app.channelVisibleTo(principal.id, container);
  };
  return {
    name: "slack",
    async search(request) {
      const messages = await app.searchSurface(request.query, { limit: Math.min(100, request.limit * 4) });
      const hits: BackendSearchHit[] = [];
      for (const message of messages) {
        const visible = await Promise.all(request.principals.map((p) => canSee(p, message.container)));
        if (!visible.every(Boolean)) continue;
        hits.push({
          id: `${message.container}:${message.ts}`,
          type: "message",
          snippet: message.text,
          createdAt: message.createdAt,
          metadata: {
            container: message.container,
            ts: message.ts,
            ...(message.sub ? { threadTs: message.sub } : {}),
            ...(message.authorId ? { authorId: message.authorId } : {}),
            ...(message.authorName ? { authorName: message.authorName } : {}),
          },
        });
        if (hits.length >= request.limit) break;
      }
      return hits;
    },
  };
}
export function createSearchMethods(deps: AppDeps, app: App, helpers: AppHelpers): Pick<App, "search"> {
  const slack = slackBackend(deps, app);
  const core = createCoreSearch(
    [conversationBackend(app), ...(slack ? [slack] : []), fileBackend(deps, app, helpers)],
    {
      onBackendError: (backend, error) =>
        console.error(
          "%s",
          `[search] backend ${backend} failed:`,
          error instanceof Error ? error.message : String(error),
        ),
    },
  );
  return { search: (query, principals, limit) => core.search({ query, principals, limit }) };
}
