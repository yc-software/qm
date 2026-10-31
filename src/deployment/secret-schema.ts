import { isBearerSecret, isStrongSigningSecret } from "../auth/source-auth.ts";

type SecretGate =
  | "production"
  | "postgres"
  | "background-work-control"
  | "render"
  | "porter-deploy"
  | "e2b-deploy"
  | "fly-shared-deploy"
  | "fly-deploy"
  | "aws-deploy-gate";

export interface RuntimeSecretSpec {
  name: string;
  requiredWhen: SecretGate | readonly SecretGate[];
  reason?: string;
}

export const CORE_SECRET_SPECS: readonly RuntimeSecretSpec[] = [
  { name: "CAPABILITY_SECRET", requiredWhen: "production" },
  { name: "CONNECTOR_SECRET_KEY", requiredWhen: "production" },
  { name: "CORE_SIGNING_SECRET", requiredWhen: "production" },
  { name: "DEPLOYMENT_CONTROL_SECRET", requiredWhen: "background-work-control" },
  { name: "PORTAL_IDENTITY_SECRET", requiredWhen: "production" },
  { name: "SKILL_SIGNING_SECRET", requiredWhen: "production" },
  {
    name: "DATABASE_URL",
    requiredWhen: "production",
    reason:
      "sessions, runs, approvals, audit, locks and leases must survive restarts and be shared across instances, or a blue-green rollout can destroy a scope's resident disk",
  },
  {
    name: "DATABASE_OWNER_URL",
    requiredWhen: "postgres",
    reason: "migrations and cross-tenant claims run as the table owner while requests use the row-level-secured login",
  },
  { name: "DATABASE_READER_URL", requiredWhen: "production" },
  { name: "RENDER_API_KEY", requiredWhen: "render" },
  { name: "PORTER_DEPLOY_API_TOKEN", requiredWhen: "porter-deploy" },
  { name: "E2B_API_KEY", requiredWhen: "e2b-deploy" },
  { name: "FLY_DEPLOY_API_TOKEN", requiredWhen: "fly-deploy" },
  { name: "FLY_DEPLOY_WIREGUARD_PEERS", requiredWhen: "fly-shared-deploy" },
  { name: "AWS_DEPLOY_GATE_SECRET", requiredWhen: "aws-deploy-gate" },
];

const GATE_PREDICATES: Readonly<Record<SecretGate, (env: NodeJS.ProcessEnv) => boolean>> = {
  production: (env) => env.NODE_ENV === "production",
  postgres: (env) => Boolean(env.DATABASE_URL?.trim()),
  "background-work-control": (env) => Boolean(env.BACKGROUND_DEPLOYMENT_ID?.trim()),
  render: (env) => env.DEPLOY_PROVIDER === "render",
  "porter-deploy": (env) => env.DEPLOY_PROVIDER === "porter",
  "e2b-deploy": (env) => env.DEPLOY_PROVIDER === "e2b",
  "fly-shared-deploy": (env) => env.DEPLOY_PROVIDER === "fly" && Boolean(env.FLY_DEPLOY_SHARED_APP_NAME?.trim()),
  "fly-deploy": (env) => env.DEPLOY_PROVIDER === "fly",
  "aws-deploy-gate": (env) => Boolean(env.AWS_DEPLOY_APPS_DOMAIN || env.DEPLOY_APPS_DOMAIN),
};

const SANDBOX_WIDE_SECRET_PREFIX = "FLY_RESIDENT_ENV_";

export function validateCoreSecretEnv(env: NodeJS.ProcessEnv): string[] {
  const sandboxWide = Object.keys(env).filter((name) => name.startsWith(SANDBOX_WIDE_SECRET_PREFIX));
  if (sandboxWide.length)
    throw new Error(
      `${sandboxWide.join(", ")}: deployment-wide sandbox secrets would reach every tenant's computers — store each credential in the keychain of the scope that owns it and remove these variables`,
    );
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
  if (name === "DEPLOYMENT_CONTROL_SECRET" && !isBearerSecret(value)) return true;
  return (
    (name === "CONNECTOR_SECRET_KEY" ||
      name === "CORE_SIGNING_SECRET" ||
      name === "DEPLOYMENT_CONTROL_SECRET" ||
      name === "SKILL_SIGNING_SECRET" ||
      name === "AWS_DEPLOY_GATE_SECRET") &&
    !isStrongSigningSecret(candidate)
  );
}
