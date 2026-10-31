import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { renderSource, type EmailTransport, type ModelProvider, type QmConfig } from "./config.ts";
import type { Target } from "./providers.ts";
import { declaredVariables, terraformVars } from "./terraform.ts";

interface ScaffoldFile {
  segments: string[];
  content: string;
}

export interface ProviderScaffold {
  renderConfig(
    orgId: string,
    modelProvider: ModelProvider,
    emailTransport: EmailTransport,
    source?: { repo: string; branch: string },
  ): string;
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

  // Optional bot identity. "botName" is what the bot is called everywhere users
  // see it — the Slack app, the prompt identity, sign-in pages — and "orgName"
  // is how the bot refers to your organization. Both default to neutral values
  // ("qm" / "this organization") and can be changed live from the Admin page.
  // "botName": "straylight",
  // "orgName": "Acme Corp",

  // Where to deploy: "docker" runs local containers, "fly" deploys Fly apps, "aws" runs
  // the control plane on ECS and agent computers on Lambda MicroVMs, and "render" builds
  // Render services from Git with native Render Sandboxes as agent computers.
  "target": ${JSON.stringify(values.target)},

  // The vendor supplying the base model: "anthropic", "openai", or "openrouter"
  // (one key, many models). Naming one makes that vendor's API key a required
  // deployment secret and points the base model at that vendor: \`qm setup\`
  // collects the key, \`qm doctor\` proves the provider accepts it, and \`qm up\`
  // refuses a stack that cannot serve an agent turn. Delete this line to leave
  // the base model unset and have an administrator add the key from the Admin
  // page after deploy instead.
  "modelProvider": ${JSON.stringify(values.modelProvider)},

  // Optional base model id (e.g. "claude-opus-4-6").
  // Omit it and the deployment uses the default model for the provider above.
  // It must be a model that provider can bill.
  // "model": "",
${values.providerFields}
  // First-party services to run. The full set: "core" (the agent runtime and API,
  // always required), "slack" (the Slack surface, runs inside the core process),
  // "web-ui" (a browser chat UI), "admin" (the operator dashboard), "portal"
  // (the public sign-in front door), "auth" (the built-in sign-in broker that
  // emails one-time links; drop it to sign in through an external OIDC provider),
  // and "egress-proxy" (the TLS proxy that enforces sandbox egress policy).
  "services": [${values.services.map((service) => JSON.stringify(service)).join(", ")}],

  // Extra plugins to run alongside the services. A prebuilt image runs with
  // { "name": "linear", "image": "ghcr.io/you/qm-linear:1.0" }. A plugin with a
  // Dockerfile at plugins/<name>/ in this directory needs no entry here at all.
  "plugins": [],

  // Extra directories of SKILL.md files, mounted into the agent.
  "skills": [],

  // Non-secret env overrides, per service.
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
   A deployment with a separate \`apiUrl\` or \`AWS_DEPLOY_APPS_DOMAIN\` instead
   sets \`certificate_arn\`, points those HTTPS hostnames at \`<alb_hostname>\`,
   and uses the ALB directly; the generated security group exposes only that
   TLS listener in direct mode.
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
      env: `{}`,
      secretEnv: "",
      sandbox: "",
    }),
  ignores: [".env", "node_modules/", ".generated/"],
  agentsAppendix: "",
  files: noFiles,
  configurationHint: "docker: confirm the local public port before setup",
  finalCommand: "npm exec qm -- up",
  finalWhy: "pull images, start services, print URLs",
};

export const flyScaffold: ProviderScaffold = {
  renderConfig: (orgId, modelProvider, emailTransport) =>
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
      env: `{ "core": { "SNAPSHOT_STORE": "s3", "TRANSFER_STORE": "s3", "S3_BUCKET": ${JSON.stringify(`${orgId}-data`)}, "S3_REGION": "auto" }, "slack": { "SLACK_IDENTITY_EMAIL": "1" }, "auth": { "AUTH_EMAIL_TRANSPORT": ${JSON.stringify(emailTransport)} } }`,
      secretEnv: `,

  // The initial admin seed is kept in the provider secret store, never in config.
  "secretEnv": { "core": { "ADMIN_GRANTS": "ADMIN_GRANTS" } }`,
      sandbox: "",
    }),
  ignores: [".env", "node_modules/", ".generated/"],
  agentsAppendix: "",
  files: noFiles,
  configurationHint: "fly: confirm flyOrg, region, app names, public URL, and identity gate before setup",
  finalCommand: "npm exec qm -- up",
  finalWhy: "pull images, start services, print URLs",
};

export const awsScaffold: ProviderScaffold = {
  renderConfig: (orgId, modelProvider, emailTransport) => {
    const cluster = clusterName(orgId);
    const services = Object.fromEntries(
      [
        ["core", 2048, 4096],
        ["web-ui", 512, 1024],
        ["portal", 512, 1024],
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
      env: `{ "core": { "AWS_DEPLOY_IMAGE": ${JSON.stringify(`${cluster}-sandbox`)}, "AWS_PUBLIC_ORIGIN_URL": "http://replace-with-alb-hostname" }, "slack": { "SLACK_IDENTITY_EMAIL": "1" }, "auth": { "AUTH_EMAIL_TRANSPORT": ${JSON.stringify(emailTransport)} } }`,
      secretEnv: `,

  // The initial admin seed is kept in the provider secret store, never in config.
  "secretEnv": { "core": { "ADMIN_GRANTS": "ADMIN_GRANTS" } }`,
      sandbox: `

  // Where agent sandboxes execute. Omitting "sandbox" entirely runs AWS Lambda MicroVMs
  // (published by \`qm infra build-image\`). To run Fly Sprites instead, declare it explicitly:
  //   "sandbox": { "backend": "sprites" }`,
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

export const renderScaffold: ProviderScaffold = {
  renderConfig: (orgId, modelProvider, emailTransport, source) =>
    renderConfig(orgId, {
      target: "render",
      modelProvider,
      publicUrl: `https://${orgId}-portal.onrender.com`,
      providerFields: `
  // The core API address. Render assigns both URLs and qm up rewrites them here.
  // Set your own HTTPS origins instead to use custom domains; see the Render reference.
  "apiUrl": ${JSON.stringify(`https://${orgId}-core.onrender.com`)},

  "render": {
    "workspaceId": "tea-replaceme",
    "source": ${JSON.stringify(renderSource(source, "Render initialization"))},
    "region": "oregon",
    "corePlan": "2c-4g",
    "servicePlan": "0.5c-512mb",
    "postgresPlan": "0.5c-1g",
    "postgresDiskSizeGB": 10,
    "storage": { "plan": "0.5c-512mb", "diskSizeGB": 10 }
  },
`,
      services: ["core", "slack", "web-ui", "admin", "portal", "auth"],
      env: `{ "core": { "SANDBOX_BACKEND": "render", "DEPLOY_PROVIDER": "render", "SNAPSHOT_STORE": "s3", "TRANSFER_STORE": "s3" }, "slack": { "SLACK_IDENTITY_EMAIL": "1" }, "auth": { "AUTH_EMAIL_TRANSPORT": ${JSON.stringify(emailTransport)} } }`,
      secretEnv: `,

  // The initial admin seed is kept in the provider secret store, never in config.
  "secretEnv": { "core": { "ADMIN_GRANTS": "ADMIN_GRANTS" } }`,
      sandbox: `,

  // Agent computers run as native Render Sandboxes in this workspace.
  "sandbox": { "backend": "render" }`,
    }),
  ignores: [
    ".env",
    "node_modules/",
    ".generated/",
    ".render.lock/",
    ".render.lock-*/",
    "render.resources.json",
    "render.resources.json.tmp",
  ],
  agentsAppendix: `
## Render deployment

Render builds QM services from render.source in Git; no local Docker or image
publication is involved. qm up creates one project with a production environment
for core, web UI, portal, Render Postgres, and bundled MinIO, then
uploads the deployment layer. Later qm up runs retain the selected MinIO
source commit. Use qm up --upgrade-minio to upgrade MinIO explicitly.
Native Render Sandboxes are workspace resources.
Each published app has a persistent disk at /data and uses SQLite at
/data/app.db. Litestream backs up the SQLite file to scoped object storage.
App updates stop the old process before the new process starts. qm down
retains Postgres and MinIO data, and qm rollback restores the prior QM service
builds without reversing database migrations.

.codex/skills/deploy-qm/references/render.md is the Render reference: setup,
configuration keys, commands, and the agent-computer proof.
`,
  files: () => [
    {
      segments: ["sandbox", "skills", "render-platform", "SKILL.md"],
      content: `---
name: render-platform
description: Build and publish apps on this QM Render deployment. Use with the publish skill when an app needs persistent data, background work, or a deployment update.
---
Use the built-in deployment tools to publish, update, archive, and restore apps.
The platform creates app services in this deployment's Render project,
each with one persistent disk in its own network-isolated environment.
Each update stops the old process before the new process starts. Listen on PORT, bind the server to 0.0.0.0, and
bind only after initialization succeeds. Handle SIGTERM to stop new work and
finish current requests. Core proxies app traffic through an authenticated
gateway; other apps cannot connect to the app port.

Use SQLite at DATA_DIR/app.db for relational data. DATA_DIR is /data on the
persistent disk. Litestream continuously backs up this SQLite database to the app's
object prefix and restores it before startup only when the local SQLite file is
missing. Use WAL mode and a busy timeout. Other paths are not backed
up by Litestream. Backups are asynchronous; a disk loss can lose recent writes.
Run schema changes before the server starts. A rollback restores code only,
so schema changes must work with the previous and the new code.

Use an S3 client for files with AWS_ENDPOINT_URL_S3, AWS_REGION,
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET, and S3_PREFIX from the
environment. Enable path-style requests and prepend S3_PREFIX to every object
key and list prefix; the credentials reach only that prefix. Keep
AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED, which QM sets to avoid checksum
trailers on streaming uploads. For the AWS SDK for JavaScript, set endpoint,
region, forcePathStyle: true, and requestChecksumCalculation: "WHEN_REQUIRED"
on S3Client.

Files under /data survive deploys and archive or restore. Files outside /data
are temporary. Only /data/app.db has a Litestream backup; store other durable
files in object storage before you return their links.
Keep app credentials inside the app environment and never send them to a
browser. Never give an app the Render API key, the core database URL, or MinIO
administrator credentials.

Apps build from an immutable QM Git commit. Keep dependency installation in the
entrypoint when the app needs packages. Update an app by its existing name.
Archive suspends the service and revokes its source access. Restore resumes the
same service with new source access, repaired storage access, its retained disk,
and its object prefix.
Verify a record and an object after create, update, rollback, and archive or restore.

The agent executes in native Render Sandboxes. Save useful workspace changes
before an operation that replaces a sandbox. Sandboxes are workspace resources;
App services and MinIO belong to this deployment's project.
Do not create infrastructure outside that project or change DNS or Cloudflare rules.
`,
    },
  ],
  configurationHint: "render: set workspaceId, region, and the email access gate before setup",
  finalCommand: "npm exec qm -- up",
  finalWhy: "provision Render services and upload the QM deployment layer",
};
