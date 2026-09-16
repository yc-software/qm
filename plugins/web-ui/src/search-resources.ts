import { deepLinkPath } from "./deep-link.ts";

export interface ResourceHit {
  title: string;
  description: string;
  group: string;
  href: string;
}
export interface ResourceSearchResponse {
  hits: Array<{
    id: string;
    kind: "skills" | "crons" | "deploys" | "webhooks" | "contexts";
    title: string;
    snippet: string;
  }>;
  failed: string[];
  limited?: string[];
}
const labels: Record<string, string> = {
  skills: "Skills",
  crons: "Crons",
  deploys: "Apps",
  webhooks: "Webhooks",
  contexts: "Projects",
};

export function resourceResults(
  result: ResourceSearchResponse,
  base: string,
): { hits: ResourceHit[]; failed: string[] } {
  return {
    hits: result.hits.map((hit) => ({
      title: hit.title,
      description: hit.snippet,
      group: labels[hit.kind]!,
      href: deepLinkPath(
        base,
        hit.kind,
        null,
        hit.kind === "contexts" ? hit.id : null,
        hit.kind === "contexts" ? null : hit.id,
      ),
    })),
    failed: result.failed.map((kind) => labels[kind] ?? kind),
  };
}

export function matchResources(hits: ResourceHit[], query: string): ResourceHit[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return hits.filter((h) => {
    const text = `${h.title} ${h.description} ${h.group}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
