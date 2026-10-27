import { surfaceHas } from "../surfaces/surface.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { Session } from "../types.ts";
import type { Item } from "../sessions/items.ts";
import type { OrchestratorInput } from "../core/orchestrator/types.ts";
import { isSubagentThreadRef } from "../sessions/thread-ref.ts";
import { sessionRunCancelled } from "./tree.ts";
import type { SessionSyscallBinding, SessionSyscallDeps } from "./types.ts";

const WEB_ONLY = "sessions are a web UI feature and aren't available here.";

/** What every session tool call in one turn shares: the caller binding and the target lookups. */
export interface TurnContext {
  deps: SessionSyscallDeps;
  binding: SessionSyscallBinding;
  lock: AdvisoryLock;
  cap: number;
  admissionKey: (root: Session) => string;
  callerTitle: string;
  resolveTarget(ref: string): Promise<Session | null>;
  sidebarRefusal(): string | null;
  peerRefusal(target: Session): string | null;
  statusOf(session: Session): Promise<"running" | "pending" | "idle">;
  visibleTitle(target: Session): string;
  visibleHistory(target: Session, limit: number): Promise<Item[]>;
  currentCaller(): Promise<OrchestratorInput>;
}

export function createTurnContext(
  deps: SessionSyscallDeps,
  binding: SessionSyscallBinding,
  admission: { lock: AdvisoryLock; cap: number; admissionKey: (root: Session) => string },
): TurnContext {
  const callerTitle = binding.session.title?.trim() || "this conversation";

  async function resolveTarget(ref: string): Promise<Session | null> {
    const trimmed = ref.trim();
    if (!trimmed) return null;
    const current = await deps.sessions.get(binding.session.id);
    if (trimmed.toLowerCase() === "parent")
      return current?.parentSessionId ? deps.sessions.get(current.parentSessionId) : null;
    const byId = await deps.sessions.get(trimmed);
    if (byId) return byId;
    const byThread = await deps.sessions.getByThread(trimmed);
    if (byThread) return byThread;
    const children = await deps.sessions.childrenOf(binding.session.id);
    const siblings = current?.parentSessionId ? await deps.sessions.childrenOf(current.parentSessionId) : [];
    return [...children, ...siblings].find((c) => c.title?.trim().toLowerCase() === trimmed.toLowerCase()) ?? null;
  }

  function sidebarRefusal(): string | null {
    if (!surfaceHas(binding.request.surface, "sidebar")) return WEB_ONLY;
    return null;
  }

  function peerRefusal(target: Session): string | null {
    const refusal = sidebarRefusal();
    if (refusal) return refusal;
    if (target.parentSessionId || isSubagentThreadRef(target.threadRef))
      return `"${target.title?.trim() || target.id}" is a subagent, not a session — use the subagents tool for it.`;
    return null;
  }

  async function statusOf(session: Session): Promise<"running" | "pending" | "idle"> {
    const inFlight = await deps.runs.inFlightForThread(session.threadRef);
    if (inFlight.some((r) => r.status === "running")) return "running";
    return inFlight.length ? "pending" : "idle";
  }

  const visibleTitle = (target: Session) => target.title?.trim() || target.id;
  async function visibleHistory(target: Session, limit: number): Promise<Item[]> {
    const audience = binding.request.conversation.audience.length
      ? binding.request.conversation.audience
      : [binding.request.actor];
    return deps.sessions.visibleItems(target.id, [binding.request.actor.id, ...audience.map((p) => p.id)], {
      limit,
    });
  }

  async function currentCaller(): Promise<OrchestratorInput> {
    binding.request.cancel?.throwIfAborted();
    if (await sessionRunCancelled(deps.runs, deps.signals, binding.request.runId))
      throw new Error("this delegated task was stopped");
    const current = await deps.sessions.get(binding.session.id);
    if (
      !current ||
      current.scopeId !== binding.scopeId ||
      (deps.authorize && !(await deps.authorize(current, binding.request.actor.id)))
    )
      throw new Error("the sender no longer has access to this session");
    const request: OrchestratorInput = {
      ...binding.request,
      origin: binding.request.origin ?? { kind: "automation" },
      text: "",
    };
    return deps.prepareRequest ? deps.prepareRequest(request) : request;
  }
  return {
    deps,
    binding,
    ...admission,
    callerTitle,
    resolveTarget,
    sidebarRefusal,
    peerRefusal,
    statusOf,
    visibleTitle,
    visibleHistory,
    currentCaller,
  };
}
