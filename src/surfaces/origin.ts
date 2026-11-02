import type { SurfaceAccount, TurnSurfaceOrigin } from "./contract.ts";

export function originAccount(origin: TurnSurfaceOrigin): SurfaceAccount {
  return {
    id: origin.author.account,
    workspace: origin.workspace,
    ...(origin.policyNamespace ? { policyNamespace: origin.policyNamespace } : {}),
  };
}
