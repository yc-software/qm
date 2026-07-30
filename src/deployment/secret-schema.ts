import { isStrongSigningSecret } from "../auth/source-auth.ts";

type SecretGate =
  | "production"
  | "codex"
  | "postgres"
  | "sprites"
  | "fly-sandbox"
  | "fly-deploy"
  | "aws-deploy-gate"
  | "google-oauth"
  | "dropbox-oauth"
  | "linear-oauth"
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
  { name: "PORTAL_IDENTITY_SECRET", requiredWhen: "production" },
  { name: "SKILL_SIGNING_SECRET", requiredWhen: "production" },
  { name: "OPENAI_API_KEY", requiredWhen: ["codex", "model-openai"] },
  { name: "ANTHROPIC_API_KEY", requiredWhen: "model-anthropic" },
  { name: "OPENROUTER_API_KEY", requiredWhen: "model-openrouter" },
  { name: "DATABASE_URL", requiredWhen: "postgres" },
  { name: "SPRITES_TOKEN", requiredWhen: "sprites" },
  { name: "FLY_API_TOKEN", requiredWhen: "fly-sandbox" },
  { name: "FLY_DEPLOY_API_TOKEN", requiredWhen: "fly-deploy" },
  { name: "AWS_DEPLOY_GATE_SECRET", requiredWhen: "aws-deploy-gate" },
  { name: "GOOGLE_OAUTH_CLIENT_SECRET", requiredWhen: "google-oauth" },
  { name: "DROPBOX_OAUTH_CLIENT_SECRET", requiredWhen: "dropbox-oauth" },
  { name: "LINEAR_OAUTH_CLIENT_SECRET", requiredWhen: "linear-oauth" },
];

const GATE_PREDICATES: Readonly<Record<SecretGate, (env: NodeJS.ProcessEnv) => boolean>> = {
  production: (env) => env.NODE_ENV === "production",
  codex: (env) => env.HARNESS?.trim() === "codex",
  postgres: (env) => env.SESSION_STORE === "postgres" || env.RUN_STORE === "postgres",
  sprites: (env) => env.SANDBOX_BACKEND === "sprites" || env.SANDBOX_SECONDARY_BACKEND === "sprites",
  "fly-sandbox": (env) => env.SANDBOX_BACKEND === "fly",
  "fly-deploy": (env) => env.DEPLOY_PROVIDER === "fly",
  "aws-deploy-gate": (env) => Boolean(env.AWS_DEPLOY_APPS_DOMAIN),
  "google-oauth": (env) => Boolean(env.GOOGLE_OAUTH_CLIENT_ID),
  "dropbox-oauth": (env) => Boolean(env.DROPBOX_OAUTH_CLIENT_ID),
  "linear-oauth": (env) => Boolean(env.LINEAR_OAUTH_CLIENT_ID),
  "model-anthropic": (env) => env.MODEL_PROVIDER?.trim() === "anthropic",
  "model-openai": (env) => env.MODEL_PROVIDER?.trim() === "openai",
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
    (name === "CONNECTOR_SECRET_KEY" || name === "CORE_SIGNING_SECRET" || name === "SKILL_SIGNING_SECRET") &&
    !isStrongSigningSecret(candidate)
  );
}
