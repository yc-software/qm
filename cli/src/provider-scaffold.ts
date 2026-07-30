import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { ModelProvider, QmConfig } from "./config.ts";
import type { Target } from "./providers.ts";
import { declaredVariables, terraformVars } from "./terraform.ts";

interface ScaffoldFile {
  segments: string[];
  content: string;
}

export interface ProviderScaffold {
  renderConfig(orgId: string, modelProvider: ModelProvider): string;
  ignores: readonly string[];
  agentsAppendix: string;
  files(config: QmConfig): ScaffoldFile[];
  configurationHint: string;
  finalCommand: string;
  finalWhy: string;
}

interface ConfigValues {
  target: Target;
  modelProvider: ModelProvider;
  publicUrl: string;
  providerFields: string;
  services: string[];
  env: string;
  secretEnv: string;
  sandbox: string;
}

function renderConfig(orgId: string, values: ConfigValues): string {
  return `{
  // The deployment contract major this directory conforms to.
  "contract": 1,

  // Short identifier for your organization; app and container names derive from it.
  "orgId": ${JSON.stringify(orgId)},

  // The one public address of the deployment; the service URLs derive from it.
  "publicUrl": ${JSON.stringify(values.publicUrl)},

  // Where to deploy: "docker" runs local containers, "fly" deploys Fly apps,
  // and "aws" runs the control plane on ECS and agent computers on Lambda MicroVMs.
  "target": ${JSON.stringify(values.target)},

  // The vendor supplying the base model: "anthropic", "openai", or "openrouter"
  // (one key, many models). Naming one makes that vendor's API key a required
  // deployment secret: \`qm setup\` collects it, \`qm doctor\` proves the provider
  // accepts it, and \`qm up\` refuses a stack that cannot serve an agent turn.
  // Delete this line to leave the base model unset and have an administrator add
  // the key from the Admin page after deploy instead.
  "modelProvider": ${JSON.stringify(values.modelProvider)},

  // Optional base model id, passed to the harness (e.g. "claude-opus-4-6").
  // Omit it to use the harness default for the provider above.
  // "model": "",
${values.providerFields}
  // First-party services to run. The full set: "core" (the agent runtime and API,
  // always required), "slack" (the Slack surface, runs inside the core process),
  // "web-ui" (a browser chat UI), "admin" (the operator dashboard), "portal"
  // (the public sign-in front door), and "auth" (the built-in sign-in broker that
  // emails one-time links; drop it to sign in through an external OIDC provider).
  "services": [${values.services.map((service) => JSON.stringify(service)).join(", ")}],

  // Extra plugins to run alongside the services. A prebuilt image runs with
  // { "name": "linear", "image": "ghcr.io/you/qm-linear:1.0" }. A plugin with a
  // Dockerfile at plugins/<name>/ in this directory needs no entry here at all.
  "plugins": [],

  // Extra directories of SKILL.md files, mounted into the agent.
  "skills": [],

  // Non-secret env overrides, per service. HARNESS "pi" runs real agent turns
  // against the base model selected by "modelProvider" above. "mock" runs the
  // whole stack with fake turns and no model calls.
  "env": ${values.env}${values.secretEnv}${values.sandbox}
}
`;
}

function clusterName(orgId: string): string {
  const full = `${orgId}-qm`;
  return full.length <= 49
    ? full
    : `${orgId.slice(0, 40).replace(/-+$/, "")}-${createHash("sha256").update(full).digest("hex").slice(0, 8)}`;
}

function template(rel: string): string {
  const source = new URL(`../templates/${rel}`, import.meta.url);
  const packaged = new URL(`../../templates/${rel}`, import.meta.url);
  return readFileSync(existsSync(source) ? source : packaged, "utf8");
}

const AWS_AGENTS_APPENDIX = `
## Bootstrapping the AWS target

1. Replace the account and GitHub placeholders. The account must already have
   GitHub's IAM OIDC provider. Check it with
   \`aws iam get-open-id-connect-provider --open-id-connect-provider-arn arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com\`.
   If it is absent, an account administrator creates it once with
   \`aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com\`.
2. Run \`npm exec qm -- infra render\`, review the result, then run
   \`terraform -chdir=infra init && terraform -chdir=infra apply\`. This creates
   inert ECS services, RDS, CloudFront, an ALB origin restricted to CloudFront,
   and the MicroVM roles. Set \`publicUrl\` to
   \`https://<cloudfront_hostname>\` and
   \`env.core.AWS_PUBLIC_ORIGIN_URL\` to \`http://<alb_hostname>\`.
3. Sign-in is handled by the built-in \`auth\` broker: set
   \`env.auth.AUTH_ALLOWED_EMAIL_DOMAIN\` (or leave it out and supply
   \`AUTH_ALLOWED_EMAILS\`), then run \`npm exec qm -- setup\` for the sender address
   and the Resend or SMTP credentials; the CLI generates the broker's keys and the
   portal's client credentials and wires \`OIDC_*\` itself. To use an external
   identity provider instead, drop \`"auth"\` from \`services\`, configure
   \`env.portal\` with the provider's OIDC endpoints and an \`OIDC_ALLOWED_EMAILS\`
   or \`OIDC_ALLOWED_EMAIL_DOMAIN\` tenant gate, and register
   \`<publicUrl>/auth/callback\` with the provider. Add optional services and their
   ECS/ECR entries now, then render and apply once more.
4. Run \`npm exec qm -- infra build-image\` to build the Lambda MicroVM guest image
   and record its immutable version and execution role in the config.
5. Fill the gitignored \`.env\` and run \`npm exec qm -- secrets push\`.
6. Run \`npm exec qm -- doctor\`, \`npm exec qm -- plan\`,
   \`npm exec qm -- up --yes\`, and
   \`npm exec qm -- check --live\`, in that order.

To tear down this target, run \`npm exec qm -- down\`, then persist the destructive
lifecycle settings in Terraform state with \`terraform -chdir=infra apply
-var='ecr_force_delete=true' -var='object_store_force_destroy=true'
-var='db_skip_final_snapshot=true' -var='secret_recovery_window_days=0'\`.
After that apply completes, run
\`npm exec qm -- infra delete-task-definitions --yes\`, then
\`npm exec qm -- infra delete-image --yes\`, then run \`terraform -chdir=infra destroy
-var='ecr_force_delete=true' -var='object_store_force_destroy=true'
-var='db_skip_final_snapshot=true' -var='secret_recovery_window_days=0'\`.
Applying the settings before destroy lets Terraform remove deployed images,
versioned objects, Secrets Manager secrets without a recovery window, and the
database without a final snapshot. Omit the database override from both
commands to retain a final RDS snapshot. Run the cleanup commands with
infrastructure-administrator credentials; the GitHub deploy role intentionally
cannot deregister or delete task definitions.
`;

const noFiles = (): ScaffoldFile[] => [];

export const dockerScaffold: ProviderScaffold = {
  renderConfig: (orgId, modelProvider) =>
    renderConfig(orgId, {
      target: "docker",
      modelProvider,
      publicUrl: "http://localhost:8082",
      providerFields: "",
      services: ["core", "web-ui"],
      env: `{ "core": { "HARNESS": "pi" } }`,
      secretEnv: "",
      sandbox: `,

  // The Fly app agents execute in. The core boots the immutable sandbox image
  // recorded by \`qm sandbox publish\`.
  "sandbox": { "app": ${JSON.stringify(`${orgId}-sandboxes`)} }`,
    }),
  ignores: [".env", "node_modules/", ".generated/"],
  agentsAppendix: "",
  files: noFiles,
  configurationHint: "docker: confirm the local public port and Fly sandbox app before setup",
  finalCommand: "npm exec qm -- up",
  finalWhy: "pull images, start services, print URLs",
};

export const flyScaffold: ProviderScaffold = {
  renderConfig: (orgId, modelProvider) =>
    renderConfig(orgId, {
      target: "fly",
      modelProvider,
      publicUrl: `https://${orgId}-portal.fly.dev`,
      providerFields: `
  // Globally unique prefix for every Fly app in this deployment.
  "appPrefix": ${JSON.stringify(orgId)},

  // Fly region and org to deploy into ("personal" is every Fly account's default org).
  "region": "sjc",
  "flyOrg": "personal",
`,
      services: ["core", "slack", "web-ui", "admin", "portal", "auth"],
      env: `{ "core": { "HARNESS": "pi", "SNAPSHOT_STORE": "s3", "TRANSFER_STORE": "s3", "S3_BUCKET": ${JSON.stringify(`${orgId}-data`)}, "S3_REGION": "auto" }, "slack": { "SLACK_IDENTITY_EMAIL": "1" }, "auth": { "AUTH_EMAIL_TRANSPORT": "resend" } }`,
      secretEnv: `,

  // The initial admin seed is kept in the provider secret store, never in config.
  "secretEnv": { "core": { "ADMIN_GRANTS": "ADMIN_GRANTS" } },`,
      sandbox: `

  // The Fly app agents execute in. The core boots the immutable sandbox image
  // recorded by \`qm sandbox publish\`.
  "sandbox": { "app": ${JSON.stringify(`${orgId}-sandboxes`)} }`,
    }),
  ignores: [".env", "node_modules/", ".generated/"],
  agentsAppendix: "",
  files: noFiles,
  configurationHint: "fly: confirm flyOrg, region, app names, public URL, and identity gate before setup",
  finalCommand: "npm exec qm -- up",
  finalWhy: "pull images, start services, print URLs",
};

export const awsScaffold: ProviderScaffold = {
  renderConfig: (orgId, modelProvider) => {
    const cluster = clusterName(orgId);
    const services = Object.fromEntries(
      [
        ["core", 2048, 4096],
        ["web-ui", 512, 1024],
        ["admin", 512, 1024],
        ["portal", 512, 1024],
        ["auth", 256, 512],
      ].map(([name, cpu, memory]) => [
        name,
        {
          ecrRepository: `${orgId}-qm-${name}`,
          ecsService: `${cluster}-${name}`,
          cpu,
          memory,
        },
      ]),
    );
    return renderConfig(orgId, {
      target: "aws",
      modelProvider,
      publicUrl: `https://${orgId}.example.com`,
      providerFields: `
  // AWS coordinates. Replace the account id and public URL before applying infra/.
  // imageLabel identifies the deployment manifest used by rollback and live checks.
  "aws": {
    "accountId": "000000000000",
    "region": "us-west-2",
    "cluster": ${JSON.stringify(cluster)},
    "deployRoleArn": ${JSON.stringify(`arn:aws:iam::000000000000:role/${cluster}-github-deploy`)},
    "secretsPrefix": ${JSON.stringify(`${orgId}/qm/`)},
    "imageLabel": "latest",
    "networking": { "cloudMapNamespace": ${JSON.stringify(`${orgId}.internal`)} },
    "services": ${JSON.stringify(services, null, 6).replace(/^/gm, "    ").trimStart()}
  },
`,
      services: ["core", "slack", "web-ui", "admin", "portal", "auth"],
      env: `{ "core": { "HARNESS": "pi", "AWS_DEPLOY_IMAGE": ${JSON.stringify(`${cluster}-sandbox`)}, "AWS_PUBLIC_ORIGIN_URL": "http://replace-with-alb-hostname" }, "slack": { "SLACK_IDENTITY_EMAIL": "1" }, "auth": { "AUTH_EMAIL_TRANSPORT": "resend" } }`,
      secretEnv: `,

  // The initial admin seed is kept in the provider secret store, never in config.
  "secretEnv": { "core": { "ADMIN_GRANTS": "ADMIN_GRANTS" } }`,
      sandbox: `

  // Where agent sandboxes execute. Omitting "sandbox" entirely runs AWS Lambda MicroVMs
  // (published by \`qm infra build-image\`). To boot an operator-published sandbox layer
  // image in a Fly app instead (published by \`qm sandbox publish\`), declare it explicitly:
  //   "sandbox": { "backend": "sprites", "app": ${JSON.stringify(`${orgId}-sandboxes`)} }`,
    });
  },
  ignores: [
    ".env",
    "node_modules/",
    ".generated/",
    "infra/.terraform/",
    "infra/*.tfstate",
    "infra/*.tfstate.*",
    "infra/crash.log",
    "infra/*.tfplan",
  ],
  agentsAppendix: AWS_AGENTS_APPENDIX,
  files: (config) => {
    const files = ["main.tf", "outputs.tf", "variables.tf", "versions.tf"].map((name) => ({
      segments: ["infra", name],
      content: template(`aws/${name}`),
    }));
    const variables = template("aws/variables.tf");
    return [
      ...files,
      {
        segments: ["infra", "terraform.tfvars"],
        content: terraformVars(config, "", declaredVariables(variables)),
      },
    ];
  },
  configurationHint: "aws: finish the account, region, public edge, GitHub OIDC, and identity gate fields before setup",
  finalCommand: "terraform -chdir=infra init && terraform -chdir=infra apply",
  finalWhy: "create inert infrastructure; finish the edge + portal steps in AGENTS.md before up",
};
