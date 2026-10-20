export const HOSTING_PROVIDER_IDS = ["docker", "fly", "aws"] as const;

export type Target = (typeof HOSTING_PROVIDER_IDS)[number];

export const isTarget = (value: unknown): value is Target =>
  typeof value === "string" && (HOSTING_PROVIDER_IDS as readonly string[]).includes(value);

export const SANDBOX_BACKENDS = {
  local: "Docker containers on the deployment host",
  sprites: "Fly Sprites",
  aws: "Lambda MicroVM sandboxes",
  agent37: "",
  superserve: "Superserve sandboxes",
  e2b: "E2B sandboxes",
} as const;

export type SandboxBackendId = keyof typeof SANDBOX_BACKENDS;

export const isSandboxBackendId = (value: unknown): value is SandboxBackendId =>
  typeof value === "string" && Object.hasOwn(SANDBOX_BACKENDS, value);

export interface SandboxBackendPolicy {
  /** Sandbox backends this hosting target can run. */
  allowed: readonly SandboxBackendId[];
  /** Whether the target requires "sandbox.backend" to be set explicitly in config. */
  requireExplicit: boolean;
}

/** Keyed by hosting target so adding a target forces a sandbox-backend decision. */
export const SANDBOX_BACKEND_POLICY: Record<Target, SandboxBackendPolicy> = {
  docker: { allowed: ["local", "sprites", "agent37", "superserve", "e2b"], requireExplicit: false },
  fly: { allowed: ["sprites", "agent37", "superserve", "e2b"], requireExplicit: false },
  aws: { allowed: ["sprites", "aws", "agent37", "superserve", "e2b"], requireExplicit: true },
};

export const targetsAllowingSandboxBackend = (backend: SandboxBackendId): Target[] =>
  HOSTING_PROVIDER_IDS.filter((target) => SANDBOX_BACKEND_POLICY[target].allowed.includes(backend));

export const hostingProviderChoices = (): string =>
  `${HOSTING_PROVIDER_IDS.slice(0, -1).join(", ")}, or ${HOSTING_PROVIDER_IDS.at(-1)}`;
