import type { DurableMap } from "../persistence/durable-map.ts";
import type { FetchedRepo } from "./ingest.ts";
import type { SkillPackFetcher } from "./pack-fetcher.ts";
import type { SkillPack } from "./skill-pack-store.ts";

export interface SkillPackSourceSnapshot {
  sourceKey: string;
  fetchedAt: number;
  repo: FetchedRepo;
  previous?: FetchedRepo;
}

export class SkillPackSourceError extends Error {}

function sourceKey(pack: SkillPack): string {
  return JSON.stringify(
    pack.kind === "archive"
      ? [pack.kind, pack.createdBy]
      : [pack.kind, pack.url, pack.ref, pack.createdBy, pack.authCredentialSlug ?? null],
  );
}

export function createCachedSkillPackFetcher(options: {
  git: SkillPackFetcher;
  snapshots: DurableMap<SkillPackSourceSnapshot>;
  now?: () => number;
  ttlMs?: number;
}): SkillPackFetcher {
  const { git, snapshots } = options;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 300_000;
  const inFlight = new Map<string, Promise<FetchedRepo>>();

  async function save(pack: SkillPack, repo: FetchedRepo): Promise<void> {
    const key = sourceKey(pack);
    const old = await snapshots.get(pack.id);
    let previous: FetchedRepo | undefined;
    if (old?.sourceKey === key) {
      previous = old.repo.commit === repo.commit ? old.previous : old.repo;
      if (pack.kind === "archive" && pack.previousRef) {
        previous = [old.repo, old.previous].find((candidate) => candidate?.commit === pack.previousRef);
      }
    }
    await snapshots.put(pack.id, { sourceKey: key, fetchedAt: now(), repo, ...(previous ? { previous } : {}) });
  }

  return {
    async fetch(pack, request = {}) {
      const key = sourceKey(pack);
      const stored = await snapshots.get(pack.id);
      const cached = stored?.sourceKey === key ? stored : null;
      if (pack.kind === "archive") {
        if (request.expectedCommit && request.expectedCommit !== pack.ref) {
          throw new SkillPackSourceError("skill pack version changed; browse the pack again before importing");
        }
        const repo = [cached?.repo, cached?.previous].find((repo) => repo?.commit === pack.ref);
        if (!repo) throw new SkillPackSourceError("offline skill pack source is unavailable; upload the archive again");
        return repo;
      }
      if (request.expectedCommit) {
        const repo = [cached?.repo, cached?.previous].find((repo) => repo?.commit === request.expectedCommit);
        if (!repo) throw new SkillPackSourceError("skill pack preview expired; browse the pack again before importing");
        return repo;
      }
      if (cached && !request.refresh && (/^[a-f0-9]{40}$/.test(pack.ref) || now() - cached.fetchedAt < ttlMs)) {
        return cached.repo;
      }
      const pendingKey = JSON.stringify([pack.id, key]);
      const pending = inFlight.get(pendingKey);
      if (pending) return pending;
      const fetch = git.fetch(pack).then(async (repo) => {
        await save(pack, repo);
        return repo;
      });
      inFlight.set(pendingKey, fetch);
      try {
        return await fetch;
      } finally {
        if (inFlight.get(pendingKey) === fetch) inFlight.delete(pendingKey);
      }
    },
    resolveRef: (pack) => (pack.kind === "archive" ? Promise.resolve(pack.ref) : git.resolveRef(pack)),
    async storeArchive(pack, repo) {
      if (pack.kind !== "archive" || pack.ref !== repo.commit) throw new Error("offline skill pack version mismatch");
      await save(pack, repo);
    },
    remove: (pack) => snapshots.delete(pack.id),
  };
}
