import type { Principal } from "../types.ts";

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
type SearchHitType = "message" | "conversation" | "file" | "page" | "external";
export interface BackendSearchHit {
  id: string;
  type: SearchHitType;
  title?: string;
  snippet: string;
  url?: string;
  createdAt?: number;
  score?: number;
  metadata?: Record<string, unknown>;
}
export interface SearchHit extends BackendSearchHit {
  backend: string;
}
interface SearchRequest {
  query: string;
  principals: readonly Principal[];
  limit: number;
}
export interface SearchBackend {
  name: string;
  search(request: SearchRequest): Promise<BackendSearchHit[]>;
}
export interface CoreSearch {
  search(input: {
    query: string;
    principals: readonly Principal[];
    limit?: number;
  }): Promise<{ hits: SearchHit[]; failedBackends: string[] }>;
}
function canonicalPrincipals(principals: readonly Principal[]): Principal[] {
  const unique = new Map<string, Principal>();
  for (const principal of principals) {
    const id = principal.id.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (!unique.has(key)) unique.set(key, { ...principal, id });
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function searchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit)));
}
export function createCoreSearch(
  backends: readonly SearchBackend[],
  opts: { onBackendError?: (backend: string, error: unknown) => void } = {},
): CoreSearch {
  const names = new Set<string>();
  for (const backend of backends) {
    if (!backend.name.trim() || names.has(backend.name))
      throw new Error(`duplicate or empty search backend: ${backend.name}`);
    names.add(backend.name);
  }
  return {
    async search(input) {
      const query = input.query.trim();
      const principals = canonicalPrincipals(input.principals);
      if (!query || !principals.length) return { hits: [], failedBackends: [] };
      const limit = searchLimit(input.limit);
      const settled = await Promise.allSettled(backends.map((backend) => backend.search({ query, principals, limit })));
      const hits: SearchHit[] = [];
      const failedBackends: string[] = [];
      for (const [index, result] of settled.entries()) {
        const backend = backends[index]!;
        if (result.status === "rejected") {
          failedBackends.push(backend.name);
          opts.onBackendError?.(backend.name, result.reason);
          continue;
        }
        for (const hit of result.value.slice(0, limit)) hits.push({ ...hit, backend: backend.name });
      }
      hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return { hits: hits.slice(0, limit), failedBackends };
    },
  };
}
