import { randomUUID } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createKeyedQueue } from "../util/async.ts";

export interface NamedAgent {
  id: string;
  orgId: string;
  handle: string;
  displayName: string;
  title: string;
  owners: string[];
  channelId: string;
  channelName: string;
  state: "active" | "archived";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

type NewNamedAgent = Omit<NamedAgent, "id" | "orgId" | "state" | "createdAt" | "updatedAt">;

type AgentConflict = { conflict: "channel" | "name"; with: NamedAgent };

export type AgentDecision<R, E> = { next: NamedAgent; result: R } | { refused: E };

export interface AgentStore {
  get(id: string): Promise<NamedAgent | null>;
  list(): Promise<NamedAgent[]>;
  activeInChannel(channelId: string): Promise<NamedAgent | undefined>;
  create(input: NewNamedAgent): Promise<NamedAgent | AgentConflict>;
  update<R, E>(
    id: string,
    decide: (current: NamedAgent) => AgentDecision<R, E>,
  ): Promise<{ agent: NamedAgent; result: R } | { refused: E } | AgentConflict | null>;
}

const nameKeys = (agent: Pick<NamedAgent, "handle" | "displayName">): string[] => [
  agent.handle.toLowerCase(),
  agent.displayName.toLowerCase(),
];

export function createAgentStore(
  backing: DurableMap<NamedAgent>,
  opts: { advisoryLock: AdvisoryLock; now?: () => number; id?: () => string },
): AgentStore {
  const now = opts.now ?? Date.now;
  const nextId = opts.id ?? (() => `agt_${randomUUID()}`);
  const queue = createKeyedQueue<string>();
  const withLock = <T>(key: string, fn: () => Promise<T>): Promise<T> =>
    queue(key, () => opts.advisoryLock.withLock(key, fn));
  const inOrg = (agent: NamedAgent | null | undefined): agent is NamedAgent => agent?.orgId === configOrgId();
  const list = async () => (await backing.all()).filter(inOrg);

  async function conflictFor(
    candidate: Pick<NamedAgent, "id" | "handle" | "displayName" | "channelId">,
  ): Promise<AgentConflict | undefined> {
    const keys = new Set(nameKeys(candidate));
    const others = (await list()).filter((agent) => agent.state === "active" && agent.id !== candidate.id);
    const sameChannel = others.find((agent) => agent.channelId === candidate.channelId);
    if (sameChannel) return { conflict: "channel", with: sameChannel };
    const sameName = others.find((agent) => nameKeys(agent).some((key) => keys.has(key)));
    return sameName ? { conflict: "name", with: sameName } : undefined;
  }

  return {
    async get(id) {
      const agent = await backing.get(id);
      return inOrg(agent) ? agent : null;
    },
    list,
    async activeInChannel(channelId) {
      const rows = await backing.select({ where: { field: "channelId", anyOfFold: [channelId] } });
      return rows.find((agent) => inOrg(agent) && agent.state === "active" && agent.channelId === channelId);
    },
    create(input) {
      return withLock("agents:create", async () => {
        const at = now();
        const agent: NamedAgent = {
          ...input,
          id: nextId(),
          orgId: configOrgId(),
          state: "active",
          createdAt: at,
          updatedAt: at,
        };
        const conflict = await conflictFor(agent);
        if (conflict) return conflict;
        await backing.put(agent.id, agent);
        return agent;
      });
    },
    update(id, decide) {
      return withLock(`agent:${id}`, async () => {
        const current = await backing.get(id);
        if (!inOrg(current)) return null;
        const decision = decide(structuredClone(current));
        if ("refused" in decision) return decision;
        const next = { ...decision.next, updatedAt: Math.max(now(), current.updatedAt + 1) };
        const write = async () => {
          await backing.put(id, next);
          return { agent: next, result: decision.result };
        };
        const renamed = nameKeys(next).some((key, i) => key !== nameKeys(current)[i]);
        if (!renamed || next.state !== "active") return write();
        return withLock("agents:create", async () => (await conflictFor(next)) ?? write());
      });
    },
  };
}
