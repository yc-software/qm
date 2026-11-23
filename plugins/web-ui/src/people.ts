import { errMessage } from "../../chassis/src/errors";
import { api } from "./core-bridge";

export interface Person {
  principalId: string;
  displayName: string;
  type?: string;
  slackId?: string;
  avatarUrl?: string;
  isBot?: boolean;
}

const RETRY_AFTER_MS = 60_000;
const known = new Map<string, Person | null>();
const failedAt = new Map<string, number>();
const inflight = new Set<string>();
const searches = new Map<string, Promise<Person[]>>();
const listeners = new Set<() => void>();

export function onPeople(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function learn(person: Person): void {
  known.set(person.principalId, person);
  if (person.slackId) known.set(person.slackId, person);
}

function resolve(query: string): Promise<Person[]> {
  return api<{ matches?: Person[] }>(`/api/directory/resolve?q=${encodeURIComponent(query)}`).then((response) => {
    const matches = response.matches ?? [];
    matches.forEach(learn);
    return matches;
  });
}

export function person(id: string | undefined): Person | null | undefined {
  if (!id) return undefined;
  const hit = known.get(id);
  if (hit !== undefined) return hit;
  if (inflight.has(id) || Date.now() - (failedAt.get(id) ?? -Infinity) < RETRY_AFTER_MS) return undefined;
  inflight.add(id);
  void resolve(id)
    .then(
      () => {
        if (!known.has(id)) known.set(id, null);
        failedAt.delete(id);
      },
      (error: unknown) => {
        failedAt.set(id, Date.now());
        console.warn(`Directory lookup failed for ${id}: ${errMessage(error)}`);
      },
    )
    .then(() => {
      inflight.delete(id);
      for (const listener of listeners) listener();
    });
  return undefined;
}

export function searchPeople(query: string): Promise<Person[]> {
  const key = query.trim().toLowerCase();
  if (!key) return Promise.resolve([]);
  let pending = searches.get(key);
  if (!pending) {
    pending = resolve(key).catch((error: unknown) => {
      searches.delete(key);
      console.warn(`Directory search failed for ${key}: ${errMessage(error)}`);
      return [];
    });
    searches.set(key, pending);
  }
  return pending;
}
