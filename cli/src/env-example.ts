import type { QmConfig } from "./config.ts";
import { FIRST_PARTY_SECRET_SPECS, computedSecrets, managedByFor, type SecretCondition } from "./secrets.ts";

function requiresOtherEmailTransport(config: QmConfig, condition: SecretCondition): boolean {
  if (condition.kind === "all")
    return condition.conditions.some((nested) => requiresOtherEmailTransport(config, nested));
  if (condition.kind === "any")
    return condition.conditions.every((nested) => requiresOtherEmailTransport(config, nested));
  if (condition.kind !== "env-equals" || condition.service !== "auth" || condition.name !== "AUTH_EMAIL_TRANSPORT")
    return false;
  const configured = config.env.auth?.AUTH_EMAIL_TRANSPORT?.trim();
  return configured !== undefined && configured !== "" && configured !== condition.value;
}

function conditionClause(condition: SecretCondition): string {
  if (condition.kind === "sandbox-backend") return `SANDBOX_BACKEND selects ${condition.backend}`;
  if (condition.kind === "service-enabled") return `the ${condition.service} service is enabled`;
  if (condition.kind === "service-absent") return `the ${condition.service} service is not enabled`;
  if (condition.kind === "all") return condition.conditions.map(conditionClause).join(" and ");
  if (condition.kind === "any") return condition.conditions.map(conditionClause).join(" or ");
  if (condition.kind === "target") return `the target is ${condition.target}`;
  if (condition.kind === "env-all-absent")
    return `none of env.${condition.service}.{${condition.names.join(", ")}} are set`;
  if (condition.kind === "env-absent") return `env.${condition.service}.${condition.name} is not set`;
  if (condition.kind === "env-present") return `env.${condition.service}.${condition.name} is set`;
  if (condition.kind === "model-provider") return `modelProvider is ${JSON.stringify(condition.provider)}`;
  return `env.${condition.service}.${condition.name} is ${JSON.stringify(condition.value)}`;
}

export function renderEnvExample(config: QmConfig): string {
  const lines = [
    "# Secret values for this deployment. This file holds names only; copy it to .env and fill in",
    "# the values. .env is gitignored. `qm secrets push` transfers values without persisting",
    "# or printing them.",
    "",
  ];
  const active = computedSecrets(config);
  for (const secret of active) {
    const consumers = [
      ...new Set([...secret.services, ...(secret.aliases ?? []).map((alias) => alias.service)]),
    ].sort();
    lines.push(`# ${secret.description} (${consumers.join(", ")})`);
    if (secret.generate) lines.push(`# Generate with: ${secret.generate}`);
    if (secret.managedBy === "render") lines.push(`# ${secret.name}=  # supplied by qm up on Render`);
    else if (secret.managedBy === "terraform") lines.push(`# ${secret.name}=  # populated by Terraform`);
    else if (secret.required) lines.push(`${secret.name}=`);
    else lines.push(`# ${secret.name}=  # optional`);
    lines.push("");
  }
  const activeNames = new Set(active.map((secret) => secret.name));
  const inactive = FIRST_PARTY_SECRET_SPECS.filter(
    (spec, i, all) =>
      !activeNames.has(spec.name) &&
      all.findIndex((other) => other.name === spec.name) === i &&
      !(typeof spec.required === "object" && requiresOtherEmailTransport(config, spec.required.when)),
  );
  for (const spec of inactive) {
    const clauses = [
      ...(config.services.includes(spec.service) ? [] : [`the ${spec.service} service is enabled`]),
      ...(typeof spec.required === "boolean" ? [] : [conditionClause(spec.required.when)]),
    ];
    lines.push(`# ${spec.description} (${spec.service})`);
    lines.push(`# Needed when ${clauses.join(" and ")}${spec.required === false ? " (optional even then)" : ""}.`);
    if (spec.generate) lines.push(`# Generate with: ${spec.generate}`);
    lines.push(
      managedByFor(spec, config.target) === "terraform"
        ? `# ${spec.name}=  # populated by Terraform`
        : `# ${spec.name}=`,
    );
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
