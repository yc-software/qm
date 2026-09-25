import type { Principal } from "../types.ts";
import type { BackendSearchHit, SearchBackend } from "./core-search.ts";

export function createIntersectionBackend(opts: {
  name: string;
  key: (hit: BackendSearchHit) => string;
  searchForPrincipal: (principal: Principal, query: string, limit: number) => Promise<BackendSearchHit[]>;
}): SearchBackend {
  return {
    name: opts.name,
    async search(request) {
      const resultSets = await Promise.all(
        request.principals.map((principal) => opts.searchForPrincipal(principal, request.query, request.limit)),
      );
      const [first, ...rest] = resultSets;
      if (!first) return [];
      const visible = rest.map((hits) => new Set(hits.map(opts.key)));
      return first.filter((hit) => visible.every((keys) => keys.has(opts.key(hit)))).slice(0, request.limit);
    },
  };
}
