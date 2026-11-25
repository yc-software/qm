import { APPROVED_ACTION_HEADER, API_ACTION_TOOL } from "../../src/api/contract.ts";
import type { Item } from "../../src/sessions/items.ts";

export interface ApiAction {
  method: string;
  path: string;
  body?: unknown;
}

interface ItemSource {
  getItems(sessionId: string, opts?: { turnId?: string }): Promise<Item[]>;
}

export function signOffs<S extends ItemSource>(sessions: S) {
  const decided = new Map<string, Item[]>();
  let next = 0;
  const store = new Proxy(sessions, {
    get(target, prop, receiver) {
      if (prop === "getItems")
        return async (sessionId: string, opts?: { turnId?: string }) =>
          decided.get(`${sessionId}/${opts?.turnId}`) ?? target.getItems(sessionId, opts as never);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const approve = (run: { actorId: string; sessionId: string; runId: string }, action: ApiAction) => {
    const id = `signed-off-${++next}`;
    const base = { seq: next, turnId: run.runId, createdAt: next, variant: null, step: null, text: null };
    const key = `${run.sessionId}/${run.runId}`;
    decided.set(key, [
      ...(decided.get(key) ?? []),
      {
        ...base,
        kind: "ElicitationResponse",
        elicitId: id,
        approved: true,
        author: run.actorId,
        body: {
          approvalKey: `api:${id}`,
          call: {
            requestId: id,
            tool: API_ACTION_TOOL,
            input: action.body === undefined ? { method: action.method, path: action.path } : action,
          },
        },
      },
      { ...base, kind: "ToolCall", callId: `call-${id}`, author: null, body: { approvedRequestId: id } },
    ] as unknown as Item[]);
    return { [APPROVED_ACTION_HEADER]: id };
  };
  return { sessions: store, approve };
}
