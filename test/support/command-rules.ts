import type { ScopedConfigStore } from "../../src/resolution/config-store.ts";
import { scopeId, type CommandRule, type ScopeId } from "../../src/types.ts";

export const OPERATOR_COMMAND_RULES: CommandRule[] = [
  {
    pattern: "\\brm\\b[^\\n]*(?:-[a-zA-Z]*r|--recursive)",
    decision: "require_approval",
    reason: "recursive delete",
  },
  {
    pattern: "\\bgit\\s+push\\b.*(?:--force\\b|(?:^|\\s)-[a-zA-Z]*f\\b)",
    decision: "require_approval",
    reason: "force push",
  },
  { pattern: "\\b(drop|truncate)\\s+table\\b", decision: "require_approval", reason: "destructive SQL" },
  { pattern: "\\bmkfs\\b|:\\(\\)\\s*\\{", decision: "deny", reason: "destructive / fork bomb" },
  { pattern: "\\bcurl\\b.*\\|\\s*(sh|bash)\\b", decision: "require_approval", reason: "pipe-to-shell" },
];

export async function configureCommandRules(
  config: Pick<ScopedConfigStore, "setCommandPolicy">,
  scope: ScopeId = scopeId("org", "default-org"),
): Promise<void> {
  await config.setCommandPolicy(scope, { mode: "denylist", rules: OPERATOR_COMMAND_RULES });
}

export async function withCommandRules<T extends { config: Pick<ScopedConfigStore, "setCommandPolicy"> }>(
  built: T,
): Promise<T> {
  await configureCommandRules(built.config);
  return built;
}
