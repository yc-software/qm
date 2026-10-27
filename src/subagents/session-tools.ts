import { errMessage } from "../util/errors.ts";
import { swarmCall } from "../swarms/swarm.ts";
import { SUBAGENT_TREE_RUN_CAP } from "./tree.ts";
import { createTurnContext } from "./turn-context.ts";
import { openSubagent, writeSession } from "./admission.ts";
import { acknowledgeMessages, readSession, receiveMessages } from "./reading.ts";
import { listSessions, searchSessions, startSession } from "./conversations.ts";
import type { Session } from "../types.ts";
import type { SessionSyscallDeps, SessionSyscalls, SessionSyscallsFactory } from "./types.ts";

export type { SessionSyscallDeps, SessionSyscalls, SessionSyscallsFactory } from "./types.ts";

/** The subagents and sessions tools for one turn: each call is one of the operations in admission, reading and conversations. */
export function createSessionSyscalls(deps: SessionSyscallDeps): SessionSyscallsFactory {
  const lock = deps.advisoryLock;
  /** Opens and writes that add runs to one session tree queue behind each other; other trees go on in parallel. */
  const admissionKey = (root: Session) => `session-tree-admission:${root.id}`;
  const cap = deps.treeRunCap ?? SUBAGENT_TREE_RUN_CAP;

  return {
    forTurn(binding) {
      const ctx = createTurnContext(deps, binding, { lock, cap, admissionKey });
      const syscalls: SessionSyscalls = {
        receive: (timeoutMs) => receiveMessages(ctx, timeoutMs),
        acknowledge: (ids) => acknowledgeMessages(ctx, ids),
        open: (input) => openSubagent(ctx, input),
        write: (input) => writeSession(ctx, input),
        read: (input) => readSession(ctx, input),
        search: (input) => searchSessions(ctx, input),
        list: () => listSessions(ctx),
        start: (input) => startSession(ctx, input),
      };
      const board = deps.board;
      if (board)
        syscalls.swarm = async (input) => {
          try {
            const caller = await ctx.currentCaller();
            const session = (await deps.sessions.get(binding.session.id)) ?? binding.session;
            return await swarmCall(
              {
                board,
                sessions: deps.sessions,
                mailbox: deps.mailbox,
                session,
                actor: caller.actor,
                audience: caller.conversation.audience,
                open: (member) => openSubagent(ctx, member, { swarm: true }),
              },
              input,
            );
          } catch (error) {
            return { ok: false, message: errMessage(error) };
          }
        };
      return syscalls;
    },
  };
}
