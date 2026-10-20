import type { RunActivityStore } from "../runs/run-activity-store.ts";
import { reportFailureAs } from "../util/errors.ts";

export interface ConnectorLink {
  provider: string;
  url: string;
  toolkit?: string;
  logoUrl?: string;
}

const CONNECTOR_LINK = "connector_link";

export async function recordConnectorLink(
  store: RunActivityStore | undefined,
  runId: string | undefined,
  link: ConnectorLink,
): Promise<void> {
  if (!store || !runId) return;
  await store
    .append(runId, { seq: 0, parentSeq: null, type: CONNECTOR_LINK, payload: link, createdAt: Date.now() })
    .catch(reportFailureAs("connector link: record", undefined, link.provider));
}

export function replyConnectorLinks(store: RunActivityStore, runId: string): () => Promise<ConnectorLink[]> {
  const attached = new Set<string>();
  return async () => {
    const links: ConnectorLink[] = [];
    for (const entry of await store.list(runId, CONNECTOR_LINK).catch(reportFailureAs("connector link: list", []))) {
      const link = entry.payload as ConnectorLink;
      if (attached.has(link.url)) continue;
      attached.add(link.url);
      links.push(link);
    }
    return links;
  };
}
