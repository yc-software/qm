import type { ToolContext } from "../../tools/primitives.ts";

export function externalTools(tools: ToolContext, authorizeSandbox?: (id: string) => Promise<unknown>): ToolContext {
  const denied = (): never => {
    throw new Error(
      "This operation requires private access. Continue in the requesting person's DM with [[continue-private: task]].",
    );
  };
  const allowed = new Set(["attach", "history", "historyOpen", "commandCredentialHandles"]);
  return new Proxy(tools, {
    get(target, property, receiver) {
      if (property === "sessionSyscalls" || property === "runtime" || property === "registerLogin") return undefined;
      if (property === "mcpToolDefs") return () => [];
      if (property === "execute")
        return async (command: string, opts?: Parameters<ToolContext["execute"]>[1]) => {
          if (opts?.scratch || opts?.ownerAuth || opts?.reachTarget) return denied();
          if (opts?.sandboxId) {
            if (!authorizeSandbox) return denied();
            await authorizeSandbox(opts.sandboxId);
          }
          return target.execute(command, opts);
        };
      if (property === "sandboxResources" && target.sandboxResources)
        return async (...args: Parameters<NonNullable<ToolContext["sandboxResources"]>>) => {
          const id = args[1]?.sandboxId;
          if (id) {
            if (!authorizeSandbox) return denied();
            await authorizeSandbox(id);
          }
          return target.sandboxResources!(...args);
        };
      if (property === "computerStatus")
        return (sandboxId?: string) => {
          if (sandboxId) return denied();
          return target.computerStatus();
        };
      if (allowed.has(String(property))) return Reflect.get(target, property, receiver);
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? denied : undefined;
    },
  });
}
