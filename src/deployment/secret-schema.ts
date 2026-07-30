import { isStrongSigningSecret } from "../auth/source-auth.ts";

export interface RuntimeSecretSpec {
  name: string;
  requiredWhen:
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
}

export const CORE_SECRET_SPECS: readonly RuntimeSecretSpec[] = [
  { name: "CAPABILITY_SECRET", requiredWhen: "production" },
  { name: "CONNECTOR_SECRET_KEY", requiredWhen: "production" },
  { name: "CORE_SIGNING_SECRET", requiredWhen: "production" },
  { name: "PORTAL_IDENTITY_SECRET", requiredWhen: "production" },
  { name: "SKILL_SIGNING_SECRET", requiredWhen: "production" },
  { name: "OPENAI_API_KEY", requiredWhen: "codex" },
  // MODEL_PROVIDER names the vendor supplying the base model. The deployment CLI sets it
  // from `modelProvider` in qm.config.jsonc, so a stack that declares a provider refuses
  // to boot without that provider's key rather than accepting turns it cannot serve.
  { name: "ANTHROPIC_API_KEY", requiredWhen: "model-anthropic" },
  { name: "OPENAI_API_KEY", requiredWhen: "model-openai" },
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

export function validateCoreSecretEnv(env: NodeJS.ProcessEnv): string[] {
  const enabled = (spec: RuntimeSecretSpec): boolean => {
    if (spec.requiredWhen === "production") return env.NODE_ENV === "production";
    if (spec.requiredWhen === "codex") return env.HARNESS?.trim() === "codex";
    if (spec.requiredWhen === "postgres") return env.SESSION_STORE === "postgres" || env.RUN_STORE === "postgres";
    if (spec.requiredWhen === "sprites")
      return env.SANDBOX_BACKEND === "sprites" || env.SANDBOX_SECONDARY_BACKEND === "sprites";
    if (spec.requiredWhen === "fly-sandbox") return env.SANDBOX_BACKEND === "fly";
    if (spec.requiredWhen === "fly-deploy") return env.DEPLOY_PROVIDER === "fly";
    if (spec.requiredWhen === "aws-deploy-gate") return Boolean(env.AWS_DEPLOY_APPS_DOMAIN);
    if (spec.requiredWhen === "google-oauth") return Boolean(env.GOOGLE_OAUTH_CLIENT_ID);
    if (spec.requiredWhen === "dropbox-oauth") return Boolean(env.DROPBOX_OAUTH_CLIENT_ID);
    if (spec.requiredWhen === "model-anthropic") return env.MODEL_PROVIDER?.trim() === "anthropic";
    if (spec.requiredWhen === "model-openai") return env.MODEL_PROVIDER?.trim() === "openai";
    if (spec.requiredWhen === "model-openrouter") return env.MODEL_PROVIDER?.trim() === "openrouter";
    return Boolean(env.LINEAR_OAUTH_CLIENT_ID);
  };
  // OPENAI_API_KEY carries two specs (the Codex harness and an OpenAI base model), so
  // deduplicate before reporting — a name should be named once however many rules want it.
  return [
    ...new Set(
      CORE_SECRET_SPECS.filter((spec) => enabled(spec) && isInvalidSecret(spec.name, env[spec.name])).map(
        (spec) => spec.name,
      ),
    ),
  ];
}

function isInvalidSecret(name: string, value: string | undefined): boolean {
  const candidate = value?.trim();
  if (!candidate || /^(replace-me|placeholder|changeme|todo)$/i.test(candidate)) return true;
  return (
    (name === "CONNECTOR_SECRET_KEY" || name === "CORE_SIGNING_SECRET" || name === "SKILL_SIGNING_SECRET") &&
    !isStrongSigningSecret(candidate)
  );
}
