import type { RuntimeChoice } from "./harness.ts";
import type { CapabilityClaims } from "../auth/capability-token.ts";

export interface RuntimeRequest {
  action: "get" | "set" | "inherit";
  model?: string;
  harness?: string;
  effort?: string;
  fastMode?: boolean;
  lifetime?: "task" | "scope";
}

export interface RuntimeHandoff {
  choice: RuntimeChoice;
  lifetime: "task" | "scope";
}

export type RuntimeResult =
  | { ok: false; error: string; message?: string; candidates?: string[] }
  | { ok: true; handoff?: RuntimeHandoff; [key: string]: unknown };

export type RuntimeControl = (
  active: RuntimeChoice,
  request: RuntimeRequest,
  signal?: AbortSignal,
) => Promise<RuntimeResult>;
export type RuntimeService = (
  claims: CapabilityClaims,
  active: RuntimeChoice,
  request: RuntimeRequest,
  authorizeChoice?: (choice: RuntimeChoice) => Promise<string | null>,
  individualAuth?: boolean,
  signal?: AbortSignal,
) => Promise<RuntimeResult>;
