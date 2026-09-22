import { isStrongSigningSecret } from "../auth/source-auth.ts";

type SecretGate =
  | "production"
  | "background-work-control"
  | "codex"
  | "postgres"
  | "sprites"
  | "smolmachines"
  | "e2b"
  | "modal"
  | "porter"
  | "agent37"
  | "superserve"
  | "porter-deploy"
  | "fly-shared-deploy"
  | "fly-deploy"
  | "aws-deploy-gate"
  | "google-oauth"
  | "dropbox-oauth"
  | "linear-oauth"
  | "email-auth"
  | "model-anthropic"
  | "model-openai"
  | "model-openrouter";

export interface RuntimeSecretSpec {
  name: string;
  requiredWhen: SecretGate | readonly SecretGate[];
}

export const CORE_SECRET_SPECS: readonly RuntimeSecretSpec[] = [
  { name: "CAPABILITY_SECRET", requiredWhen: "production" },
  { name: "CONNECTOR_SECRET_KEY", requiredWhen: "production" },
  { name: "CORE_SIGNING_SECRET", requiredWhen: "production" },
  { name: "DEPLOYMENT_CONTROL_SECRET", requiredWhen: "background-work-control" },
  { name: "PORTAL_IDENTITY_SECRET", requiredWhen: "production" },
  { name: "SKILL_SIGNING_SECRET", requiredWhen: "production" },
  { name: "AUTH_ALLOWED_EMAILS", requiredWhen: "email-auth" },
  { name: "OPENAI_API_KEY", requiredWhen: ["codex", "model-openai"] },
  { name: "ANTHROPIC_API_KEY", requiredWhen: "model-anthropic" },
  { name: "OPENROUTER_API_KEY", requiredWhen: "model-openrouter" },
  { name: "DATABASE_URL", requiredWhen: "postgres" },
  { name: "SPRITES_TOKEN", requiredWhen: "sprites" },
  { name: "SMOLMACHINES_TOKEN", requiredWhen: "smolmachines" },
  { name: "AGENT37_API_KEY", requiredWhen: "agent37" },
  { name: "SUPERSERVE_API_KEY", requiredWhen: "superserve" },
  { name: "E2B_API_KEY", requiredWhen: "e2b" },
  { name: "MODAL_TOKEN_ID", requiredWhen: "modal" },
  { name: "MODAL_TOKEN_SECRET", requiredWhen: "modal" },
  { name: "PORTER_DEPLOY_API_TOKEN", requiredWhen: ["porter", "porter-deploy"] },
  { name: "FLY_DEPLOY_API_TOKEN", requiredWhen: "fly-deploy" },
  { name: "FLY_DEPLOY_WIREGUARD_PEERS", requiredWhen: "fly-shared-deploy" },
  { name: "AWS_DEPLOY_GATE_SECRET", requiredWhen: "aws-deploy-gate" },
  { name: "GOOGLE_OAUTH_CLIENT_SECRET", requiredWhen: "google-oauth" },
  { name: "DROPBOX_OAUTH_CLIENT_SECRET", requiredWhen: "dropbox-oauth" },
  { name: "LINEAR_OAUTH_CLIENT_SECRET", requiredWhen: "linear-oauth" },
];

function sandboxBackendSelected(env: NodeJS.ProcessEnv, backend: string): boolean {
  if (env.SANDBOX_BACKEND?.trim() === backend) return true;
  const scopes: unknown = JSON.parse(env.SANDBOX_SCOPE_BACKENDS || "{}");
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes))
    throw new Error("SANDBOX_SCOPE_BACKENDS must be an object");
  return Object.values(scopes).some((value) => typeof value === "string" && value.trim() === backend);
}

const GATE_PREDICATES: Readonly<Record<SecretGate, (env: NodeJS.ProcessEnv) => boolean>> = {
  production: (env) => env.NODE_ENV === "production",
  "background-work-control": (env) => Boolean(env.BACKGROUND_DEPLOYMENT_ID?.trim()),
  codex: (env) => env.HARNESS?.trim() === "codex" && !env.CODEX_AUTH_FILE?.trim() && !env.CODEX_AUTH_CREDENTIAL?.trim(),
  postgres: (env) => env.SESSION_STORE === "postgres" || env.RUN_STORE === "postgres",
  sprites: (env) => sandboxBackendSelected(env, "sprites"),
  smolmachines: (env) => sandboxBackendSelected(env, "smolmachines"),
  e2b: (env) => sandboxBackendSelected(env, "e2b"),
  modal: (env) => sandboxBackendSelected(env, "modal"),
  porter: (env) => sandboxBackendSelected(env, "porter"),
  agent37: (env) => sandboxBackendSelected(env, "agent37"),
  superserve: (env) => sandboxBackendSelected(env, "superserve"),
  "porter-deploy": (env) => env.DEPLOY_PROVIDER === "porter",
  "fly-shared-deploy": (env) => env.DEPLOY_PROVIDER === "fly" && Boolean(env.FLY_DEPLOY_SHARED_APP_NAME?.trim()),
  "fly-deploy": (env) => env.DEPLOY_PROVIDER === "fly",
  "aws-deploy-gate": (env) => Boolean(env.AWS_DEPLOY_APPS_DOMAIN || env.DEPLOY_APPS_DOMAIN),
  "google-oauth": (env) => Boolean(env.GOOGLE_OAUTH_CLIENT_ID),
  "dropbox-oauth": (env) => Boolean(env.DROPBOX_OAUTH_CLIENT_ID),
  "linear-oauth": (env) => Boolean(env.LINEAR_OAUTH_CLIENT_ID),
  "email-auth": (env) => env.AUTH_ALLOWED_EMAILS !== undefined,
  "model-anthropic": (env) => env.MODEL_PROVIDER?.trim() === "anthropic",
  "model-openai": (env) =>
    env.MODEL_PROVIDER?.trim() === "openai" &&
    !(env.HARNESS?.trim() === "codex" && (env.CODEX_AUTH_FILE?.trim() || env.CODEX_AUTH_CREDENTIAL?.trim())),
  "model-openrouter": (env) => env.MODEL_PROVIDER?.trim() === "openrouter",
};

export function validateCoreSecretEnv(env: NodeJS.ProcessEnv): string[] {
  const enabled = (spec: RuntimeSecretSpec): boolean => {
    const gates = typeof spec.requiredWhen === "string" ? [spec.requiredWhen] : spec.requiredWhen;
    return gates.some((gate) => GATE_PREDICATES[gate](env));
  };
  return CORE_SECRET_SPECS.filter((spec) => enabled(spec) && isInvalidSecret(spec.name, env[spec.name])).map(
    (spec) => spec.name,
  );
}

function isInvalidSecret(name: string, value: string | undefined): boolean {
  const candidate = value?.trim();
  if (!candidate || /^(replace-me|placeholder|changeme|todo)$/i.test(candidate)) return true;
  return (
    (name === "CONNECTOR_SECRET_KEY" ||
      name === "CORE_SIGNING_SECRET" ||
      name === "DEPLOYMENT_CONTROL_SECRET" ||
      name === "SKILL_SIGNING_SECRET" ||
      name === "AWS_DEPLOY_GATE_SECRET") &&
    !isStrongSigningSecret(candidate)
  );
}
