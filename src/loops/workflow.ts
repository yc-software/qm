import { hashId } from "../util/crypto.ts";
import { canonicalJson } from "../util/objects.ts";
import type { DurableTaskContext } from "../durable/tasks.ts";

export function checkpointLoopStore<T extends object>(store: T, context: DurableTaskContext, prefix: string): T {
  const occurrences = new Map<string, number>();
  return new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const resource = hashId([canonicalJson(args[0] ?? null)], 16);
        const operation = `${prefix}:${String(property)}:${resource}`;
        const occurrence = occurrences.get(operation) ?? 0;
        occurrences.set(operation, occurrence + 1);
        const name = `${operation}:${occurrence}`;
        const token = `task:${context.taskID}:${name}`;
        if (property === "claim" || property === "acquireDecision" || property === "claimShipping") {
          args[2] = token;
        }
        if (property === "enqueue") args[0] = { ...(args[0] as object), operationId: token };
        if (property === "recordAction") args[1] = { ...(args[1] as object), operationId: token };
        if (property === "recordFireOutcome") args[2] = token;
        if (property === "setProposal") args[2] = { ...(args[2] as object | undefined), operationId: token };
        if (property === "appendThread" && Array.isArray(args[1])) {
          args[1] = args[1].map((message: object, index: number) => ({ ...message, id: `${token}:${index}` }));
        }
        return context.step(name, () => Reflect.apply(value, target, args));
      };
    },
  });
}
