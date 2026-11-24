import { randomUUID } from "node:crypto";
import type { CronStore } from "../cron/cron-store.ts";
import type { LoopStore } from "../loops/loop-store.ts";
import type { MonitorStore } from "../monitors/monitor-store.ts";
import type { ProcessRecord, ProcessRegistry } from "../processes/process-registry.ts";
import { reconcileProcesses } from "../processes/reconcile.ts";
import { supportsProcessSessions, type Sandbox } from "../sandbox/sandbox.ts";
import type { SandboxResources } from "../sandbox/sandbox-resources.ts";
import type { Tenant } from "../tenants/context.ts";
import { postsInto } from "../triggers/trigger-store.ts";
import type { ChildIsolation, Principal, ScopeId, Session, SpawnMeta } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import type { WebhookStore } from "../webhooks/webhook-store.ts";
import type { SessionStore } from "./session-store.ts";

interface MoveTarget {
  groupRef: string;
  channelName: string;
  audience: Principal[];
  version: string | undefined;
}

function rehomedSpawnMeta(
  meta: SpawnMeta,
  target: MoveTarget,
  computers: ReadonlyMap<string, string | null>,
): SpawnMeta {
  const { isPrivate: _isPrivate, isMpim: _isMpim, teamIds: _teamIds, ...conversation } = meta.conversation;
  const { scopeVersion: _scopeVersion, isolation, ...rest } = meta;
  const rebound = (child: ChildIsolation): ChildIsolation => {
    const computer = child.sandboxId ? computers.get(child.sandboxId) : undefined;
    if (computer === undefined) return child;
    const { sandboxId: _sandboxId, ...kept } = child;
    return computer ? { ...kept, sandboxId: computer } : kept;
  };
  return {
    ...rest,
    conversation: {
      ...conversation,
      kind: "group",
      channelRef: target.groupRef,
      channelName: target.channelName,
      audience: target.audience,
      publishMembers: target.audience,
    },
    sessionParticipantIds: target.audience.map((principal) => principal.id),
    ...(target.version ? { scopeVersion: target.version } : {}),
    ...(isolation ? { isolation: rebound(isolation) } : {}),
  };
}

function newReaders(memberIds: readonly string[], readers: readonly (readonly string[])[]): string[] {
  return memberIds.filter((member) => readers.some((sessionReaders) => !sessionReaders.includes(member)));
}

export interface ChatMoveDeps {
  sessions: Pick<SessionStore, "participantsOfMany" | "rehome">;
  processes?: ProcessRegistry;
  sandbox?: Sandbox;
  sandboxResources?: Pick<SandboxResources, "getMany">;
  crons: Pick<CronStore, "rehome">;
  webhooks: Pick<WebhookStore, "rehome">;
  monitors?: Pick<MonitorStore, "rehome">;
  loops?: Pick<LoopStore, "list" | "update">;
}

export interface ChatMove {
  tree: readonly Session[];
  to: ScopeId;
  members: readonly string[];
  target: MoveTarget;
}

type JobHold = { purpose: string; chat?: string };

async function chatJobs(deps: ChatMoveDeps, tree: readonly Session[]): Promise<ProcessRecord[]> {
  const threadRefs = new Set(tree.map((s) => s.threadRef));
  return ((await deps.processes?.listByScope(tree[0]!.scopeId)) ?? []).filter(
    (rec) => rec.kind === "background" && rec.status === "running" && rec.sessionRef && threadRefs.has(rec.sessionRef),
  );
}

async function projectComputers(deps: ChatMoveDeps, ids: readonly string[], to: ScopeId): Promise<Set<string>> {
  const computers = ids.length ? ((await deps.sandboxResources?.getMany([...new Set(ids)])) ?? []) : [];
  return new Set(computers.filter((computer) => computer.ownerScopeId === to).map((computer) => computer.id));
}

export async function settleChatJobs(deps: ChatMoveDeps, tree: readonly Session[], to: ScopeId): Promise<void> {
  const { processes, sandbox } = deps;
  if (!processes || !sandbox || !supportsProcessSessions(sandbox)) return;
  const jobs = await chatJobs(deps, tree);
  const usable = await projectComputers(
    deps,
    jobs.flatMap((rec) => rec.sandboxId ?? []),
    to,
  );
  const hosts = new Map(
    jobs.flatMap((rec) => (rec.sandboxId && !usable.has(rec.sandboxId) ? [[rec.sandboxId, rec.scopeId]] : [])),
  );
  await Promise.all(
    [...hosts].map(([sandboxId, scopeId]) =>
      (async () => {
        const handle = await sandbox.provision(scopeId, { sandboxId });
        try {
          await reconcileProcesses(sandbox, handle, processes, scopeId);
        } finally {
          await sandbox
            .teardown(handle, { keepWarm: true })
            .catch(swallowAs("session move: release job computer", undefined));
        }
      })().catch(swallowAs("session move: check a moving chat's jobs", undefined)),
    ),
  );
}

export async function chatMoveHold(deps: ChatMoveDeps, tree: readonly Session[], to: ScopeId) {
  const jobs = await chatJobs(deps, tree);
  const childComputers = tree.flatMap((s) => s.spawnMeta?.isolation?.sandboxId ?? []);
  const usable = await projectComputers(deps, [...jobs.flatMap((rec) => rec.sandboxId ?? []), ...childComputers], to);
  const stranded = jobs.find((rec) => !rec.sandboxId || !usable.has(rec.sandboxId));
  const chat = stranded && tree.find((s) => s.threadRef === stranded.sessionRef);
  const hold: JobHold | undefined = stranded && {
    purpose: stranded.purpose ?? stranded.command.replace(/^bg: /, ""),
    ...(chat && chat !== tree[0] && chat.title ? { chat: chat.title } : {}),
  };
  return { hold, jobs, usable };
}

export async function newChatReaders(
  deps: ChatMoveDeps,
  tenant: Tenant,
  tree: readonly Session[],
  members: readonly string[],
  sourceMembers: readonly string[] | null,
): Promise<string[]> {
  const participants = await deps.sessions.participantsOfMany(
    tenant,
    tree.map((s) => s.id),
  );
  const readers = [...participants.values()].map((ids) =>
    ids.filter((id) => !sourceMembers || sourceMembers.includes(id)),
  );
  return newReaders(members, readers);
}

export async function carryChatAlong(
  deps: ChatMoveDeps,
  tenant: Tenant,
  move: ChatMove,
  { jobs, usable }: { jobs: readonly ProcessRecord[]; usable: ReadonlySet<string> },
): Promise<void> {
  const { tree, to, members, target } = move;
  const from = tree[0]!.scopeId;
  const threadRefs = new Set(tree.map((s) => s.threadRef));
  if (jobs.length)
    await deps.processes?.rescope(
      tenant,
      jobs.map((rec) => rec.processId),
      to,
    );
  const triggers = { threadRefs, from, to };
  await Promise.all([deps.crons.rehome(triggers), deps.webhooks.rehome(triggers), deps.monitors?.rehome(triggers)]);
  for (const loop of (await deps.loops?.list()) ?? [])
    if (loop.ownerScopeId === from && postsInto(loop, threadRefs))
      await deps.loops!.update(loop.id, { destination: null });
  const isolations = tree.flatMap((s) => s.spawnMeta?.isolation ?? []);
  const own = new Set(isolations.flatMap((i) => (i.mode === "sandbox" && i.sandboxId ? [i.sandboxId] : [])));
  const bound = new Set(isolations.flatMap((i) => (i.sandboxId && !usable.has(i.sandboxId) ? [i.sandboxId] : [])));
  const computers = new Map([...bound].map((id) => [id, own.has(id) ? randomUUID() : null] as const));
  const spawnMeta = new Map(
    tree.flatMap((s) => (s.spawnMeta ? [[s.id, rehomedSpawnMeta(s.spawnMeta, target, computers)] as const] : [])),
  );
  await deps.sessions.rehome(
    tenant,
    tree.map((s) => s.id),
    { type: "group", scopeId: to, channelName: target.channelName },
    members,
    spawnMeta,
  );
}
