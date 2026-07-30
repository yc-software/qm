import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertAwsDeploymentStorage,
  assertAwsPublicListener,
  assertGithubDeployTrust,
  awsCheckLive,
  awsDown,
  awsLogs,
  awsPinSandbox,
  awsRollback,
  awsSecretsPush,
  awsStatus,
  awsUp,
  githubTrustSubject,
  imageTransferArgs,
  isPinnedWorkloadImage,
  probeAwsSecretStore,
  renderTaskDefinition,
  serviceEnvironment,
  taskDefinitionChanges,
  taskDefinitionDiff,
} from "../src/backends/aws.ts";
import type { QmConfig } from "../src/config.ts";
import { computedSecrets } from "../src/secrets.ts";
import { awsObjectStoreBucket } from "../src/terraform.ts";
import { withAwsLease } from "../src/aws-lease.ts";
import { manifestRef } from "../src/manifest.ts";

process.env.QM_AWS_ROLLOUT_POLL_MS = "5";
process.env.QM_AWS_LIVE_PROBE_POLL_MS = "5";
process.env.QM_AWS_LIVE_PROBE_DEADLINE_MS = "20";
process.env.QM_AWS_DB_SNAPSHOT_POLL_MS = "5";

const EMPTY_LAYER_BODY = JSON.stringify({ contract: 1, tools: [], skills: [] });
const EMPTY_LAYER = {
  key: "deployment/layers/empty.json",
  sha256: createHash("sha256").update(EMPTY_LAYER_BODY).digest("hex"),
};
const TEST_SECRET_VALUE = "test-secret-value".repeat(3);

function fakeAws(
  dir: string,
  script: string,
  frontService: "core" | "portal" = "portal",
  ingress: { coreHosts?: string[]; targetGroups?: Partial<Record<"core" | "portal", string>> } = {},
): { log: string; restore: () => void } {
  const bin = join(dir, "aws-fake");
  const log = join(dir, "aws.log");
  const tgName = (name: "core" | "portal"): string =>
    ingress.targetGroups?.[name] ??
    `acme-qm-${name.replaceAll("-", "").slice(0, 4)}-${createHash("sha1").update(`acme-qm:${name}`).digest("hex").slice(0, 6)}`;
  const tgArn = (name: "core" | "portal"): string =>
    `arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/${tgName(name)}/1`;
  const targetName = tgName(frontService);
  const targetArn = tgArn(frontService);
  const coreHosts = frontService === "portal" ? (ingress.coreHosts ?? []) : [];
  const groups = [
    { TargetGroupArn: targetArn, TargetGroupName: targetName },
    ...(coreHosts.length ? [{ TargetGroupArn: tgArn("core"), TargetGroupName: tgName("core") }] : []),
  ];
  const baseRules =
    frontService === "portal"
      ? coreHosts.map((host) => ({
          IsDefault: false,
          Actions: [{ Type: "forward", TargetGroupArn: tgArn("core") }],
          Conditions: [{ Field: "host-header", HostHeaderConfig: { Values: [host] } }],
        }))
      : [
          {
            IsDefault: false,
            Actions: [{ Type: "forward", TargetGroupArn: targetArn }],
            Conditions: [{ Field: "path-pattern", PathPatternConfig: { Values: ["/v1/*"] } }],
          },
        ];
  writeFileSync(log, "");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2).join(" ");
fs.appendFileSync(${JSON.stringify(log)}, a + "\\n");
if (a.includes("sts get-caller-identity")) console.log(process.env.AWS_FAKE_ACCOUNT || "123456789012");
else if (a.includes("lambda-microvms get-microvm-image")) {
  const args = process.argv.slice(2);
  const id = args[args.indexOf("--image-identifier") + 1];
  const imageArn = id.startsWith("arn:") ? id : "arn:aws:lambda:us-west-2:123456789012:microvm-image:" + id;
  console.log(JSON.stringify({ imageArn }));
}
else if (a.includes("lambda-microvms list-microvm-image-versions")) console.log(JSON.stringify({ items: [{ imageVersion: process.env.AWS_FAKE_IMAGE_VERSION || "1", state: process.env.AWS_FAKE_IMAGE_STATE || "SUCCESSFUL", status: process.env.AWS_FAKE_IMAGE_STATUS || "ACTIVE" }] }));
else if (a.includes("elbv2 describe-load-balancers")) console.log(JSON.stringify({ LoadBalancers: [{ LoadBalancerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/test/1", DNSName: process.env.AWS_FAKE_ALB_DNS || "agent.acme.example", State: { Code: "active" } }] }));
else if (a.includes("elbv2 describe-listeners")) {
  const protocol = process.env.AWS_FAKE_LISTENER_PROTOCOL || "HTTPS";
  const defaults = process.env.AWS_FAKE_DEFAULT_FORWARD === "1" ? [{ Type: "forward", TargetGroupArn: ${JSON.stringify(targetArn)} }] : ${frontService === "portal" ? JSON.stringify([{ Type: "forward", TargetGroupArn: targetArn }]) : JSON.stringify([{ Type: "fixed-response", FixedResponseConfig: { StatusCode: "404" } }])};
  const listeners = [{ ListenerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:listener/app/test/1/2", Protocol: protocol, Port: protocol === "HTTPS" ? 443 : 80, Certificates: protocol === "HTTPS" ? [{ CertificateArn: "arn:aws:acm:us-west-2:123456789012:certificate/test" }] : [], DefaultActions: defaults }];
  if (process.env.AWS_FAKE_EXTRA_HTTP_LISTENER === "redirect") listeners.push({ ListenerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:listener/app/test/1/3", Protocol: "HTTP", Port: 80, Certificates: [], DefaultActions: [{ Type: "redirect", RedirectConfig: { Protocol: "HTTPS", Port: "443", StatusCode: "HTTP_301" } }] });
  if (process.env.AWS_FAKE_EXTRA_HTTP_LISTENER === "forward") listeners.push({ ListenerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:listener/app/test/1/3", Protocol: "HTTP", Port: 80, Certificates: [], DefaultActions: [{ Type: "forward", TargetGroupArn: ${JSON.stringify(targetArn)} }] });
  console.log(JSON.stringify({ Listeners: listeners }));
}
else if (a.includes("elbv2 describe-target-groups")) console.log(JSON.stringify({ TargetGroups: ${JSON.stringify(groups)} }));
else if (a.includes("elbv2 describe-rules")) {
  const rules = process.env.AWS_FAKE_NO_CORE_RULE === "1" ? [] : ${JSON.stringify(baseRules)};
  if (process.env.AWS_FAKE_WRONG_RULE_TARGET === "1") for (const rule of rules) rule.Actions[0].TargetGroupArn = ${JSON.stringify(targetArn)};
  if (rules[0] && process.env.AWS_FAKE_WRONG_RULE_HOST === "1" && rules[0].Conditions[0].HostHeaderConfig) rules[0].Conditions[0].HostHeaderConfig.Values = ["other.example"];
  if (rules[0] && process.env.AWS_FAKE_EXTRA_ACTION === "1") rules[0].Actions.push({ Type: "authenticate-oidc" });
  if (rules[0] && process.env.AWS_FAKE_EXTRA_CONDITION === "1") rules[0].Conditions.push({ Field: "host-header", HostHeaderConfig: { Values: ["other.example"] } });
  if (process.env.AWS_FAKE_EXTRA_RULE === "1") rules.push({ IsDefault: false, Actions: [{ Type: "fixed-response", FixedResponseConfig: { StatusCode: "503" } }], Conditions: [{ Field: "path-pattern", PathPatternConfig: { Values: ["/v1/*"] } }] });
  console.log(JSON.stringify({ Rules: rules }));
}
else if (a.includes("elbv2 describe-target-health")) console.log(JSON.stringify({ TargetHealthDescriptions: [{ TargetHealth: { State: process.env.AWS_FAKE_UNHEALTHY_TARGET === "1" ? "unhealthy" : "healthy" } }] }));
else {
${script}
}
`,
  );
  chmodSync(bin, 0o755);
  const prior = process.env.AWS_BIN;
  const priorFetch = globalThis.fetch;
  process.env.AWS_BIN = bin;
  globalThis.fetch = async () => new Response("", { status: Number(process.env.AWS_FAKE_HTTP_STATUS ?? 404) });
  return {
    log,
    restore: () => {
      if (prior === undefined) delete process.env.AWS_BIN;
      else process.env.AWS_BIN = prior;
      globalThis.fetch = priorFetch;
    },
  };
}

function statefulAws(
  dir: string,
  configured: QmConfig,
  initialDynamo: Record<string, Record<string, { S: string }>> = {},
  opts: {
    failDescribe?: boolean;
    failDescribeOnceAfterUpdate?: boolean;
    ignoreUpdate?: boolean;
    failFirstUpdateAfterMutation?: boolean;
    failForcedDeploymentResponse?: boolean;
    failTransactions?: boolean;
    failTransactionPuts?: number;
    failPromotion?: boolean;
    promotionAlreadyCurrent?: boolean;
    drainRollout?: boolean;
    primaryFailedTasks?: boolean;
    rolloutFailed?: boolean;
    transientFailedTaskPolls?: number;
    alternateStaleReadPolls?: number;
    foreignServiceTags?: boolean;
    snapshotStatus?: string;
    snapshotCreatingPolls?: number;
    failSnapshotDescribes?: number;
    failSnapshotDelete?: boolean;
  } = {},
): {
  log: string;
  state: string;
  restore: () => void;
} {
  const state = join(dir, "aws-state.json");
  const frontService = configured.aws!.services.portal ? "portal" : "core";
  const coreHosts: string[] = [];
  if (frontService === "portal") {
    const api = configured.apiUrl;
    if (api && URL.canParse(api)) {
      const host = new URL(api).hostname.toLowerCase().replace(/\.$/, "");
      if (host !== new URL(configured.publicUrl).hostname.toLowerCase()) coreHosts.push(host);
    }
    const apps = configured.env.core?.AWS_DEPLOY_APPS_DOMAIN;
    if (apps) coreHosts.push(`*.${apps.toLowerCase().replace(/\.$/, "")}`);
  }
  const targetGroups = Object.fromEntries(
    (["core", "portal"] as const).flatMap((name) => {
      const pinned = configured.aws!.services[name]?.targetGroup;
      return pinned ? [[name, pinned]] : [];
    }),
  );
  const tgName = (name: "core" | "portal"): string =>
    targetGroups[name] ??
    `acme-qm-${name.replaceAll("-", "").slice(0, 4)}-${createHash("sha1").update(`acme-qm:${name}`).digest("hex").slice(0, 6)}`;
  const frontTargetArn = `arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/${tgName(frontService)}/1`;
  const coreTargetArn = `arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/${tgName("core")}/1`;
  const services = Object.fromEntries(
    Object.entries(configured.aws!.services).map(([name, spec]) => [
      spec.ecsService,
      {
        workload: name,
        taskDefinition: `arn:aws:ecs:us-west-2:123456789012:task-definition/${spec.ecsService}:1`,
        desiredCount: 1,
        deploymentId: `ecs-svc/${spec.ecsService}-initial`,
      },
    ]),
  );
  writeFileSync(
    state,
    JSON.stringify({
      services,
      definitions: {},
      dynamo: initialDynamo,
      objects: { [EMPTY_LAYER.key]: EMPTY_LAYER_BODY },
      rdsSnapshots: [],
      revision: 1,
    }),
  );
  const fake = fakeAws(
    dir,
    `
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(state)};
const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(s));
const after = (flag) => args[args.indexOf(flag) + 1];
if (a.includes("secretsmanager get-secret-value") && !a.includes("--query")) console.log(JSON.stringify({ ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf", SecretString: a.includes("PUBLIC_API_URL") ? (process.env.AWS_FAKE_PUBLIC_API_URL || ${JSON.stringify(configured.apiUrl ?? configured.publicUrl)}) : (a.includes("CORE_SIGNING_SECRET") && process.env.AWS_FAKE_SECRET_VALUE || ${JSON.stringify(TEST_SECRET_VALUE)}) }));
else if (a.includes("secretsmanager get-secret-value") && a.includes("--query SecretString")) console.log(a.includes("PUBLIC_API_URL") ? (process.env.AWS_FAKE_PUBLIC_API_URL || ${JSON.stringify(configured.apiUrl ?? configured.publicUrl)}) : (a.includes("CORE_SIGNING_SECRET") && process.env.AWS_FAKE_SECRET_VALUE || ${JSON.stringify(TEST_SECRET_VALUE)}));
else if (a.includes("secretsmanager get-secret-value") && a.includes("--query ARN")) console.log("arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf");
else if (a.includes("ecr get-login-password")) console.log("pw");
else if (a.includes("ecr batch-get-image")) console.log(JSON.stringify({ images: [{ imageManifest: "{}", imageManifestMediaType: "application/vnd.oci.image.index.v1+json" }] }));
else if (a.includes("ecr put-image") && ${JSON.stringify(opts.failPromotion ?? false)}) { console.error("PutImageFailure"); process.exit(1); }
else if (a.includes("ecr put-image") && ${JSON.stringify(opts.promotionAlreadyCurrent ?? false)}) { console.error("ImageAlreadyExistsException"); process.exit(1); }
else if (a.includes("ecr put-image")) console.log(JSON.stringify({ image: { imageId: { imageDigest: "sha256:${"a".repeat(64)}" } } }));
else if (a.includes("ecr describe-images")) console.log(JSON.stringify({ imageDetails: [{ imageDigest: "sha256:${"a".repeat(64)}" }] }));
else if (a.includes("ecs describe-services") && ${JSON.stringify(opts.failDescribe ?? false)}) { console.error("DescribeServicesFailure"); process.exit(1); }
else if (a.includes("ecs describe-services") && ${JSON.stringify(opts.failDescribeOnceAfterUpdate ?? false)} && s.updated && !s.describeFailedOnce) {
  s.describeFailedOnce = true;
  save();
  console.error("TransientDescribeFailure");
  process.exit(1);
}
else if (a.includes("ecs describe-services")) {
  const start = args.indexOf("--services") + 1;
  const end = Math.min(...[args.indexOf("--output", start), args.indexOf("--region", start)].filter((index) => index >= 0));
  const names = args.slice(start, end);
  const transientFailedTaskPolls = ${JSON.stringify(opts.transientFailedTaskPolls ?? 0)};
  let transientlyFailing = false;
  if (transientFailedTaskPolls && s.updated) {
    s.failedTaskPolls = (s.failedTaskPolls || 0) + 1;
    save();
    transientlyFailing = s.failedTaskPolls <= transientFailedTaskPolls;
  }
  const alternateStaleReadPolls = ${JSON.stringify(opts.alternateStaleReadPolls ?? 0)};
  let staleName = null;
  if (alternateStaleReadPolls && s.updated) {
    s.stalePolls = (s.stalePolls || 0) + 1;
    save();
    if (s.stalePolls <= alternateStaleReadPolls) staleName = names[s.stalePolls % names.length];
  }
  console.log(JSON.stringify({ services: names.flatMap((name) => {
    const service = s.services[name];
    if (!service) return [];
    if (name === staleName && service.previousTaskDefinition) {
      return [{ serviceName: name, status: "ACTIVE", desiredCount: service.desiredCount, runningCount: service.desiredCount, taskDefinition: service.previousTaskDefinition, deployments: [{ id: service.deploymentId, status: "PRIMARY", taskDefinition: service.previousTaskDefinition, rolloutState: "COMPLETED", runningCount: service.desiredCount, failedTasks: 0 }], tags: [{ key: "Deployment", value: ${JSON.stringify(opts.foreignServiceTags ? "other" : configured.orgId)} }, { key: "ManagedBy", value: "terraform" }] }];
    }
    const deployments = ${JSON.stringify(opts.drainRollout ?? false)}
      ? [
          { id: service.deploymentId, status: "PRIMARY", taskDefinition: service.taskDefinition, rolloutState: "IN_PROGRESS", runningCount: service.desiredCount, failedTasks: 1 },
          { id: "old-protected", status: "ACTIVE", taskDefinition: service.taskDefinition, rolloutState: "COMPLETED", runningCount: 1, failedTasks: 0 },
        ]
      : ${JSON.stringify(opts.rolloutFailed ?? false)}
        ? [{ id: service.deploymentId, status: "PRIMARY", taskDefinition: service.taskDefinition, rolloutState: "FAILED", runningCount: 0, failedTasks: 1 }]
      : ${JSON.stringify(opts.primaryFailedTasks ?? false)} || transientlyFailing
        ? [{ id: service.deploymentId, status: "PRIMARY", taskDefinition: service.taskDefinition, rolloutState: "IN_PROGRESS", runningCount: 0, failedTasks: 1 }]
        : [{ id: service.deploymentId, status: "PRIMARY", taskDefinition: service.taskDefinition, rolloutState: "COMPLETED", runningCount: service.desiredCount, failedTasks: transientFailedTaskPolls && s.updated ? 1 : 0 }];
    return [{ serviceName: name, status: "ACTIVE", desiredCount: service.desiredCount, runningCount: ${JSON.stringify(opts.drainRollout ?? false)} ? service.desiredCount + 1 : service.desiredCount, taskDefinition: service.taskDefinition, deployments, loadBalancers: service.workload === ${JSON.stringify(frontService)} ? [{ targetGroupArn: ${JSON.stringify(frontTargetArn)} }] : (service.workload === "core" && ${JSON.stringify(coreHosts.length > 0)} ? [{ targetGroupArn: ${JSON.stringify(coreTargetArn)} }] : []), tags: [{ key: "Deployment", value: ${JSON.stringify(opts.foreignServiceTags ? "other" : configured.orgId)} }, { key: "ManagedBy", value: "terraform" }] }];
  }), failures: names.filter((name) => !s.services[name]).map((name) => ({ arn: name, reason: "MISSING" })) }));
}
else if (a.includes("ecs describe-task-definition")) {
  const id = after("--task-definition");
  console.log(JSON.stringify({ taskDefinition: s.definitions[id] }));
}
else if (a.includes("ecs register-task-definition")) {
  const file = after("--cli-input-json").slice("file://".length);
  const definition = JSON.parse(fs.readFileSync(file, "utf8"));
  const arn = "arn:aws:ecs:us-west-2:123456789012:task-definition/" + definition.family + ":" + (++s.revision);
  definition.taskDefinitionArn = arn;
  s.definitions[arn] = definition;
  save();
  console.log(arn);
}
else if (a.includes("ecs update-service")) {
  const name = after("--service");
  const service = s.services[name];
  if (!service) process.exit(4);
  service.previousTaskDefinition = service.taskDefinition;
  if (!${JSON.stringify(opts.ignoreUpdate ?? false)} && args.includes("--task-definition")) service.taskDefinition = after("--task-definition");
  if (!${JSON.stringify(opts.ignoreUpdate ?? false)} && args.includes("--desired-count")) service.desiredCount = Number(after("--desired-count"));
  if (!${JSON.stringify(opts.ignoreUpdate ?? false)}) service.deploymentId = "ecs-svc/" + name + "-" + (++s.revision);
  s.updated = true;
  if (${JSON.stringify(opts.failFirstUpdateAfterMutation ?? false)} && !s.failedFirstUpdate) {
    s.failedFirstUpdate = true;
    save();
    console.error("UpdateServiceResponseLost");
    process.exit(1);
  }
  save();
  if (${JSON.stringify(opts.failForcedDeploymentResponse ?? false)} && args.includes("--force-new-deployment")) {
    console.log(JSON.stringify({ service: { deployments: [] } }));
    process.exit(0);
  }
  console.log(JSON.stringify({ service: { deployments: [{ id: service.deploymentId, status: "PRIMARY", taskDefinition: service.taskDefinition, rolloutState: "IN_PROGRESS" }] } }));
}
else if (a.includes("dynamodb get-item")) {
  const key = JSON.parse(after("--key")).lockKey.S;
  console.log(JSON.stringify(s.dynamo[key] ? { Item: s.dynamo[key] } : {}));
}
else if (a.includes("dynamodb transact-write-items")) {
  if (${JSON.stringify(opts.failTransactions ?? false)}) { console.error("TransactionRejected"); process.exit(1); }
  const failTransactionPuts = ${JSON.stringify(opts.failTransactionPuts ?? 0)};
  if (failTransactionPuts) {
    s.transactAttempts = (s.transactAttempts || 0) + 1;
    save();
    if (s.transactAttempts <= failTransactionPuts) { console.error("TransactionRejected"); process.exit(1); }
  }
  for (const write of JSON.parse(after("--transact-items"))) if (write.Put) s.dynamo[write.Put.Item.lockKey.S] = write.Put.Item;
  save();
  console.log("");
}
else if (a.includes("s3api put-object")) {
  s.objects[after("--key")] = fs.readFileSync(after("--body"), "utf8");
  save();
  console.log("");
}
else if (a.includes("s3api get-object")) {
  const body = s.objects[after("--key")];
  if (body === undefined) process.exit(5);
  const output = args[args.indexOf("--key") + 2];
  fs.writeFileSync(output, body);
  console.log("");
}
else if (a.includes("rds describe-db-instances")) console.log(JSON.stringify({ DBInstances: [{ DBInstanceStatus: process.env.AWS_FAKE_DB_STATUS ?? "available", BackupRetentionPeriod: Number(process.env.AWS_FAKE_DB_RETENTION ?? "7") }] }));
else if (a.includes("rds create-db-snapshot")) {
  s.rdsSnapshots = s.rdsSnapshots || [];
  s.rdsSnapshots.push({ DBSnapshotIdentifier: after("--db-snapshot-identifier"), Status: ${JSON.stringify(opts.snapshotStatus ?? "available")}, SnapshotCreateTime: new Date(1700000000000 + s.rdsSnapshots.length * 1000).toISOString(), TagList: JSON.parse(after("--tags")) });
  save();
  console.log("");
}
else if (a.includes("rds describe-db-snapshots") && a.includes("--db-snapshot-identifier")) {
  const failDescribes = ${JSON.stringify(opts.failSnapshotDescribes ?? 0)};
  if (failDescribes) {
    s.snapshotDescribeFailures = (s.snapshotDescribeFailures || 0) + 1;
    save();
    if (s.snapshotDescribeFailures <= failDescribes) { console.error("TransientSnapshotDescribeFailure"); process.exit(1); }
  }
  const found = (s.rdsSnapshots || []).filter((item) => item.DBSnapshotIdentifier === after("--db-snapshot-identifier"));
  const creatingPolls = ${JSON.stringify(opts.snapshotCreatingPolls ?? 0)};
  if (creatingPolls) {
    s.snapshotPolls = (s.snapshotPolls || 0) + 1;
    save();
    if (s.snapshotPolls <= creatingPolls) for (const item of found) item.Status = "creating";
  }
  console.log(JSON.stringify({ DBSnapshots: found }));
}
else if (a.includes("rds describe-db-snapshots")) console.log(JSON.stringify({ DBSnapshots: s.rdsSnapshots || [] }));
else if (a.includes("rds delete-db-snapshot") && ${JSON.stringify(opts.failSnapshotDelete ?? false)}) { console.error("SnapshotDeleteDenied"); process.exit(1); }
else if (a.includes("rds delete-db-snapshot")) {
  s.rdsSnapshots = (s.rdsSnapshots || []).filter((item) => item.DBSnapshotIdentifier !== after("--db-snapshot-identifier"));
  save();
  console.log("");
}
else console.log("");`,
    frontService,
    { coreHosts, targetGroups },
  );
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = String(init.body ?? "");
      const contentHash = createHash("sha256").update(body).digest("hex");
      return new Response(JSON.stringify({ version: 1, contentHash, durable: true, status: "applied" }), {
        status: 200,
      });
    }
    if (!String(input).includes("/v1/deployment-layer"))
      return new Response("", { status: Number(process.env.AWS_FAKE_HTTP_STATUS ?? 200) });
    return new Response(
      JSON.stringify({
        bundle: JSON.parse(EMPTY_LAYER_BODY),
        contentHash: EMPTY_LAYER.sha256,
        runtimeContentHash: EMPTY_LAYER.sha256,
        status: "applied",
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { ...fake, state };
}

const config: QmConfig = {
  contract: 1,
  orgId: "acme",
  publicUrl: "https://agent.acme.example",
  target: "aws",
  services: ["core", "slack", "web-ui", "admin", "portal"],
  plugins: [],
  skills: [],
  imageOverrides: {},
  sandbox: {
    backend: "sprites",
    app: "acme-sandboxes",
    image: `registry.fly.io/acme-sandboxes@sha256:${"b".repeat(64)}`,
    secretEnv: ["ACME_API_KEY"],
  },
  env: {
    core: { HARNESS: "pi", AWS_DEPLOY_IMAGE: "acme-qm-sandbox", AWS_DEPLOY_IMAGE_VERSION: "1" },
    admin: { ADMIN_BASE_PATH: "/admin" },
    portal: { OIDC_CLIENT_ID: "client", PORTAL_EXPECTED_TEAM_ID: "T1" },
  },
  aws: {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme-qm",
    deployRoleArn: "arn:aws:iam::123456789012:role/acme-deploy",
    imageLabel: "release",
    secretsPrefix: "acme/qm/",
    networking: { cloudMapNamespace: "acme.internal" },
    services: Object.fromEntries(
      ["core", "web-ui", "admin", "portal"].map((name) => [
        name,
        {
          ecrRepository: `qm-${name}`,
          ecsService: `acme-${name}`,
          cpu: name === "core" ? 2048 : 512,
          memory: name === "core" ? 4096 : 1024,
        },
      ]),
    ),
  },
};

test("AWS environment derives identity, public URLs, private wiring, and MicroVM coordinates", () => {
  assert.deepEqual(serviceEnvironment(config, "web-ui"), {
    CORE_API_URL: "http://core.acme.internal:8080",
    CORE_ORG_ID: "acme",
    PORT: "8080",
    REQUIRE_SIGNED_PORTAL_IDENTITY: "1",
    WEB_UI_PUBLIC_URL: "https://agent.acme.example",
  });
  const core = serviceEnvironment(config, "core");
  assert.equal(core.ORG_ID, "acme");
  assert.equal(core.PUBLIC_WEB_URL, "https://agent.acme.example");
  assert.equal(core.WEB_UI_PUBLIC_URL, "https://agent.acme.example");
  assert.equal(core.SANDBOX_BACKEND, "sprites");
  assert.equal(core.FLY_SANDBOX_APP_NAME, "acme-sandboxes");
  assert.equal(core.FLY_BASE_IMAGE, config.sandbox!.image);
  assert.equal(core.AWS_SANDBOX_IMAGE, undefined);
  const { sandbox: _sandbox, ...rest } = config;
  const microvm = serviceEnvironment(rest as QmConfig, "core");
  assert.equal(microvm.SANDBOX_BACKEND, "aws");
  assert.equal(microvm.AWS_SANDBOX_REGION, "us-west-2");
  assert.equal(microvm.AWS_SANDBOX_IMAGE, "acme-qm-sandbox");
  assert.equal(microvm.AWS_SANDBOX_IMAGE_VERSION, "1");
  assert.equal(microvm.AWS_SANDBOX_EXEC_ROLE_ARN, "arn:aws:iam::123456789012:role/acme-qm-microvm-exec");
  assert.equal(microvm.AWS_SANDBOX_S3_BUCKET, awsObjectStoreBucket(config));
  assert.equal(microvm.FLY_BASE_IMAGE, undefined);
  assert.equal(microvm.FLY_SANDBOX_APP_NAME, undefined);
  assert.equal(core.SESSION_STORE, "postgres");
  assert.equal(core.RUN_STORE, "postgres");
  assert.equal(core.SNAPSHOT_STORE, "s3");
  assert.equal(core.TRANSFER_STORE, "s3");
  assert.equal(core.S3_REGION, "us-west-2");
  assert.equal(core.DEPLOY_PROVIDER, "aws");
  assert.equal(core.AWS_DEPLOY_REGION, "us-west-2");
  assert.equal(core.PORT, "8080");
});

test("AWS routes security screen proxy configuration and its token only to core", () => {
  const screened: QmConfig = {
    ...config,
    securityScreen: {
      backend: "proxy",
      provider: "example-screen",
      endpoint: "https://screen.example.test/classify",
      rollout: "enforce",
    },
    secretEnv: { core: { SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN" } },
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(serviceEnvironment(screened, "core")).filter(([name]) => name.startsWith("SECURITY_SCREEN_")),
    ),
    {
      SECURITY_SCREEN_BACKEND: "proxy",
      SECURITY_SCREEN_PROXY_ENDPOINT: "https://screen.example.test/classify",
      SECURITY_SCREEN_PROXY_PROVIDER: "example-screen",
      SECURITY_SCREEN_PROXY_ROLLOUT: "enforce",
    },
  );
  assert.deepEqual(
    Object.keys(serviceEnvironment(screened, "web-ui")).filter((name) => name.startsWith("SECURITY_SCREEN_")),
    [],
  );
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const task = renderTaskDefinition(screened, "core", image, { EXAMPLE_SCREEN_TOKEN: "arn:example-screen-token" });
  assert.deepEqual(
    (task.containerDefinitions[0]!.secrets as Array<{ name: string; valueFrom: string }>).filter(({ name }) =>
      name.startsWith("SECURITY_SCREEN_"),
    ),
    [{ name: "SECURITY_SCREEN_PROXY_TOKEN", valueFrom: "arn:example-screen-token" }],
  );
});

test("AWS fixes every workload listen port to its ECS port mapping", () => {
  const configured: QmConfig = {
    ...config,
    env: {
      ...config.env,
      core: { ...config.env.core, PORT: "9000" },
      "web-ui": { PORT: "9001" },
      admin: { ...config.env.admin, PORT: "9002" },
      portal: { ...config.env.portal, PORT: "9003" },
    },
  };
  for (const service of ["core", "web-ui", "admin", "portal"] as const) {
    const def = configured.aws!.services[service]!;
    const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/${def.ecrRepository}@sha256:${"a".repeat(64)}`;
    const task = renderTaskDefinition(configured, service, image);
    const container = task.containerDefinitions[0]!;
    const environment = Object.fromEntries(
      (container.environment as Array<{ name: string; value: string }>).map(({ name, value }) => [name, value]),
    );
    assert.equal(environment.PORT, "8080");
    assert.deepEqual(container.portMappings, [{ containerPort: 8080, hostPort: 8080, protocol: "tcp" }]);
  }
});

test("AWS core receives the configured model and virtual-service environment", () => {
  const configured: QmConfig = {
    ...config,
    model: "anthropic/claude-sonnet-4-5",
    env: {
      ...config.env,
      slack: { SLACK_EVENTS_MODE: "http", SHARED_SETTING: "slack" },
      core: { ...config.env.core, SHARED_SETTING: "core" },
    },
  };
  const core = serviceEnvironment(configured, "core");
  assert.equal(core.PI_MODEL, "anthropic/claude-sonnet-4-5");
  assert.equal(core.SLACK_EVENTS_MODE, "http");
  assert.equal(core.SHARED_SETTING, "core");
});

test("AWS required runtime settings cannot be overridden by config env", () => {
  const overridden: QmConfig = {
    ...config,
    env: {
      ...config.env,
      core: {
        ...config.env.core,
        SESSION_STORE: "memory",
        RUN_STORE: "memory",
        FLY_BASE_IMAGE: "repo:latest",
      },
    },
  };
  const core = serviceEnvironment(overridden, "core");
  assert.equal(core.SESSION_STORE, "postgres");
  assert.equal(core.RUN_STORE, "postgres");
  assert.equal(core.SANDBOX_BACKEND, "sprites");
  assert.equal(core.FLY_BASE_IMAGE, config.sandbox!.image);
  const { sandbox: _sandbox, ...rest } = overridden;
  const microvm = serviceEnvironment(rest as QmConfig, "core");
  assert.equal(microvm.SESSION_STORE, "postgres");
  assert.equal(microvm.SANDBOX_BACKEND, "aws");
  assert.equal(microvm.FLY_BASE_IMAGE, undefined);
});

test("AWS deploy-role trust permits only the exact repository branch", () => {
  const subject = "repo:acme/deploy:ref:refs/heads/main";
  const exact = [
    {
      Effect: "Allow",
      Principal: { Federated: "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": subject,
        },
      },
    },
  ];
  assert.doesNotThrow(() => assertGithubDeployTrust(exact, "123456789012", subject));
  assert.throws(
    () =>
      assertGithubDeployTrust(
        [
          ...exact,
          { ...exact[0], Condition: { StringLike: { "token.actions.githubusercontent.com:sub": "repo:acme/*" } } },
        ],
        "123456789012",
        subject,
      ),
    /exactly one/,
  );
  assert.throws(
    () =>
      assertGithubDeployTrust(
        [{ ...exact[0], Condition: { StringLike: { "token.actions.githubusercontent.com:sub": "repo:acme/*" } } }],
        "123456789012",
        subject,
      ),
    /must pin audience/,
  );
  const pinnedElsewhere = [
    {
      ...exact[0],
      Condition: {
        StringEquals: {
          ...exact[0]!.Condition.StringEquals,
          "token.actions.githubusercontent.com:sub": "repo:acme/deploy:ref:refs/heads/release",
        },
      },
    },
  ];
  assert.throws(
    () => assertGithubDeployTrust(pinnedElsewhere, "123456789012", subject),
    /including repo:acme\/deploy:ref:refs\/heads\/main \(live subject: repo:acme\/deploy:ref:refs\/heads\/release\)/,
  );
});

test("AWS deploy-role trust accepts a subject list that contains the expected subject", () => {
  const environmentSubject = "repo:acme/deploy:environment:production";
  const branchSubject = "repo:acme/deploy:ref:refs/heads/main";
  const withSubjects = (sub: unknown) => [
    {
      Effect: "Allow",
      Principal: { Federated: "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": sub,
        },
      },
    },
  ];

  for (const expected of [environmentSubject, branchSubject]) {
    assert.doesNotThrow(() =>
      assertGithubDeployTrust(withSubjects([environmentSubject, branchSubject]), "123456789012", expected),
    );
  }

  assert.throws(
    () => assertGithubDeployTrust(withSubjects([branchSubject]), "123456789012", environmentSubject),
    /including repo:acme\/deploy:environment:production \(live subject: repo:acme\/deploy:ref:refs\/heads\/main\)/,
  );
  assert.throws(
    () =>
      assertGithubDeployTrust(
        withSubjects([environmentSubject, "repo:evil/repo:ref:refs/heads/main"]),
        "123456789012",
        environmentSubject,
      ),
    /only repo:acme\/deploy:\* subjects/,
  );
  assert.throws(
    () =>
      assertGithubDeployTrust(
        withSubjects([environmentSubject, "repo:acme/deploy:*"]),
        "123456789012",
        environmentSubject,
      ),
    /only repo:acme\/deploy:\* subjects/,
  );
  assert.throws(
    () => assertGithubDeployTrust(withSubjects([]), "123456789012", environmentSubject),
    /\(live subject: missing\)/,
  );

  const idPinned = [
    "repo:acme@153323858/deploy@1253778415:environment:production",
    "repo:acme@153323858/deploy@1253778415:ref:refs/heads/main",
  ];
  for (const expected of [environmentSubject, branchSubject]) {
    assert.doesNotThrow(() => assertGithubDeployTrust(withSubjects(idPinned), "123456789012", expected));
  }
  assert.throws(
    () =>
      assertGithubDeployTrust(
        withSubjects(["repo:evil@153323858/deploy@1253778415:environment:production"]),
        "123456789012",
        environmentSubject,
      ),
    /only repo:acme\/deploy:\* subjects/,
  );
  assert.throws(
    () =>
      assertGithubDeployTrust(
        withSubjects(["repo:acme@153323858/deploy@1253778415:*"]),
        "123456789012",
        environmentSubject,
      ),
    /live subject: repo:acme@153323858\/deploy@1253778415:\*/,
  );
});

test("githubTrustSubject pins the deploy branch, never the working checkout's branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-trust-subject-"));
  const git = (...args: string[]): void => {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-b", "feature-checkout");
  git("remote", "add", "origin", "git@github.com:acme/qm.git");
  const priorRepo = process.env.GITHUB_REPOSITORY;
  const priorRef = process.env.GITHUB_REF;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_REF;
  try {
    assert.equal(
      githubTrustSubject(dir),
      "repo:acme/qm:ref:refs/heads/main",
      "a feature-branch checkout still expects the main-pinned trust",
    );
    assert.equal(
      githubTrustSubject(dir, "release"),
      "repo:acme/qm:ref:refs/heads/release",
      "aws.deployBranch overrides the default",
    );
    assert.equal(
      githubTrustSubject(dir, "release", "production"),
      "repo:acme/qm:environment:production",
      "a GitHub environment replaces the branch in the OIDC subject",
    );
    mkdirSync(join(dir, "infra"), { recursive: true });
    writeFileSync(
      join(dir, "infra", "terraform.tfvars"),
      'github_repository = "acme/vendored"\ngithub_ref = "refs/heads/deploy"\n',
    );
    assert.equal(
      githubTrustSubject(dir),
      "repo:acme/vendored:ref:refs/heads/deploy",
      "vendored infra declares its own pinned ref",
    );
    assert.equal(
      githubTrustSubject(dir, "main"),
      "repo:acme/vendored:ref:refs/heads/main",
      "an explicit deployBranch wins over tfvars",
    );
    process.env.GITHUB_REPOSITORY = "acme/from-actions";
    process.env.GITHUB_REF = "refs/heads/pr-branch";
    assert.equal(
      githubTrustSubject(dir),
      "repo:acme/from-actions:ref:refs/heads/deploy",
      "the workflow's own ref never shapes the expected trust",
    );
    writeFileSync(
      join(dir, "infra", "terraform.tfvars"),
      'github_repository = "acme/vendored"\ngithub_ref = "release"\n',
    );
    assert.throws(() => githubTrustSubject(dir), /github_ref must be a refs\/heads\/\* branch ref/);
  } finally {
    if (priorRepo === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = priorRepo;
    if (priorRef === undefined) delete process.env.GITHUB_REF;
    else process.env.GITHUB_REF = priorRef;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS doctor requires the public listener transport to match publicUrl", () => {
  const httpsListener = {
    ListenerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:listener/app/acme/123/456",
    Protocol: "HTTPS",
    Port: 443,
    Certificates: [{ CertificateArn: "arn:aws:acm:us-west-2:123456789012:certificate/abc" }],
  };
  const httpListener = { ...httpsListener, Protocol: "HTTP", Port: 80, Certificates: [] };

  assert.doesNotThrow(() => assertAwsPublicListener("https://agent.acme.example", httpsListener));
  assert.throws(() => assertAwsPublicListener("https://agent.acme.example", httpListener), /configure certificate_arn/);
  assert.throws(
    () => assertAwsPublicListener("https://agent.acme.example", { ...httpsListener, Certificates: [] }),
    /no certificate/,
  );
  assert.doesNotThrow(() => assertAwsPublicListener("http://agent.acme.example", httpListener));
  assert.throws(() => assertAwsPublicListener("http://agent.acme.example", httpsListener), /publicUrl is HTTP/);
});

test("AWS deploy refuses the HTTP bootstrap before any AWS mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-http-bootstrap-"));
  const fake = fakeAws(dir, `console.log("");`);
  try {
    await assert.rejects(
      () => awsUp({ ...config, publicUrl: "http://agent.acme.example" }, process.cwd(), { yes: true }),
      /requires an HTTPS publicUrl.*ACM certificate.*update publicUrl.*rerender\/apply Terraform/,
    );
    assert.equal(readFileSync(fake.log, "utf8"), "");
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS deploy requires the live ALB listener to match the HTTPS public URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-live-listener-"));
  const fake = fakeAws(dir, `console.log("");`);
  const prior = process.env.AWS_FAKE_LISTENER_PROTOCOL;
  process.env.AWS_FAKE_LISTENER_PROTOCOL = "HTTP";
  try {
    await assert.rejects(
      () => awsUp(config, process.cwd(), { yes: true }),
      /public front door is not ready.*listener is HTTP:80.*configure certificate_arn.*apply Terraform/,
    );
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /sts get-caller-identity/);
    assert.match(calls, /elbv2 describe-listeners/);
    assert.doesNotMatch(calls, /dynamodb put-item|ecr get-login-password|ecs update-service/);
  } finally {
    if (prior === undefined) delete process.env.AWS_FAKE_LISTENER_PROTOCOL;
    else process.env.AWS_FAKE_LISTENER_PROTOCOL = prior;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS deploy binds its public origin DNS to this stack's ALB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-dns-binding-"));
  const fake = statefulAws(dir, oneServiceConfig());
  const prior = process.env.AWS_FAKE_ALB_DNS;
  process.env.AWS_FAKE_ALB_DNS = "127.0.0.1";
  try {
    await assert.rejects(
      () => awsUp(oneServiceConfig(), dir, { yes: true }),
      /AWS public origin agent\.acme\.example does not resolve to this stack's ALB 127\.0\.0\.1/,
    );
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /dynamodb put-item|ecr get-login-password|ecs update-service/);
  } finally {
    if (prior === undefined) delete process.env.AWS_FAKE_ALB_DNS;
    else process.env.AWS_FAKE_ALB_DNS = prior;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS deploy requires the exact active successful MicroVM image version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-image-version-"));
  const fake = statefulAws(dir, oneServiceConfig());
  const prior = process.env.AWS_FAKE_IMAGE_STATE;
  process.env.AWS_FAKE_IMAGE_STATE = "FAILED";
  try {
    await assert.rejects(() => awsUp(oneServiceConfig(), dir, { yes: true }), /version 1 is not SUCCESSFUL and ACTIVE/);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(
      calls,
      /lambda-microvms get-microvm-image --image-identifier arn:aws:lambda:us-west-2:123456789012:microvm-image:acme-qm-sandbox/,
    );
    assert.match(
      calls,
      /lambda-microvms list-microvm-image-versions --image-identifier arn:aws:lambda:us-west-2:123456789012:microvm-image:acme-qm-sandbox/,
    );
    assert.doesNotMatch(calls, /dynamodb put-item|ecr get-login-password|ecs update-service/);
  } finally {
    if (prior === undefined) delete process.env.AWS_FAKE_IMAGE_STATE;
    else process.env.AWS_FAKE_IMAGE_STATE = prior;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS deploy requires the live core-only ALB to default 404 and expose exactly /v1/*", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-live-routing-"));
  const run = async (
    env:
      | "AWS_FAKE_DEFAULT_FORWARD"
      | "AWS_FAKE_NO_CORE_RULE"
      | "AWS_FAKE_EXTRA_ACTION"
      | "AWS_FAKE_EXTRA_CONDITION"
      | "AWS_FAKE_EXTRA_RULE",
    expected: RegExp,
  ): Promise<void> => {
    const fake = statefulAws(dir, oneServiceConfig());
    const prior = process.env[env];
    process.env[env] = "1";
    try {
      await assert.rejects(() => awsUp(oneServiceConfig(), dir, { yes: true }), expected);
      assert.doesNotMatch(
        readFileSync(fake.log, "utf8"),
        /dynamodb put-item|ecr get-login-password|ecs update-service/,
      );
    } finally {
      if (prior === undefined) delete process.env[env];
      else process.env[env] = prior;
      fake.restore();
    }
  };
  try {
    await run("AWS_FAKE_DEFAULT_FORWARD", /non-portal listener default must return a fixed 404 response/);
    await run("AWS_FAKE_NO_CORE_RULE", /non-portal ALB must route only \/v1\/\* directly to core/);
    await run("AWS_FAKE_EXTRA_ACTION", /non-portal ALB must route only \/v1\/\* directly to core/);
    await run("AWS_FAKE_EXTRA_CONDITION", /non-portal ALB must route only \/v1\/\* directly to core/);
    await run("AWS_FAKE_EXTRA_RULE", /non-portal ALB has unexpected non-default rules/);
    const portal = statefulAws(dir, config);
    const priorExtraRule = process.env.AWS_FAKE_EXTRA_RULE;
    process.env.AWS_FAKE_EXTRA_RULE = "1";
    try {
      await assert.rejects(
        () => awsUp(config, dir, { yes: true }),
        /portal mode must not expose non-default ALB rules/,
      );
    } finally {
      if (priorExtraRule === undefined) delete process.env.AWS_FAKE_EXTRA_RULE;
      else process.env.AWS_FAKE_EXTRA_RULE = priorExtraRule;
      portal.restore();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS portal ALB adopts pinned target groups and requires exactly the env-derived host rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-host-split-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  const hostSplitConfig = (hosts: { apiUrl?: string; appsDomain?: string }): QmConfig => ({
    ...config,
    ...(hosts.apiUrl ? { apiUrl: hosts.apiUrl } : {}),
    env: {
      ...config.env,
      core: { ...config.env.core, ...(hosts.appsDomain ? { AWS_DEPLOY_APPS_DOMAIN: hosts.appsDomain } : {}) },
    },
    aws: {
      ...config.aws!,
      services: {
        ...config.aws!.services,
        core: { ...config.aws!.services.core!, targetGroup: "legacy-core-tg" },
        portal: { ...config.aws!.services.portal!, targetGroup: "legacy-portal-tg" },
      },
    },
  });
  const bothHosts = { apiUrl: "https://api.agent.acme.example", appsDomain: "apps.agent.acme.example" };
  const run = async (
    configured: QmConfig,
    env?:
      | "AWS_FAKE_NO_CORE_RULE"
      | "AWS_FAKE_EXTRA_RULE"
      | "AWS_FAKE_WRONG_RULE_TARGET"
      | "AWS_FAKE_WRONG_RULE_HOST"
      | "AWS_FAKE_PUBLIC_API_URL",
    expected?: RegExp,
    envValue = "1",
  ): Promise<void> => {
    const fake = statefulAws(dir, configured);
    const prior = env ? process.env[env] : undefined;
    if (env) process.env[env] = envValue;
    try {
      if (expected) await assert.rejects(() => awsUp(configured, dir, { dryRun: true }), expected);
      else await awsUp(configured, dir, { dryRun: true });
      if (!expected || (env && env !== "AWS_FAKE_PUBLIC_API_URL"))
        assert.match(readFileSync(fake.log, "utf8"), /elbv2 describe-rules/);
    } finally {
      if (env) {
        if (prior === undefined) delete process.env[env];
        else process.env[env] = prior;
      }
      fake.restore();
    }
  };
  try {
    await run(hostSplitConfig(bothHosts));
    await run(hostSplitConfig({ apiUrl: bothHosts.apiUrl }));
    await run(hostSplitConfig({ appsDomain: bothHosts.appsDomain }));
    await run(hostSplitConfig({ apiUrl: "https://API.agent.acme.example", appsDomain: "APPS.agent.acme.example." }));
    await run(hostSplitConfig({ apiUrl: config.publicUrl }));
    await run(
      hostSplitConfig(bothHosts),
      "AWS_FAKE_NO_CORE_RULE",
      /host rules must route exactly api\.agent\.acme\.example, \*\.apps\.agent\.acme\.example to core \(live: none\)/,
    );
    await run(hostSplitConfig(bothHosts), "AWS_FAKE_EXTRA_RULE", /not a single host-header forward to core/);
    await run(hostSplitConfig(bothHosts), "AWS_FAKE_WRONG_RULE_TARGET", /not a single host-header forward to core/);
    await run(
      hostSplitConfig(bothHosts),
      "AWS_FAKE_WRONG_RULE_HOST",
      /host rules must route exactly .* \(live: other\.example, \*\.apps\.agent\.acme\.example\)/,
    );
    await run(
      hostSplitConfig({ appsDomain: "*.apps.agent.acme.example" }),
      undefined,
      /env\.core\.AWS_DEPLOY_APPS_DOMAIN .* does not derive a valid ALB host-header hostname/,
    );
    await run(
      hostSplitConfig(bothHosts),
      "AWS_FAKE_PUBLIC_API_URL",
      /PUBLIC_API_URL must equal the configured HTTPS apiUrl/,
      config.publicUrl,
    );
  } finally {
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up scales services to the configured desired count and live check flags drift from it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-desired-count-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const scaled = (): QmConfig => {
    const base = oneServiceConfig();
    return { ...base, aws: { ...base.aws!, services: { core: { ...base.aws!.services.core!, desiredCount: 2 } } } };
  };
  const fake = statefulAws(dir, scaled());
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(scaled(), dir, { yes: true });
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(state.services["acme-core"].desiredCount, 2);
    assert.match(readFileSync(fake.log, "utf8"), /ecs update-service .*--desired-count 2/);
    await assert.doesNotReject(() => awsCheckLive(scaled(), { report: false }));
    state.services["acme-core"].desiredCount = 1;
    writeFileSync(fake.state, JSON.stringify(state));
    await assert.rejects(
      () => awsCheckLive(scaled(), { report: false }),
      /core: runtime is ACTIVE with 1\/1 running, expected 2/,
    );
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up snapshots the database under the lease before any mutation and records it in the manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-db-snapshot-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single, {}, { snapshotCreatingPolls: 2 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(single, dir, { dryRun: true });
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /rds /, "plan is read-only and never touches RDS");
    await awsUp(single, dir, { yes: true });
    const calls = readFileSync(fake.log, "utf8");
    const lease = calls.indexOf("dynamodb put-item");
    const health = calls.indexOf("rds describe-db-instances --db-instance-identifier acme-qm-core");
    const create = calls.indexOf("rds create-db-snapshot");
    const wait = calls.indexOf("rds describe-db-snapshots --db-snapshot-identifier", create);
    const firstMutation = Math.min(
      ...[
        "s3api put-object",
        "ecr get-login-password",
        "ecs update-service",
        "ecs register-task-definition",
        "dynamodb transact-write-items",
      ]
        .map((call) => calls.indexOf(call))
        .concat(calls.indexOf("dynamodb put-item", lease + 1))
        .filter((index) => index >= 0),
    );
    assert.ok(lease >= 0 && lease < health, "the snapshot happens under the deploy lease");
    assert.ok(health < create && create < wait, "health is verified before creating, and the snapshot is awaited");
    assert.ok(wait < firstMutation, "the snapshot completes before the first mutation");
    assert.equal(
      calls.match(/rds describe-db-snapshots --db-snapshot-identifier/g)?.length,
      3,
      "the wait polls through creating until the snapshot is available",
    );
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    const manifestId = state.dynamo["deployment/current"].manifestId.S as string;
    const manifest = JSON.parse(state.dynamo[`deployment/manifest/${manifestId}`].manifest.S) as {
      dbSnapshot?: string;
    };
    assert.equal(
      manifest.dbSnapshot,
      `acme-qm-core-predeploy-${manifestId}`,
      "the snapshot is named after the manifest it precedes",
    );
    assert.deepEqual(
      (state.rdsSnapshots as Array<{ DBSnapshotIdentifier: string }>).map((item) => item.DBSnapshotIdentifier),
      [`acme-qm-core-predeploy-${manifestId}`],
    );
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up refuses to mutate when the database is unavailable or keeps no automated backups", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-db-unhealthy-"));
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single);
  const priorStatus = process.env.AWS_FAKE_DB_STATUS;
  const priorRetention = process.env.AWS_FAKE_DB_RETENTION;
  try {
    process.env.AWS_FAKE_DB_STATUS = "backing-up";
    await assert.rejects(
      () => awsUp(single, dir, { yes: true }),
      /database acme-qm-core is backing-up; refusing to deploy/,
    );
    delete process.env.AWS_FAKE_DB_STATUS;
    process.env.AWS_FAKE_DB_RETENTION = "0";
    await assert.rejects(
      () => awsUp(single, dir, { yes: true }),
      /keeps 0 day\(s\) of automated backups, below the required 1/,
    );
    delete process.env.AWS_FAKE_DB_RETENTION;
    const strict: QmConfig = { ...single, aws: { ...single.aws!, dbRetentionMinDays: 35 } };
    await assert.rejects(
      () => awsUp(strict, dir, { yes: true }),
      /keeps 7 day\(s\) of automated backups, below the required 35/,
    );
    const calls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(calls, /rds create-db-snapshot|ecr get-login-password|ecs update-service|s3api put-object/);
  } finally {
    if (priorStatus === undefined) delete process.env.AWS_FAKE_DB_STATUS;
    else process.env.AWS_FAKE_DB_STATUS = priorStatus;
    if (priorRetention === undefined) delete process.env.AWS_FAKE_DB_RETENTION;
    else process.env.AWS_FAKE_DB_RETENTION = priorRetention;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aws.predeployDbSnapshot false skips the snapshot without touching RDS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-db-disabled-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const base = oneServiceConfig();
  const single: QmConfig = { ...base, aws: { ...base.aws!, predeployDbSnapshot: false } };
  const fake = statefulAws(dir, single);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(single, dir, { yes: true });
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /rds /);
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    const manifestId = state.dynamo["deployment/current"].manifestId.S as string;
    const manifest = JSON.parse(state.dynamo[`deployment/manifest/${manifestId}`].manifest.S) as {
      dbSnapshot?: string;
    };
    assert.equal(manifest.dbSnapshot, undefined);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up prunes pre-deploy snapshots beyond the bound, legacy untagged ones included, and never manifest-referenced, foreign, or operator snapshots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-db-prune-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const single = oneServiceConfig();
  const clusterTag = [
    { Key: "ManagedBy", Value: "qm-cli" },
    { Key: "QmCluster", Value: "acme-qm" },
  ];
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [
        {
          id: "current",
          imageLabel: "release",
          dbSnapshot: "acme-qm-core-predeploy-oldest",
          tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1" },
        },
      ],
      "current",
    ),
  );
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  state.rdsSnapshots = [
    {
      DBSnapshotIdentifier: "acme-qm-core-predeploy-oldest",
      Status: "available",
      SnapshotCreateTime: "2026-01-01T00:00:00.000Z",
      TagList: clusterTag,
    },
    {
      DBSnapshotIdentifier: "acme-qm-core-predeploy-older",
      Status: "available",
      SnapshotCreateTime: "2026-01-02T00:00:00.000Z",
      TagList: clusterTag,
    },
    {
      DBSnapshotIdentifier: "acme-qm-core-predeploy-newest",
      Status: "available",
      SnapshotCreateTime: "2026-01-03T00:00:00.000Z",
      TagList: clusterTag,
    },
    { DBSnapshotIdentifier: "acme-qm-core-predeploy-aborted", Status: "creating", TagList: clusterTag },
    {
      DBSnapshotIdentifier: "acme-qm-core-predeploy-legacy",
      Status: "available",
      SnapshotCreateTime: "2026-01-01T12:00:00.000Z",
      TagList: [{ Key: "ManagedBy", Value: "qm-cli" }],
    },
    {
      DBSnapshotIdentifier: "acme-qm-core-predeploy-foreign",
      Status: "available",
      SnapshotCreateTime: "2026-01-01T00:00:00.000Z",
      TagList: [
        { Key: "ManagedBy", Value: "qm-cli" },
        { Key: "QmCluster", Value: "other-qm" },
      ],
    },
    {
      DBSnapshotIdentifier: "acme-qm-core-operator-kept",
      Status: "available",
      SnapshotCreateTime: "2020-01-01T00:00:00.000Z",
    },
  ];
  writeFileSync(fake.state, JSON.stringify(state));
  const priorPath = process.env.PATH;
  const priorKeep = process.env.QM_AWS_DB_SNAPSHOT_KEEP;
  process.env.PATH = `${dir}:${priorPath}`;
  process.env.QM_AWS_DB_SNAPSHOT_KEEP = "2";
  try {
    await awsUp(single, dir, { yes: true });
    const after = JSON.parse(readFileSync(fake.state, "utf8"));
    const kept = (after.rdsSnapshots as Array<{ DBSnapshotIdentifier: string }>)
      .map((item) => item.DBSnapshotIdentifier)
      .sort();
    const manifestId = after.dynamo["deployment/current"].manifestId.S as string;
    assert.notEqual(manifestId, "current", "the deploy records a new manifest");
    assert.deepEqual(
      kept,
      [
        "acme-qm-core-operator-kept",
        "acme-qm-core-predeploy-aborted",
        "acme-qm-core-predeploy-foreign",
        "acme-qm-core-predeploy-oldest",
        `acme-qm-core-predeploy-${manifestId}`,
      ].sort(),
    );
  } finally {
    process.env.PATH = priorPath;
    if (priorKeep === undefined) delete process.env.QM_AWS_DB_SNAPSHOT_KEEP;
    else process.env.QM_AWS_DB_SNAPSHOT_KEEP = priorKeep;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up fails closed when the snapshot reports an unexpected status or never becomes available", async () => {
  const single = oneServiceConfig();
  const brokenDir = mkdtempSync(join(tmpdir(), "qm-aws-db-broken-"));
  const broken = statefulAws(brokenDir, single, {}, { snapshotStatus: "error" });
  try {
    await assert.rejects(
      () => awsUp(single, brokenDir, { yes: true }),
      /pre-deploy database snapshot .* is error instead of creating/,
    );
    assert.doesNotMatch(readFileSync(broken.log, "utf8"), /ecr get-login-password|ecs update-service|s3api put-object/);
  } finally {
    broken.restore();
    rmSync(brokenDir, { recursive: true, force: true });
  }
  const stuckDir = mkdtempSync(join(tmpdir(), "qm-aws-db-stuck-"));
  const stuck = statefulAws(stuckDir, single, {}, { snapshotCreatingPolls: 10_000 });
  const priorDeadline = process.env.QM_AWS_DB_SNAPSHOT_DEADLINE_MS;
  process.env.QM_AWS_DB_SNAPSHOT_DEADLINE_MS = "40";
  try {
    await assert.rejects(
      () => awsUp(single, stuckDir, { yes: true }),
      /timed out waiting for pre-deploy database snapshot/,
    );
    assert.doesNotMatch(readFileSync(stuck.log, "utf8"), /ecr get-login-password|ecs update-service|s3api put-object/);
  } finally {
    if (priorDeadline === undefined) delete process.env.QM_AWS_DB_SNAPSHOT_DEADLINE_MS;
    else process.env.QM_AWS_DB_SNAPSHOT_DEADLINE_MS = priorDeadline;
    stuck.restore();
    rmSync(stuckDir, { recursive: true, force: true });
  }
});

test("a snapshot prune failure warns without failing the deploy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-db-prune-warn-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single, {}, { failSnapshotDelete: true });
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  state.rdsSnapshots = [
    {
      DBSnapshotIdentifier: "acme-qm-core-predeploy-stale",
      Status: "available",
      SnapshotCreateTime: "2026-01-01T00:00:00.000Z",
      TagList: [{ Key: "QmCluster", Value: "acme-qm" }],
    },
  ];
  writeFileSync(fake.state, JSON.stringify(state));
  const priorPath = process.env.PATH;
  const priorKeep = process.env.QM_AWS_DB_SNAPSHOT_KEEP;
  process.env.PATH = `${dir}:${priorPath}`;
  process.env.QM_AWS_DB_SNAPSHOT_KEEP = "1";
  const warnings: string[] = [];
  const warnLog = console.warn;
  console.warn = (...parts: unknown[]): void => void warnings.push(parts.join(" "));
  try {
    await awsUp(single, dir, { yes: true });
    assert.match(warnings.join("\n"), /could not prune pre-deploy database snapshot acme-qm-core-predeploy-stale/);
    const after = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.ok(after.dynamo["deployment/current"], "the deploy still records its manifest");
    assert.match(readFileSync(fake.log, "utf8"), /ecs update-service/);
  } finally {
    console.warn = warnLog;
    process.env.PATH = priorPath;
    if (priorKeep === undefined) delete process.env.QM_AWS_DB_SNAPSHOT_KEEP;
    else process.env.QM_AWS_DB_SNAPSHOT_KEEP = priorKeep;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the snapshot wait tolerates transient describe failures and fails after three in a row", async () => {
  const single = oneServiceConfig();
  const transientDir = mkdtempSync(join(tmpdir(), "qm-aws-db-transient-"));
  const transientDocker = join(transientDir, "docker");
  writeFileSync(transientDocker, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(transientDocker, 0o755);
  const transient = statefulAws(transientDir, single, {}, { failSnapshotDescribes: 1 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${transientDir}:${priorPath}`;
  try {
    await awsUp(single, transientDir, { yes: true });
    assert.match(readFileSync(transient.log, "utf8"), /ecs update-service/);
  } finally {
    process.env.PATH = priorPath;
    transient.restore();
    rmSync(transientDir, { recursive: true, force: true });
  }
  const brokenDir = mkdtempSync(join(tmpdir(), "qm-aws-db-describe-broken-"));
  const broken = statefulAws(brokenDir, single, {}, { failSnapshotDescribes: 10_000 });
  try {
    await assert.rejects(() => awsUp(single, brokenDir, { yes: true }), /TransientSnapshotDescribeFailure/);
    assert.doesNotMatch(readFileSync(broken.log, "utf8"), /ecr get-login-password|ecs update-service|s3api put-object/);
  } finally {
    broken.restore();
    rmSync(brokenDir, { recursive: true, force: true });
  }
});

test("a no-op re-deploy deletes its unreferenced pre-deploy snapshot and records no manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-db-noop-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(single, dir, { yes: true });
    const first = JSON.parse(readFileSync(fake.state, "utf8"));
    const firstManifestId = first.dynamo["deployment/current"].manifestId.S as string;
    await awsUp(single, dir, { yes: true });
    const second = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(second.dynamo["deployment/current"].manifestId.S, firstManifestId);
    assert.deepEqual(
      (second.rdsSnapshots as Array<{ DBSnapshotIdentifier: string }>).map((item) => item.DBSnapshotIdentifier),
      [`acme-qm-core-predeploy-${firstManifestId}`],
      "the no-op run's snapshot protects nothing and is deleted",
    );
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up renews the deploy lease with a holder-conditioned update while it runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-lease-renew-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single, {}, { snapshotCreatingPolls: 3 });
  const priorPath = process.env.PATH;
  const priorRenew = process.env.QM_AWS_LEASE_RENEW_MS;
  process.env.PATH = `${dir}:${priorPath}`;
  process.env.QM_AWS_LEASE_RENEW_MS = "10";
  try {
    await awsUp(single, dir, { yes: true });
    const calls = readFileSync(fake.log, "utf8");
    assert.match(
      calls,
      /dynamodb update-item --table-name acme-qm-deploy-locks --key \{"lockKey":\{"S":"deploy"\}\} --update-expression SET expiresAt = :expiresAt --condition-expression holder = :holder/,
    );
    assert.ok(
      calls.indexOf("dynamodb update-item") < calls.indexOf("dynamodb delete-item"),
      "renewal happens while the lease is held",
    );
  } finally {
    process.env.PATH = priorPath;
    if (priorRenew === undefined) delete process.env.QM_AWS_LEASE_RENEW_MS;
    else process.env.QM_AWS_LEASE_RENEW_MS = priorRenew;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lease renewal that loses the holder condition warns loudly and stops renewing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-lease-lost-"));
  const fake = fakeAws(
    dir,
    `
if (a.includes("dynamodb update-item")) { console.error("An error occurred (ConditionalCheckFailedException) when calling the UpdateItem operation"); process.exit(1); }
console.log("");`,
  );
  const priorRenew = process.env.QM_AWS_LEASE_RENEW_MS;
  process.env.QM_AWS_LEASE_RENEW_MS = "5";
  const warnings: string[] = [];
  const warnLog = console.warn;
  console.warn = (...parts: unknown[]): void => void warnings.push(parts.join(" "));
  try {
    await withAwsLease(config.aws!, async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    assert.match(warnings.join("\n"), /"deploy" lease in acme-qm-deploy-locks was taken over by another QM operation/);
    assert.equal(
      readFileSync(fake.log, "utf8").match(/dynamodb update-item/g)?.length,
      1,
      "renewal stops once the lease is lost",
    );
  } finally {
    console.warn = warnLog;
    if (priorRenew === undefined) delete process.env.QM_AWS_LEASE_RENEW_MS;
    else process.env.QM_AWS_LEASE_RENEW_MS = priorRenew;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS deploy requires PUBLIC_API_URL to equal the declared HTTPS public URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-public-api-url-"));
  const fake = statefulAws(dir, oneServiceConfig());
  const prior = process.env.AWS_FAKE_PUBLIC_API_URL;
  process.env.AWS_FAKE_PUBLIC_API_URL = "http://agent.acme.example";
  try {
    await assert.rejects(
      () => awsUp(oneServiceConfig(), dir, { yes: true }),
      /PUBLIC_API_URL must be a valid HTTPS URL equal to the configured publicUrl/,
    );
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /get-secret-value .*PUBLIC_API_URL .*--query SecretString/);
    assert.doesNotMatch(calls, /dynamodb put-item|ecr get-login-password|ecs update-service/);
  } finally {
    if (prior === undefined) delete process.env.AWS_FAKE_PUBLIC_API_URL;
    else process.env.AWS_FAKE_PUBLIC_API_URL = prior;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every AWS mutation rejects the wrong caller account before side effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-account-guard-"));
  const fake = fakeAws(dir, `console.log("");`);
  const prior = process.env.AWS_FAKE_ACCOUNT;
  process.env.AWS_FAKE_ACCOUNT = "999999999999";
  const mismatch = /authenticated to AWS account 999999999999, expected 123456789012/;
  try {
    await assert.rejects(() => awsUp(oneServiceConfig(), dir, { yes: true }), mismatch);
    await assert.rejects(() => awsUp(oneServiceConfig(), dir, { dryRun: true }), mismatch);
    await assert.rejects(() => awsDown(oneServiceConfig()), mismatch);
    await assert.rejects(() => awsRollback(oneServiceConfig()), mismatch);
    await assert.rejects(() => awsSecretsPush(oneServiceConfig(), dir), mismatch);
    const calls = readFileSync(fake.log, "utf8");
    assert.equal(calls.match(/sts get-caller-identity/g)?.length, 5);
    assert.doesNotMatch(calls, /dynamodb|ecr |ecs update-service|secretsmanager/);
  } finally {
    if (prior === undefined) delete process.env.AWS_FAKE_ACCOUNT;
    else process.env.AWS_FAKE_ACCOUNT = prior;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS deploy rejects required secret containers without an AWSCURRENT value before mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-empty-secret-"));
  const targetName = `acme-qm-port-${createHash("sha1").update("acme-qm:portal").digest("hex").slice(0, 6)}`;
  const targetArn = `arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/${targetName}/1`;
  const fake = fakeAws(
    dir,
    `
if (a.includes("ecs describe-services")) console.log(JSON.stringify({ services: ${JSON.stringify(Object.entries(config.aws!.services).map(([name, spec]) => ({ serviceName: spec.ecsService, loadBalancers: name === "portal" ? [{ targetGroupArn: targetArn }] : [] })))} }));
else if (a.includes("secretsmanager get-secret-value")) {
  console.error("ResourceNotFoundException: Secrets Manager can't find the specified secret value");
  process.exit(1);
}
console.log("");`,
  );
  try {
    await assert.rejects(() => awsUp(config, process.cwd(), { yes: true }), /ResourceNotFoundException/);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /secretsmanager get-secret-value/);
    assert.doesNotMatch(calls, /dynamodb put-item|ecr get-login-password|ecr describe-images|ecs update-service/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS deploy rejects weak signing keys before mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-weak-secret-"));
  const fake = statefulAws(dir, oneServiceConfig());
  const prior = process.env.AWS_FAKE_SECRET_VALUE;
  process.env.AWS_FAKE_SECRET_VALUE = "short";
  try {
    await assert.rejects(
      () => awsUp(oneServiceConfig(), dir, { yes: true }),
      /required AWS secret CORE_SIGNING_SECRET has no usable/,
    );
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /dynamodb put-item|ecr describe-images|ecs update-service/);
  } finally {
    if (prior === undefined) delete process.env.AWS_FAKE_SECRET_VALUE;
    else process.env.AWS_FAKE_SECRET_VALUE = prior;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS doctor verifies durable deployment storage and object-store access", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-doctor-storage-"));
  const ready = fakeAws(
    dir,
    `
if (a.includes("dynamodb describe-table")) console.log(JSON.stringify({ Table: { TableStatus: "ACTIVE" } }));
else console.log("");`,
  );
  try {
    assert.doesNotThrow(() => assertAwsDeploymentStorage(config));
    const calls = readFileSync(ready.log, "utf8");
    assert.match(calls, /dynamodb describe-table --table-name acme-qm-deploy-locks/);
    assert.ok(
      calls.includes(
        `s3api list-objects-v2 --bucket ${awsObjectStoreBucket(config)} --prefix deployment/ --max-keys 1`,
      ),
    );
  } finally {
    ready.restore();
  }
  const inactive = fakeAws(
    dir,
    `
if (a.includes("dynamodb describe-table")) console.log(JSON.stringify({ Table: { TableStatus: "CREATING" } }));
else console.log("");`,
  );
  try {
    assert.throws(() => assertAwsDeploymentStorage(config), /CREATING/);
    assert.doesNotMatch(readFileSync(inactive.log, "utf8"), /list-objects-v2/);
  } finally {
    inactive.restore();
  }
  const denied = fakeAws(
    dir,
    `
if (a.includes("dynamodb describe-table")) console.log(JSON.stringify({ Table: { TableStatus: "ACTIVE" } }));
else if (a.includes("s3api list-objects-v2")) { console.error("AccessDenied"); process.exit(1); }
else console.log("");`,
  );
  try {
    assert.throws(() => assertAwsDeploymentStorage(config), /AccessDenied/);
  } finally {
    denied.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS task definitions are digest-pinned and route only computed secrets", () => {
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const task = renderTaskDefinition(config, "core", image);
  assert.equal(task.runtimePlatform.cpuArchitecture, "ARM64");
  assert.equal(task.executionRoleArn, "arn:aws:iam::123456789012:role/acme-qm-task-execution");
  assert.equal(task.taskRoleArn, "arn:aws:iam::123456789012:role/acme-qm-core-task");
  const container = task.containerDefinitions[0]!;
  assert.equal(container.image, image);
  const names = (container.secrets as Array<{ name: string }>).map((secret) => secret.name);
  assert.deepEqual(names, [
    "CAPABILITY_SECRET",
    "CONNECTOR_SECRET_KEY",
    "CORE_SIGNING_SECRET",
    "DATABASE_URL",
    "FLY_RESIDENT_ENV_ACME_API_KEY",
    "PORTAL_IDENTITY_SECRET",
    "PUBLIC_API_URL",
    "SKILL_SIGNING_SECRET",
    "SPRITES_TOKEN",
  ]);
  assert.throws(() => renderTaskDefinition(config, "core", "repo:latest"), /must be pinned by digest/);
});

test("AWS task architecture allows per-workload overrides", () => {
  const amd64Core: QmConfig = {
    ...config,
    aws: {
      ...config.aws!,
      services: {
        ...config.aws!.services,
        core: { ...config.aws!.services.core!, architecture: "amd64" },
      },
    },
  };
  const coreImage = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  assert.equal(renderTaskDefinition(amd64Core, "core", coreImage).runtimePlatform.cpuArchitecture, "X86_64");
});

test("AWS task parity ignores only ECS response defaults and catches live-only fields", () => {
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const task = renderTaskDefinition(config, "core", image);
  const live = structuredClone(task) as unknown as Record<string, unknown>;
  live.taskDefinitionArn = "arn:task";
  live.revision = 4;
  live.compatibilities = ["EC2", "FARGATE"];
  live.volumes = [];
  const container = (live.containerDefinitions as Array<Record<string, unknown>>)[0]!;
  container.cpu = 0;
  container.mountPoints = [];
  container.environment = [...(container.environment as unknown[])].reverse();
  assert.deepEqual(taskDefinitionDiff(task, live), []);
  container.entryPoint = ["unexpected"];
  assert.deepEqual(taskDefinitionDiff(task, live), ["taskDefinition.containerDefinitions.core.entryPoint"]);
});

test("AWS task parity catches a correctly named secret routed to the wrong ARN", () => {
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const expected = renderTaskDefinition(config, "core", image, { CORE_SIGNING_SECRET: "arn:expected" });
  const live = structuredClone(expected) as unknown as Record<string, unknown>;
  const container = (live.containerDefinitions as Array<{ secrets: Array<{ name: string; valueFrom: string }> }>)[0]!;
  container.secrets.find((secret) => secret.name === "CORE_SIGNING_SECRET")!.valueFrom = "arn:attacker";
  assert.deepEqual(taskDefinitionDiff(expected, live), [
    "taskDefinition.containerDefinitions.core.secrets.CORE_SIGNING_SECRET",
  ]);
  assert.deepEqual(taskDefinitionChanges(expected, live), [
    {
      path: "taskDefinition.containerDefinitions.core.secrets.CORE_SIGNING_SECRET",
      live: "arn:attacker",
      desired: "arn:expected",
    },
  ]);
});

test("AWS image transfer preserves the source manifest instead of pulling the host architecture", () => {
  assert.deepEqual(imageTransferArgs("ghcr.io/acme/core:1", "123.dkr.ecr.us-west-2.amazonaws.com/core:sha"), [
    "buildx",
    "imagetools",
    "create",
    "--prefer-index=false",
    "--tag",
    "123.dkr.ecr.us-west-2.amazonaws.com/core:sha",
    "ghcr.io/acme/core:1",
  ]);
});

test("AWS source builds honor the configured web-ui base build-arg and record git provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-web-ui-build-"));
  const sourceDir = join(dir, "source");
  const dockerLog = join(dir, "docker.log");
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerLog, "");
  writeFileSync(
    dockerBin,
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(dockerLog)}, process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  chmodSync(dockerBin, 0o755);
  for (const service of ["core", "web-ui", "portal"]) {
    mkdirSync(join(sourceDir, "deploy", service), { recursive: true });
    writeFileSync(join(sourceDir, "deploy", service, "Dockerfile"), `FROM scratch\nLABEL service=${service}\n`);
  }
  const git = (...args: string[]): string => {
    const result = spawnSync(
      "git",
      ["-C", sourceDir, "-c", "user.email=test@acme.example", "-c", "user.name=test", ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init");
  git("add", "-A");
  git("commit", "-m", "initial");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(sourceDir, "uncommitted.txt"), "dirty\n");
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  const webUiConfig: QmConfig = {
    ...config,
    services: ["core", "web-ui", "portal"],
    aws: {
      ...config.aws!,
      services: {
        core: config.aws!.services.core!,
        "web-ui": { ...config.aws!.services["web-ui"]!, architecture: "amd64", buildArgs: { WEB_UI_BASE: "/custom/" } },
        portal: config.aws!.services.portal!,
      },
    },
  };
  const fake = statefulAws(dir, webUiConfig);
  try {
    await awsUp(webUiConfig, dir, { yes: true, buildFrom: true, buildFromPath: sourceDir });
    const build = readFileSync(dockerLog, "utf8")
      .split("\n")
      .find((line) => line.includes("buildx build") && line.includes("qm-web-ui"));
    assert.match(build ?? "", /--platform linux\/amd64/);
    assert.match(build ?? "", /--provenance=false/);
    assert.match(build ?? "", /--build-arg WEB_UI_BASE=\/custom\//);
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    const manifestId = state.dynamo["deployment/current"].manifestId.S;
    const manifest = JSON.parse(state.dynamo[`deployment/manifest/${manifestId}`].manifest.S);
    for (const service of ["core", "web-ui", "portal"]) {
      assert.deepEqual(manifest.imageProvenance[service], {
        kind: "source-build",
        source: "checkout",
        gitCommit: head,
        dirty: true,
      });
    }
    await assert.doesNotReject(() => awsCheckLive(webUiConfig, { report: false, configDir: dir }));
    const changedPrebuiltConfig: QmConfig = {
      ...webUiConfig,
      imageOverrides: { core: `ghcr.io/acme/core@sha256:${"c".repeat(64)}` },
      aws: {
        ...webUiConfig.aws!,
        services: {
          ...webUiConfig.aws!.services,
          core: { ...webUiConfig.aws!.services.core!, architecture: "arm64" },
        },
      },
    };
    await assert.rejects(
      () => awsCheckLive(changedPrebuiltConfig, { report: false, configDir: dir }),
      /core: image build provenance drift \(deployed from source, current workload uses a configured image\)/,
    );
    assert.doesNotMatch(readFileSync(dockerLog, "utf8"), /imagetools inspect/);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS source builds honor a per-service dockerfile override and stamp GIT_SHA, suffixed -dirty on a dirty checkout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-dockerfile-override-"));
  const sourceDir = join(dir, "source");
  const dockerLog = join(dir, "docker.log");
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerLog, "");
  writeFileSync(
    dockerBin,
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(dockerLog)}, process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  chmodSync(dockerBin, 0o755);
  for (const service of ["core", "web-ui", "portal"]) {
    mkdirSync(join(sourceDir, "deploy", service), { recursive: true });
    writeFileSync(join(sourceDir, "deploy", service, "Dockerfile"), `FROM scratch\nLABEL service=${service}\n`);
  }
  mkdirSync(join(sourceDir, "layered"), { recursive: true });
  writeFileSync(join(sourceDir, "layered", "core.Dockerfile"), "FROM scratch\nLABEL layered=core\n");
  const git = (...args: string[]): string => {
    const result = spawnSync(
      "git",
      ["-C", sourceDir, "-c", "user.email=test@acme.example", "-c", "user.name=test", ...args],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init");
  git("add", "-A");
  git("commit", "-m", "initial");
  const head = git("rev-parse", "HEAD");
  const layeredConfig: QmConfig = {
    ...config,
    services: ["core", "web-ui", "portal"],
    aws: {
      ...config.aws!,
      services: {
        core: { ...config.aws!.services.core!, dockerfile: "layered/core.Dockerfile" },
        "web-ui": config.aws!.services["web-ui"]!,
        portal: config.aws!.services.portal!,
      },
    },
  };
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  const fake = statefulAws(dir, layeredConfig);
  try {
    await awsUp(layeredConfig, dir, { yes: true, buildFrom: true, buildFromPath: sourceDir });
    const builds = readFileSync(dockerLog, "utf8")
      .split("\n")
      .filter((line) => line.includes("buildx build"));
    const coreBuild = builds.find((line) => line.includes("qm-core"));
    assert.ok(
      coreBuild?.includes(`-f ${join(sourceDir, "layered", "core.Dockerfile")}`),
      `core build uses the override: ${coreBuild}`,
    );
    assert.ok(coreBuild?.includes(`--build-arg GIT_SHA=${head}`), `core build stamps GIT_SHA: ${coreBuild}`);
    const webUiBuild = builds.find((line) => line.includes("qm-web-ui"));
    assert.ok(
      webUiBuild?.includes(`-f ${join(sourceDir, "deploy", "web-ui", "Dockerfile")}`),
      `web-ui build keeps the default: ${webUiBuild}`,
    );
    const dirtySource = join(dir, "dirty-source");
    for (const service of ["core", "web-ui", "portal"]) {
      mkdirSync(join(dirtySource, "deploy", service), { recursive: true });
      writeFileSync(join(dirtySource, "deploy", service, "Dockerfile"), `FROM scratch\nLABEL service=${service}\n`);
    }
    mkdirSync(join(dirtySource, "layered"), { recursive: true });
    writeFileSync(join(dirtySource, "layered", "core.Dockerfile"), "FROM scratch\nLABEL layered=core\n");
    const dirtyGit = (...args: string[]): string => {
      const result = spawnSync(
        "git",
        ["-C", dirtySource, "-c", "user.email=test@acme.example", "-c", "user.name=test", ...args],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    dirtyGit("init");
    dirtyGit("add", "-A");
    dirtyGit("commit", "-m", "initial");
    const dirtyHead = dirtyGit("rev-parse", "HEAD");
    writeFileSync(join(dirtySource, "deploy", "core", "Dockerfile"), "FROM scratch\nLABEL service=core-modified\n");
    await awsUp(layeredConfig, dir, { yes: true, buildFrom: true, buildFromPath: dirtySource });
    const dirtyCoreBuild = readFileSync(dockerLog, "utf8")
      .split("\n")
      .find((line) => line.includes("buildx build") && line.includes("qm-core") && line.includes(dirtySource));
    assert.ok(
      dirtyCoreBuild?.includes(`--build-arg GIT_SHA=${dirtyHead}-dirty`),
      `a dirty checkout stamps a distinct build sha so lame-duck supersession can tell it from the clean build: ${dirtyCoreBuild}`,
    );
    const missingConfig: QmConfig = {
      ...layeredConfig,
      aws: {
        ...layeredConfig.aws!,
        services: {
          ...layeredConfig.aws!.services,
          core: { ...layeredConfig.aws!.services.core!, dockerfile: "layered/absent.Dockerfile" },
        },
      },
    };
    await assert.rejects(
      () => awsUp(missingConfig, dir, { yes: true, buildFrom: true, buildFromPath: sourceDir }),
      /aws\.services\.core\.dockerfile is missing from the build checkout/,
    );
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS source-plugin provenance records the build source and detects source-mode drift", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-plugin-provenance-"));
  const pluginDir = join(dir, "plugins", "linear");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "Dockerfile"), "FROM scratch\nCOPY handler.js /handler.js\n");
  writeFileSync(join(pluginDir, "handler.js"), "export const version = 1;\n");
  const single = oneServiceConfig();
  const sourceConfig: QmConfig = {
    ...single,
    plugins: [{ name: "linear" }],
    aws: {
      ...single.aws!,
      services: {
        ...single.aws!.services,
        linear: { ecrRepository: "qm-linear", ecsService: "acme-linear", cpu: 256, memory: 512, architecture: "amd64" },
      },
    },
  };
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/bin/sh\necho 'Digest: sha256:${"a".repeat(64)}'\n`);
  chmodSync(dockerBin, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  const fake = statefulAws(dir, sourceConfig);
  try {
    await awsUp(sourceConfig, dir, { yes: true });
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    const manifestId = state.dynamo["deployment/current"].manifestId.S;
    const manifest = JSON.parse(state.dynamo[`deployment/manifest/${manifestId}`].manifest.S);
    assert.deepEqual(manifest.imageProvenance.linear, { kind: "source-build", source: "plugin" });
    await assert.doesNotReject(() => awsCheckLive(sourceConfig, { report: false, configDir: dir }));

    const persisted = JSON.parse(readFileSync(fake.state, "utf8"));
    const persistedManifest = JSON.parse(persisted.dynamo[`deployment/manifest/${manifestId}`].manifest.S);
    persistedManifest.imageProvenance.linear = { kind: "configured", source: "ghcr.io/acme/linear:1" };
    persisted.dynamo[`deployment/manifest/${manifestId}`].manifest.S = JSON.stringify(persistedManifest);
    writeFileSync(fake.state, JSON.stringify(persisted));
    await assert.rejects(
      () => awsCheckLive(sourceConfig, { report: false, configDir: dir }),
      /linear: image build provenance drift \(deployed from a configured image, current workload builds from source\)/,
    );
    persistedManifest.imageProvenance.linear = { kind: "source-build", source: "plugin" };
    persisted.dynamo[`deployment/manifest/${manifestId}`].manifest.S = JSON.stringify(persistedManifest);
    writeFileSync(fake.state, JSON.stringify(persisted));

    rmSync(pluginDir, { recursive: true, force: true });
    const configuredImage: QmConfig = {
      ...sourceConfig,
      plugins: [{ name: "linear", image: "ghcr.io/acme/linear:1" }],
    };
    await assert.rejects(
      () => awsCheckLive(configuredImage, { report: false, configDir: dir }),
      /linear: image build provenance drift \(deployed from source, current workload uses a configured image\)/,
    );
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS live-image provenance accepts only the configured ECR repository and a full digest", () => {
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  assert.equal(isPinnedWorkloadImage(config, "core", image), true);
  assert.equal(isPinnedWorkloadImage(config, "core", `attacker.example/core@sha256:${"a".repeat(64)}`), false);
  assert.equal(
    isPinnedWorkloadImage(config, "core", "123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core:latest"),
    false,
  );
});

test("AWS renders third-party plugins as private ECS workloads with scoped secrets", () => {
  const pluginConfig: QmConfig = {
    ...config,
    plugins: [
      {
        name: "linear",
        image: "ghcr.io/acme/linear:1",
        env: { LINEAR_REGION: "us" },
        secrets: [{ name: "LINEAR_TOKEN" }],
      },
    ],
    aws: {
      ...config.aws!,
      services: {
        ...config.aws!.services,
        linear: { ecrRepository: "qm-linear", ecsService: "acme-linear", cpu: 256, memory: 512, architecture: "amd64" },
      },
    },
  };
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-linear@sha256:${"c".repeat(64)}`;
  const task = renderTaskDefinition(pluginConfig, "linear", image, {
    CORE_SIGNING_SECRET: "arn:core-signing",
    LINEAR_TOKEN: "arn:linear-token",
  });
  const container = task.containerDefinitions[0]!;
  assert.equal(container.name, "linear");
  assert.deepEqual(
    Object.fromEntries(
      (container.environment as Array<{ name: string; value: string }>).map(({ name, value }) => [name, value]),
    ),
    {
      CORE_API_URL: "http://core.acme.internal:8080",
      CORE_ORG_ID: "acme",
      LINEAR_REGION: "us",
      PORT: "8080",
    },
  );
  assert.deepEqual(container.secrets, [
    { name: "CORE_SIGNING_SECRET", valueFrom: "arn:core-signing" },
    { name: "LINEAR_TOKEN", valueFrom: "arn:linear-token" },
  ]);
});

test("AWS fixes third-party plugin PORT to its ECS port mapping", () => {
  const pluginConfig: QmConfig = {
    ...config,
    plugins: [{ name: "linear", image: "ghcr.io/acme/linear:1", env: { PORT: "9000" } }],
    aws: {
      ...config.aws!,
      services: {
        ...config.aws!.services,
        linear: { ecrRepository: "qm-linear", ecsService: "acme-linear", cpu: 256, memory: 512, architecture: "amd64" },
      },
    },
  };
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-linear@sha256:${"c".repeat(64)}`;
  const task = renderTaskDefinition(pluginConfig, "linear", image, { CORE_SIGNING_SECRET: "arn:core-signing" });
  const environment = Object.fromEntries(
    (task.containerDefinitions[0]!.environment as Array<{ name: string; value: string }>).map(({ name, value }) => [
      name,
      value,
    ]),
  );
  assert.equal(environment.PORT, "8080");
});

test("AWS routes optional plugin secrets only when the secret exists", () => {
  const pluginConfig: QmConfig = {
    ...config,
    plugins: [{ name: "linear", image: "ghcr.io/acme/linear:1", secrets: [{ name: "LINEAR_TOKEN", required: false }] }],
    aws: {
      ...config.aws!,
      services: {
        ...config.aws!.services,
        linear: { ecrRepository: "linear", ecsService: "linear", cpu: 256, memory: 512, architecture: "amd64" },
      },
    },
  };
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/linear@sha256:${"d".repeat(64)}`;
  const absent = renderTaskDefinition(pluginConfig, "linear", image, { CORE_SIGNING_SECRET: "arn:core" });
  assert.deepEqual(
    (absent.containerDefinitions[0]!.secrets as Array<{ name: string }>).map((secret) => secret.name),
    ["CORE_SIGNING_SECRET"],
  );
  const present = renderTaskDefinition(pluginConfig, "linear", image, {
    CORE_SIGNING_SECRET: "arn:core",
    LINEAR_TOKEN: "arn:linear",
  });
  assert.deepEqual(
    (present.containerDefinitions[0]!.secrets as Array<{ name: string }>).map((secret) => secret.name),
    ["CORE_SIGNING_SECRET", "LINEAR_TOKEN"],
  );
});

test("AWS task rendering rejects guessed architecture for external images", () => {
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/linear@sha256:${"d".repeat(64)}`;
  const pluginConfig: QmConfig = {
    ...config,
    plugins: [{ name: "linear", image: "ghcr.io/acme/linear:1" }],
    aws: {
      ...config.aws!,
      services: {
        ...config.aws!.services,
        linear: { ecrRepository: "linear", ecsService: "linear", cpu: 256, memory: 512 },
      },
    },
  };
  assert.throws(() => renderTaskDefinition(pluginConfig, "linear", image), /linear\.architecture is required/);

  const overriddenCore: QmConfig = { ...config, imageOverrides: { core: "ghcr.io/acme/core:1" } };
  const coreImage = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  assert.throws(() => renderTaskDefinition(overriddenCore, "core", coreImage), /core\.architecture is required/);

  const sourcePlugin: QmConfig = { ...pluginConfig, plugins: [{ name: "linear" }] };
  assert.equal(renderTaskDefinition(sourcePlugin, "linear", image).runtimePlatform.cpuArchitecture, "ARM64");
});

test("AWS retains built-in health enforcement when an image is overridden", () => {
  const overridden: QmConfig = {
    ...config,
    imageOverrides: { core: "ghcr.io/acme/core:custom" },
    aws: {
      ...config.aws!,
      services: { ...config.aws!.services, core: { ...config.aws!.services.core!, architecture: "amd64" } },
    },
  };
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const container = renderTaskDefinition(overridden, "core", image).containerDefinitions[0]!;
  assert.deepEqual((container.healthCheck as { command: string[] }).command.slice(0, 3), ["CMD", "node", "-e"]);
  assert.match((container.healthCheck as { command: string[] }).command[3]!, /\/healthz/);
});

test("AWS secret upload reads the deployment .env and removes every plaintext staging file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-secrets-"));
  const bin = join(dir, "aws-fake");
  const log = join(dir, "paths.log");
  const operatorSecrets = computedSecrets(config).filter((secret) => secret.managedBy === "operator");
  writeFileSync(join(dir, ".env"), operatorSecrets.map((secret) => `${secret.name}=${TEST_SECRET_VALUE}`).join("\n"));
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1 $2" = "sts get-caller-identity" ]; then
  printf '%s\\n' 123456789012
  exit 0
fi
if [ "$1 $2" = "dynamodb get-item" ]; then
  printf '%s\\n' '{}'
  exit 0
fi
if [ "$1 $2" = "ecs describe-services" ]; then
  printf '%s\\n' '{"services":[{"serviceName":"acme-core","desiredCount":0,"runningCount":0,"tags":[{"key":"Deployment","value":"acme"},{"key":"ManagedBy","value":"terraform"}]},{"serviceName":"acme-web-ui","desiredCount":0,"runningCount":0,"tags":[{"key":"Deployment","value":"acme"},{"key":"ManagedBy","value":"terraform"}]},{"serviceName":"acme-admin","desiredCount":0,"runningCount":0,"tags":[{"key":"Deployment","value":"acme"},{"key":"ManagedBy","value":"terraform"}]},{"serviceName":"acme-portal","desiredCount":0,"runningCount":0,"tags":[{"key":"Deployment","value":"acme"},{"key":"ManagedBy","value":"terraform"}]}],"failures":[]}'
  exit 0
fi
for arg in "$@"; do
  case "$arg" in
    file://*) path="\${arg#file://}"; test -f "$path" || exit 9; printf '%s\\n' "$path" >> "$AWS_SECRET_PATH_LOG" ;;
  esac
done
`,
  );
  chmodSync(bin, 0o755);
  const priorBin = process.env.AWS_BIN;
  const priorLog = process.env.AWS_SECRET_PATH_LOG;
  process.env.AWS_BIN = bin;
  process.env.AWS_SECRET_PATH_LOG = log;
  try {
    await awsSecretsPush(config, dir);
    const paths = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(paths.length, operatorSecrets.length);
    for (const path of paths) {
      assert.equal(existsSync(path), false);
      assert.equal(existsSync(dirname(path)), false);
    }
  } finally {
    if (priorBin === undefined) delete process.env.AWS_BIN;
    else process.env.AWS_BIN = priorBin;
    if (priorLog === undefined) delete process.env.AWS_SECRET_PATH_LOG;
    else process.env.AWS_SECRET_PATH_LOG = priorLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS secret upload rejects active services when no deployment manifest exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-secrets-active-"));
  const secretsConfig: QmConfig = { ...oneServiceConfig(), env: {} };
  const operator = computedSecrets(secretsConfig).filter(
    (secret) => secret.managedBy === "operator" && secret.required,
  );
  writeFileSync(join(dir, ".env"), operator.map((secret) => `${secret.name}=${TEST_SECRET_VALUE}`).join("\n"));
  const fake = statefulAws(dir, secretsConfig);
  try {
    await assert.rejects(
      () => awsSecretsPush(secretsConfig, dir),
      /cannot defer secret activation without a current deployment manifest while workloads are active: core/,
    );
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /ecs describe-services/);
    assert.doesNotMatch(calls, /secretsmanager put-secret-value/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS secret rotation holds the deploy lease across the complete write set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-secret-lease-"));
  const secretsConfig: QmConfig = { ...oneServiceConfig(), env: {} };
  const operator = computedSecrets(secretsConfig).filter(
    (secret) => secret.managedBy === "operator" && secret.required,
  );
  writeFileSync(join(dir, ".env"), operator.map((secret) => `${secret.name}=${TEST_SECRET_VALUE}`).join("\n"));
  const fake = statefulAws(dir, secretsConfig);
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  const taskArn = state.services["acme-core"].taskDefinition;
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const arns = Object.fromEntries(
    computedSecrets(secretsConfig).map((secret) => [
      secret.name,
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf",
    ]),
  );
  state.definitions[taskArn] = renderTaskDefinition(secretsConfig, "core", image, arns);
  state.dynamo = manifestItems([{ id: "current", imageLabel: "release", tasks: { core: taskArn } }], "current");
  writeFileSync(fake.state, JSON.stringify(state));
  try {
    await awsSecretsPush(secretsConfig, dir);
    const calls = readFileSync(fake.log, "utf8");
    const acquire = calls.indexOf("dynamodb put-item");
    const firstWrite = calls.indexOf("secretsmanager put-secret-value");
    const lastWrite = calls.lastIndexOf("secretsmanager put-secret-value");
    const restart = calls.indexOf("ecs update-service");
    const rolloutPoll = calls.indexOf("ecs describe-services", restart);
    const release = calls.indexOf("dynamodb delete-item");
    assert.ok(acquire >= 0 && acquire < firstWrite);
    assert.ok(lastWrite < restart && restart < rolloutPoll && rolloutPoll < release);
    assert.match(calls, /ecs update-service --cluster acme-qm --service acme-core --force-new-deployment/);
    assert.equal(calls.match(/secretsmanager put-secret-value/g)?.length, operator.length);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS secret rotation refuses foreign exact-name services before uploading or restarting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-foreign-secret-rotation-"));
  const secretsConfig: QmConfig = { ...oneServiceConfig(), env: {} };
  const operator = computedSecrets(secretsConfig).filter(
    (secret) => secret.managedBy === "operator" && secret.required,
  );
  writeFileSync(join(dir, ".env"), operator.map((secret) => `${secret.name}=${TEST_SECRET_VALUE}`).join("\n"));
  const fake = statefulAws(dir, secretsConfig, {}, { foreignServiceTags: true });
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  const taskArn = state.services["acme-core"].taskDefinition;
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const arns = Object.fromEntries(
    computedSecrets(secretsConfig).map((secret) => [
      secret.name,
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf",
    ]),
  );
  state.definitions[taskArn] = renderTaskDefinition(secretsConfig, "core", image, arns);
  state.dynamo = manifestItems([{ id: "current", imageLabel: "release", tasks: { core: taskArn } }], "current");
  writeFileSync(fake.state, JSON.stringify(state));
  try {
    await assert.rejects(() => awsSecretsPush(secretsConfig, dir), /ownership tags do not match deployment acme/);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /secretsmanager put-secret-value|ecs update-service/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS secret upload registers and records a task revision for a newly supplied optional secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-optional-secret-"));
  const secretsConfig = oneServiceConfig();
  const required = computedSecrets(secretsConfig).filter(
    (secret) => secret.managedBy === "operator" && secret.required,
  );
  writeFileSync(
    join(dir, ".env"),
    [...required.map((secret) => `${secret.name}=${TEST_SECRET_VALUE}`), "ACME_API_KEY=optional-value"].join("\n"),
  );
  const fake = statefulAws(dir, secretsConfig);
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  const oldTask = state.services["acme-core"].taskDefinition;
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const arns = Object.fromEntries(
    required.map((secret) => [secret.name, "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf"]),
  );
  state.definitions[oldTask] = renderTaskDefinition(secretsConfig, "core", image, arns);
  state.dynamo = manifestItems([{ id: "current", imageLabel: "release", tasks: { core: oldTask } }], "current");
  writeFileSync(fake.state, JSON.stringify(state));
  try {
    await awsSecretsPush(secretsConfig, dir);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /ecs register-task-definition/);
    assert.match(calls, /ecs update-service .*--task-definition/);
    assert.doesNotMatch(calls, /--force-new-deployment/);
    const after = JSON.parse(readFileSync(fake.state, "utf8"));
    const currentId = after.dynamo["deployment/current"].manifestId.S;
    assert.notEqual(currentId, "current");
    const manifest = JSON.parse(after.dynamo[`deployment/manifest/${currentId}`].manifest.S);
    assert.notEqual(manifest.tasks.core, oldTask);
    const names = after.definitions[manifest.tasks.core].containerDefinitions[0].secrets.map(
      (secret: { name: string }) => secret.name,
    );
    assert.ok(names.includes("FLY_RESIDENT_ENV_ACME_API_KEY"));
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS optional-secret activation restores prior tasks when a later service restart fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-secret-compensation-"));
  const secretsConfig = twoServiceConfig();
  const required = computedSecrets(secretsConfig).filter(
    (secret) => secret.managedBy === "operator" && secret.required,
  );
  writeFileSync(
    join(dir, ".env"),
    [...required.map((secret) => `${secret.name}=${TEST_SECRET_VALUE}`), "ACME_API_KEY=optional-value"].join("\n"),
  );
  const fake = statefulAws(dir, secretsConfig, {}, { failForcedDeploymentResponse: true });
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  const oldTasks = {
    core: state.services["acme-core"].taskDefinition,
    "web-ui": state.services["acme-web-ui"].taskDefinition,
  };
  const arns = Object.fromEntries(
    required.map((secret) => [secret.name, "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf"]),
  );
  for (const workload of ["core", "web-ui"] as const) {
    const repository = secretsConfig.aws!.services[workload]!.ecrRepository;
    const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/${repository}@sha256:${"a".repeat(64)}`;
    state.definitions[oldTasks[workload]] = renderTaskDefinition(secretsConfig, workload, image, arns);
  }
  state.dynamo = manifestItems([{ id: "current", imageLabel: "release", tasks: oldTasks }], "current");
  writeFileSync(fake.state, JSON.stringify(state));
  try {
    await assert.rejects(
      () => awsSecretsPush(secretsConfig, dir),
      /did not identify the replacement deployment for web-ui/,
    );
    const after = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(after.services["acme-core"].taskDefinition, oldTasks.core);
    assert.equal(after.dynamo["deployment/current"].manifestId.S, "current");
    const updates = readFileSync(fake.log, "utf8")
      .split("\n")
      .filter((line) => line.includes("ecs update-service"));
    assert.ok(updates.some((line) => line.includes("--service acme-core") && !line.includes(oldTasks.core)));
    assert.ok(updates.some((line) => line.includes("--service acme-core") && line.includes(oldTasks.core)));
    assert.ok(
      updates.some((line) => line.includes("--service acme-web-ui") && line.includes("--force-new-deployment")),
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dual-role secret (core service + sandbox.secretEnv) is delivered under BOTH names on core", () => {
  const dual: QmConfig = {
    ...config,
    sandbox: { ...config.sandbox!, secretEnv: ["ACME_API_KEY", "ANTHROPIC_API_KEY"] },
  };
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const task = renderTaskDefinition(dual, "core", image);
  const secrets = task.containerDefinitions[0]!.secrets as Array<{ name: string; valueFrom: string }>;
  const names = secrets.map((secret) => secret.name);
  assert.ok(names.includes("ANTHROPIC_API_KEY"), "plain name for the core process");
  assert.ok(names.includes("FLY_RESIDENT_ENV_ANTHROPIC_API_KEY"), "renamed variant forwarded into sandboxes");
  assert.ok(names.includes("FLY_RESIDENT_ENV_ACME_API_KEY"));
  assert.ok(!names.includes("ACME_API_KEY"), "a sandbox-only secret is not delivered plain");
  const dualEntries = secrets.filter((secret) => secret.name.endsWith("ANTHROPIC_API_KEY"));
  assert.equal(
    new Set(dualEntries.map((secret) => secret.valueFrom)).size,
    1,
    "both names read the same stored secret",
  );
});

const oneServiceConfig = (name = "core"): QmConfig => ({
  ...config,
  services: ["core"],
  aws: { ...config.aws!, services: { [name]: config.aws!.services[name] ?? config.aws!.services.core! } },
});

const twoServiceConfig = (): QmConfig => ({
  ...config,
  services: ["core", "web-ui"],
  aws: { ...config.aws!, services: { core: config.aws!.services.core!, "web-ui": config.aws!.services["web-ui"]! } },
});

function manifestItems(
  manifests: Array<{
    id: string;
    previous?: string;
    imageLabel?: string;
    sandboxImage?: string;
    dbSnapshot?: string;
    tasks: Record<string, string>;
    imageProvenance?: Record<
      string,
      | { kind: "configured"; source: string }
      | { kind: "source-build"; source?: "plugin" | "checkout"; gitCommit?: string; dirty?: boolean }
    >;
    layer?: { key: string; sha256: string };
  }>,
  current: string,
) {
  const items: Record<string, Record<string, { S: string }>> = {
    "deployment/current": { lockKey: { S: "deployment/current" }, manifestId: { S: current } },
  };
  for (const manifest of manifests) {
    const value = { ...manifest, layer: manifest.layer ?? EMPTY_LAYER, createdAt: "2026-01-01T00:00:00.000Z" };
    items[`deployment/manifest/${manifest.id}`] = {
      lockKey: { S: `deployment/manifest/${manifest.id}` },
      manifest: { S: JSON.stringify(value) },
    };
    if (manifest.imageLabel)
      items[`deployment/label/${manifest.imageLabel}`] = {
        lockKey: { S: `deployment/label/${manifest.imageLabel}` },
        manifestId: { S: manifest.id },
      };
  }
  return items;
}

test("rollback uses a coherent durable manifest across independent service histories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-rollback-"));
  const multi = twoServiceConfig();
  const old = {
    core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:7",
    "web-ui": "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-web-ui:4",
  };
  const current = {
    core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:9",
    "web-ui": "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-web-ui:8",
  };
  const fake = statefulAws(
    dir,
    multi,
    manifestItems(
      [
        { id: "old", tasks: old },
        { id: "current", previous: "old", tasks: current },
      ],
      "current",
    ),
  );
  try {
    await awsRollback(multi);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /--task-definition arn:aws:ecs:us-west-2:123456789012:task-definition\/acme-core:7/);
    assert.match(calls, /--task-definition arn:aws:ecs:us-west-2:123456789012:task-definition\/acme-web-ui:4/);
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(state.dynamo["deployment/current"].manifestId.S, "old");
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS rollback surfaces the pre-deploy database snapshot of the deployment it rolls back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-rollback-snapshot-"));
  const single = oneServiceConfig();
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [
        { id: "old", tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:7" } },
        {
          id: "current",
          previous: "old",
          dbSnapshot: "acme-qm-core-predeploy-current",
          tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:9" },
        },
      ],
      "current",
    ),
  );
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
  try {
    await awsRollback(single);
    const out = lines.join("\n");
    assert.match(out, /rollback restores code and configuration, not data/);
    assert.match(
      out,
      /restore-db-instance-from-db-snapshot --db-snapshot-identifier acme-qm-core-predeploy-current --db-instance-identifier acme-qm-core-restored --region us-west-2, then repoint the stack at the restored instance/,
    );
  } finally {
    console.log = log;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS rollback --to a manifest several steps back surfaces the target's successor snapshot, not the current one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-rollback-snapshot-chain-"));
  const single = oneServiceConfig();
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [
        { id: "a", tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:5" } },
        {
          id: "b",
          previous: "a",
          dbSnapshot: "acme-qm-core-predeploy-b",
          tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:7" },
        },
        {
          id: "c",
          previous: "b",
          dbSnapshot: "acme-qm-core-predeploy-c",
          tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:9" },
        },
      ],
      "c",
    ),
  );
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
  try {
    await awsRollback(single, "a");
    const out = lines.join("\n");
    assert.match(
      out,
      /--db-snapshot-identifier acme-qm-core-predeploy-b --db-instance-identifier acme-qm-core-restored --region us-west-2/,
      "the data restore point is the snapshot taken before the target's successor",
    );
    assert.doesNotMatch(out, /acme-qm-core-predeploy-c/);
  } finally {
    console.log = log;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS rollback surfaces the snapshot even when a rotation manifest sits directly after the target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-rollback-snapshot-rotation-"));
  const single = oneServiceConfig();
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [
        { id: "b", tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:5" } },
        {
          id: "r",
          previous: "b",
          sandboxImage: `registry.fly.io/acme-sandboxes@sha256:${"c".repeat(64)}`,
          tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:5" },
        },
        {
          id: "c",
          previous: "r",
          dbSnapshot: "acme-qm-core-predeploy-c",
          tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:9" },
        },
      ],
      "c",
    ),
  );
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
  try {
    await awsRollback(single, "b");
    assert.match(
      lines.join("\n"),
      /--db-snapshot-identifier acme-qm-core-predeploy-c/,
      "the rotation record between target and deploy does not hide the restore point",
    );
  } finally {
    console.log = log;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback resolves a label through its full-service manifest before mutating ECS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-rollback-label-"));
  const single = oneServiceConfig();
  const target = { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:2" };
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [
        { id: "v2", imageLabel: "release-2", tasks: target },
        { id: "current", previous: "v2", tasks: target },
      ],
      "current",
    ),
  );
  try {
    await awsRollback(single, "release-2");
    assert.match(
      readFileSync(fake.log, "utf8"),
      /--task-definition arn:aws:ecs:us-west-2:123456789012:task-definition\/acme-core:2/,
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS rollback restores the recorded layer without reading the broken current data plane", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-rollback-layer-"));
  const single = oneServiceConfig();
  const task = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:2";
  const oldBody = JSON.stringify({ contract: 1, tools: [], skills: [{ path: "skills/old/SKILL.md", content: "old" }] });
  const currentBody = JSON.stringify({
    contract: 1,
    tools: [],
    skills: [{ path: "skills/current/SKILL.md", content: "current" }],
  });
  const artifact = (id: string, body: string) => ({
    key: `deployment/layers/${id}.json`,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  const oldLayer = artifact("old", oldBody);
  const currentLayer = artifact("current", currentBody);
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [
        { id: "old", tasks: { core: task }, layer: oldLayer },
        { id: "current", previous: "old", tasks: { core: task }, layer: currentLayer },
      ],
      "current",
    ),
  );
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  state.objects[oldLayer.key] = oldBody;
  state.objects[currentLayer.key] = currentBody;
  writeFileSync(fake.state, JSON.stringify(state));
  const priorFetch = globalThis.fetch;
  const priorSecret = process.env.CORE_SIGNING_SECRET;
  const bodies: string[] = [];
  process.env.CORE_SIGNING_SECRET = "test-signing-secret";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== "PUT") {
      return new Response("current release is broken", { status: 503 });
    }
    const body = String(init.body ?? "");
    bodies.push(body);
    return new Response(
      JSON.stringify({
        version: 3,
        contentHash: createHash("sha256").update(body).digest("hex"),
        durable: true,
        status: "applied",
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  try {
    await awsRollback(single, undefined, { configDir: dir });
    assert.deepEqual(bodies, [oldBody]);
    assert.equal(JSON.parse(readFileSync(fake.state, "utf8")).dynamo["deployment/current"].manifestId.S, "old");
  } finally {
    globalThis.fetch = priorFetch;
    if (priorSecret === undefined) delete process.env.CORE_SIGNING_SECRET;
    else process.env.CORE_SIGNING_SECRET = priorSecret;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS rollback of a scaled-to-zero stack defers the layer sync instead of failing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-rollback-down-"));
  const single = oneServiceConfig();
  const oldBody = JSON.stringify({ contract: 1, tools: [], skills: [{ path: "skills/old/SKILL.md", content: "old" }] });
  const currentBody = JSON.stringify({ contract: 1, tools: [], skills: [] });
  const artifact = (id: string, body: string) => ({
    key: `deployment/layers/${id}.json`,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [
        {
          id: "old",
          tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1" },
          layer: artifact("old", oldBody),
        },
        {
          id: "current",
          previous: "old",
          tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:2" },
          layer: artifact("current", currentBody),
        },
      ],
      "current",
    ),
  );
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  state.services["acme-core"].desiredCount = 0;
  state.services["acme-core"].taskDefinition = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:2";
  state.objects[artifact("old", oldBody).key] = oldBody;
  state.objects[artifact("current", currentBody).key] = currentBody;
  writeFileSync(fake.state, JSON.stringify(state));
  const priorFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("no core is running; the layer sync must be deferred");
  }) as typeof fetch;
  try {
    await awsRollback(single, undefined, { configDir: dir });
    const after = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(after.dynamo["deployment/current"].manifestId.S, "old");
    assert.equal(
      after.services["acme-core"].taskDefinition,
      "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1",
    );
    assert.equal(after.services["acme-core"].desiredCount, 0);
  } finally {
    globalThis.fetch = priorFetch;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rollback refuses an incomplete manifest before mutating ECS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-rollback-incomplete-"));
  const multi = twoServiceConfig();
  const fake = statefulAws(
    dir,
    multi,
    manifestItems(
      [
        { id: "old", tasks: { core: "core:1" } },
        { id: "current", previous: "old", tasks: { core: "core:2", "web-ui": "web:2" } },
      ],
      "current",
    ),
  );
  try {
    await assert.rejects(() => awsRollback(multi), /missing workloads: web-ui/);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecs update-service/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets push never creates secret containers outside Terraform", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-push-"));
  const secretsConfig: QmConfig = { ...oneServiceConfig(), env: {} };
  const operator = computedSecrets(secretsConfig).filter(
    (secret) => secret.managedBy === "operator" && secret.required,
  );
  writeFileSync(join(dir, ".env"), operator.map((secret) => `${secret.name}=${TEST_SECRET_VALUE}`).join("\n"));
  const denied = fakeAws(
    dir,
    `
if (a.includes("dynamodb get-item")) console.log("{}");
else if (a.includes("ecs describe-services")) console.log(JSON.stringify({ services: [{ serviceName: "acme-core", desiredCount: 0, runningCount: 0, tags: [{ key: "Deployment", value: "acme" }, { key: "ManagedBy", value: "terraform" }] }], failures: [] }));
else if (a.includes("put-secret-value")) { console.error("An error occurred (AccessDeniedException) when calling the PutSecretValue operation"); process.exit(1); }
console.log("");`,
  );
  try {
    await assert.rejects(() => awsSecretsPush(secretsConfig, dir), /AccessDeniedException/);
    assert.ok(
      !readFileSync(denied.log, "utf8").includes("create-secret"),
      "a non-missing error must not be masked by create-secret",
    );
  } finally {
    denied.restore();
  }
  const missing = fakeAws(
    dir,
    `
if (a.includes("dynamodb get-item")) console.log("{}");
else if (a.includes("ecs describe-services")) console.log(JSON.stringify({ services: [{ serviceName: "acme-core", desiredCount: 0, runningCount: 0, tags: [{ key: "Deployment", value: "acme" }, { key: "ManagedBy", value: "terraform" }] }], failures: [] }));
else if (a.includes("put-secret-value")) { console.error("An error occurred (ResourceNotFoundException) when calling the PutSecretValue operation"); process.exit(1); }
console.log("");`,
  );
  try {
    await assert.rejects(
      () => awsSecretsPush(secretsConfig, dir),
      /apply the rendered Terraform before pushing secrets/,
    );
    assert.doesNotMatch(readFileSync(missing.log, "utf8"), /create-secret/);
  } finally {
    missing.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aws logs never reinterprets --tail and interleaves all workloads instead of blocking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-logs-"));
  const fake = fakeAws(dir, `console.log("line-from-" + process.argv[4]);`);
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
  try {
    awsLogs(oneServiceConfig(), "core", { follow: false, tail: 7 });
    const calls = readFileSync(fake.log, "utf8");
    assert.ok(!calls.includes("--since"), "--tail must not silently become --since");
    assert.ok(
      lines.join("\n").includes("--tail is a docker-only line count"),
      "explicit notice instead of reinterpretation",
    );
    const twoServices = twoServiceConfig();
    await awsLogs(twoServices, undefined, { follow: false });
    const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(out, /core\s*\| line-from-/);
    assert.match(out, /web-ui\s*\| line-from-/);
  } finally {
    console.log = log;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS virtual Slack logs resolve to the core task", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-slack-logs-"));
  const fake = fakeAws(dir, `console.log("");`);
  try {
    awsLogs(oneServiceConfig(), "slack", {});
    assert.match(readFileSync(fake.log, "utf8"), /logs tail \/ecs\/acme-core/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS status batches DescribeServices at the API limit and surfaces failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-status-batches-"));
  const services = Object.fromEntries(
    Array.from({ length: 11 }, (_, index) => {
      const name = index === 0 ? "core" : `plugin-${index}`;
      return [name, { ...config.aws!.services.core!, ecsService: `svc-${index}`, ecrRepository: `repo-${index}` }];
    }),
  );
  const many: QmConfig = {
    ...config,
    services: ["core"],
    plugins: Array.from({ length: 10 }, (_, index) => ({
      name: `plugin-${index + 1}`,
      image: `ghcr.io/acme/plugin-${index + 1}:1`,
    })),
    aws: { ...config.aws!, services },
  };
  const fake = statefulAws(dir, many);
  try {
    awsStatus(many);
    const calls = readFileSync(fake.log, "utf8")
      .split("\n")
      .filter((line) => line.includes("ecs describe-services"));
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every((line) => line.split(" --services ")[1]!.split(" --output ")[0]!.trim().split(/\s+/).length <= 10),
    );
  } finally {
    fake.restore();
  }
  const failed = fakeAws(
    dir,
    `if (a.includes("describe-services")) console.log(JSON.stringify({ failures: [{ arn: "svc", reason: "MISSING" }] })); else console.log("");`,
  );
  try {
    assert.throws(() => awsStatus(oneServiceConfig()), /MISSING/);
  } finally {
    failed.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS down holds the deploy lease across the ECS mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-down-lease-"));
  const fake = statefulAws(dir, oneServiceConfig());
  try {
    await awsDown(oneServiceConfig());
    const calls = readFileSync(fake.log, "utf8");
    const update = calls.indexOf("ecs update-service");
    assert.ok(calls.indexOf("dynamodb put-item") >= 0);
    assert.ok(calls.indexOf("dynamodb put-item") < update);
    const rolloutPoll = calls.indexOf("ecs describe-services", update);
    assert.ok(update < rolloutPoll && rolloutPoll < calls.indexOf("dynamodb delete-item"));
  } finally {
    fake.restore();
  }
  const rolledBack = statefulAws(dir, oneServiceConfig(), {}, { ignoreUpdate: true });
  try {
    await assert.rejects(() => awsDown(oneServiceConfig()), /did not reach the requested state/);
  } finally {
    rolledBack.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS lease acquisition surfaces a held lease and skips release", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-lease-held-"));
  const fake = fakeAws(
    dir,
    `
if (a.includes("dynamodb put-item")) { console.error("An error occurred (ConditionalCheckFailedException) when calling the PutItem operation"); process.exit(1); }
console.log("");`,
  );
  try {
    await assert.rejects(
      withAwsLease(config.aws!, async () => {}),
      /another QM operation holds the "deploy" lease in acme-qm-deploy-locks/,
    );
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /dynamodb delete-item/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS live check rejects downed services and classifies probe errors as live drift", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-live-runtime-"));
  const single = oneServiceConfig();
  const taskArn = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1";
  const fake = statefulAws(dir, single, manifestItems([{ id: "current", tasks: { core: taskArn } }], "current"));
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  state.services["acme-core"].desiredCount = 0;
  writeFileSync(fake.state, JSON.stringify(state));
  try {
    await assert.rejects(
      () => awsCheckLive(single),
      (error: unknown) =>
        error instanceof Error &&
        /0\/0 running/.test(error.message) &&
        (error as { clause?: string }).clause === "aws.live-drift",
    );
  } finally {
    fake.restore();
  }
  const denied = fakeAws(
    dir,
    `if (a.includes("get-secret-value")) { console.error("AccessDeniedException"); process.exit(1); } console.log("");`,
  );
  try {
    await assert.rejects(
      () => awsCheckLive(single),
      (error: unknown) =>
        error instanceof Error &&
        /AccessDeniedException/.test(error.message) &&
        (error as { clause?: string }).clause === "aws.live-drift",
    );
  } finally {
    denied.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS live check with an unresolved sandbox pin still evaluates core runtime health", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-live-unresolved-pin-"));
  const base = oneServiceConfig();
  const single: QmConfig = {
    ...base,
    sandbox: { backend: "sprites", app: "acme-sandboxes", secretEnv: ["ACME_API_KEY"] },
  };
  const taskArn = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1";
  const fake = statefulAws(
    dir,
    single,
    manifestItems([{ id: "current", imageLabel: "release", tasks: { core: taskArn } }], "current"),
    { primaryFailedTasks: true },
  );
  try {
    await assert.rejects(
      () => awsCheckLive(single, { report: false }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /sandbox pin: AWS deploys take the sandbox layer-image pin from the deployment manifest, which has none/,
        );
        assert.match(
          error.message,
          /skipped only the core expected-environment and rendered task-definition comparisons/,
        );
        assert.match(error.message, /core: configured task is not the sole healthy PRIMARY deployment/);
        return true;
      },
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS live check rejects an ingress target group without a healthy target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-live-health-"));
  const single = oneServiceConfig();
  const taskArn = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1";
  const fake = statefulAws(dir, single, manifestItems([{ id: "current", tasks: { core: taskArn } }], "current"));
  const prior = process.env.AWS_FAKE_UNHEALTHY_TARGET;
  process.env.AWS_FAKE_UNHEALTHY_TARGET = "1";
  try {
    await assert.rejects(
      () => awsCheckLive(single),
      (error: unknown) =>
        error instanceof Error &&
        /core target group has no healthy targets/.test(error.message) &&
        (error as { clause?: string }).clause === "aws.live-drift",
    );
  } finally {
    if (prior === undefined) delete process.env.AWS_FAKE_UNHEALTHY_TARGET;
    else process.env.AWS_FAKE_UNHEALTHY_TARGET = prior;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS live check rejects a reachable public URL returning a server error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-live-http-"));
  const single = oneServiceConfig();
  const taskArn = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1";
  const fake = statefulAws(dir, single, manifestItems([{ id: "current", tasks: { core: taskArn } }], "current"));
  const prior = process.env.AWS_FAKE_HTTP_STATUS;
  process.env.AWS_FAKE_HTTP_STATUS = "503";
  try {
    await assert.rejects(
      () => awsCheckLive(single),
      (error: unknown) =>
        error instanceof Error &&
        /public network drift:.*HTTP 503/.test(error.message) &&
        (error as { clause?: string }).clause === "aws.live-drift",
    );
  } finally {
    if (prior === undefined) delete process.env.AWS_FAKE_HTTP_STATUS;
    else process.env.AWS_FAKE_HTTP_STATUS = prior;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS live check uses the package-pinned source image without consulting mutable tags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-live-manifest-"));
  const single = oneServiceConfig();
  const taskArn = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1";
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [
        {
          id: "current",
          imageLabel: "release",
          tasks: { core: taskArn },
          imageProvenance: { core: { kind: "configured", source: manifestRef("core") } },
        },
      ],
      "current",
    ),
  );
  const priorImageState = process.env.AWS_FAKE_IMAGE_STATE;
  const priorAlbDns = process.env.AWS_FAKE_ALB_DNS;
  const priorSecretValue = process.env.AWS_FAKE_SECRET_VALUE;
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  const secretArn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf";
  const arns = Object.fromEntries(computedSecrets(single).map((secret) => [secret.name, secretArn]));
  state.definitions[taskArn] = {
    ...renderTaskDefinition(
      single,
      "core",
      `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`,
      arns,
    ),
    taskDefinitionArn: taskArn,
  };
  writeFileSync(fake.state, JSON.stringify(state));
  const dockerLog = join(dir, "docker.log");
  writeFileSync(dockerLog, "");
  const dockerBin = join(dir, "docker");
  writeFileSync(
    dockerBin,
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(dockerLog)}, process.argv.slice(2).join(" ") + "\\n");\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`,
  );
  chmodSync(dockerBin, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await assert.doesNotReject(() => awsCheckLive(single, { report: false }));
    process.env.AWS_FAKE_SECRET_VALUE = "short";
    await assert.rejects(() => awsCheckLive(single, { report: false }), /secret CORE_SIGNING_SECRET/);
    if (priorSecretValue === undefined) delete process.env.AWS_FAKE_SECRET_VALUE;
    else process.env.AWS_FAKE_SECRET_VALUE = priorSecretValue;
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecr describe-images/);
    assert.doesNotMatch(readFileSync(dockerLog, "utf8"), /buildx imagetools inspect/);
    const overridden: QmConfig = {
      ...single,
      imageOverrides: { core: `ghcr.io/acme/core@sha256:${"b".repeat(64)}` },
      aws: { ...single.aws!, services: { core: { ...single.aws!.services.core!, architecture: "arm64" } } },
    };
    await assert.rejects(
      () => awsCheckLive(overridden, { report: false }),
      new RegExp(`core: image drift .*desired .*@sha256:${"b".repeat(64)}`),
    );
    const afterConfiguredCheck = readFileSync(dockerLog, "utf8");
    const persisted = JSON.parse(readFileSync(fake.state, "utf8"));
    const persistedManifest = JSON.parse(persisted.dynamo["deployment/manifest/current"].manifest.S);
    delete persistedManifest.imageProvenance;
    persisted.dynamo["deployment/manifest/current"].manifest.S = JSON.stringify(persistedManifest);
    writeFileSync(fake.state, JSON.stringify(persisted));
    await assert.doesNotReject(() => awsCheckLive(overridden, { report: false }));
    assert.equal(readFileSync(dockerLog, "utf8"), afterConfiguredCheck);
    persistedManifest.imageProvenance = { core: { kind: "configured", source: manifestRef("core") } };
    persisted.dynamo["deployment/manifest/current"].manifest.S = JSON.stringify(persistedManifest);
    writeFileSync(fake.state, JSON.stringify(persisted));
    process.env.AWS_FAKE_IMAGE_STATE = "FAILED";
    await assert.rejects(
      () => awsCheckLive(single, { report: false }),
      /deploy image drift: AWS deploy image .* version 1 is not SUCCESSFUL and ACTIVE/,
    );
    if (priorImageState === undefined) delete process.env.AWS_FAKE_IMAGE_STATE;
    else process.env.AWS_FAKE_IMAGE_STATE = priorImageState;
    process.env.AWS_FAKE_ALB_DNS = "127.0.0.1";
    await assert.rejects(
      () => awsCheckLive(single, { report: false }),
      /public network drift: AWS public origin .* does not resolve to this stack's ALB 127\.0\.0\.1/,
    );
    if (priorAlbDns === undefined) delete process.env.AWS_FAKE_ALB_DNS;
    else process.env.AWS_FAKE_ALB_DNS = priorAlbDns;
    const otherLabel: QmConfig = { ...single, aws: { ...single.aws!, imageLabel: "other-release" } };
    await assert.rejects(
      () => awsCheckLive(otherLabel, { report: false }),
      /manifest label release does not match configured release other-release/,
    );
  } finally {
    if (priorSecretValue === undefined) delete process.env.AWS_FAKE_SECRET_VALUE;
    else process.env.AWS_FAKE_SECRET_VALUE = priorSecretValue;
    process.env.PATH = priorPath;
    if (priorImageState === undefined) delete process.env.AWS_FAKE_IMAGE_STATE;
    else process.env.AWS_FAKE_IMAGE_STATE = priorImageState;
    if (priorAlbDns === undefined) delete process.env.AWS_FAKE_ALB_DNS;
    else process.env.AWS_FAKE_ALB_DNS = priorAlbDns;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS live check detects prebuilt plugin image drift from current config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-live-plugin-image-"));
  const single = oneServiceConfig();
  const pluginConfig: QmConfig = {
    ...single,
    plugins: [{ name: "linear", image: "ghcr.io/acme/linear:1" }],
    aws: {
      ...single.aws!,
      services: {
        ...single.aws!.services,
        linear: { ecrRepository: "qm-linear", ecsService: "acme-linear", cpu: 256, memory: 512, architecture: "amd64" },
      },
    },
  };
  const tasks = {
    core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1",
    linear: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-linear:1",
  };
  const fake = statefulAws(
    dir,
    pluginConfig,
    manifestItems(
      [
        {
          id: "current",
          imageLabel: "release",
          tasks,
          imageProvenance: {
            core: { kind: "configured", source: "ghcr.io/qm/qm-core:0.1.0" },
            linear: { kind: "configured", source: "ghcr.io/acme/linear:1" },
          },
        },
      ],
      "current",
    ),
  );
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  const secretArn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf";
  const arns = Object.fromEntries(computedSecrets(pluginConfig).map((secret) => [secret.name, secretArn]));
  state.definitions[tasks.core] = {
    ...renderTaskDefinition(
      pluginConfig,
      "core",
      `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`,
      arns,
    ),
    taskDefinitionArn: tasks.core,
  };
  state.definitions[tasks.linear] = {
    ...renderTaskDefinition(
      pluginConfig,
      "linear",
      `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-linear@sha256:${"a".repeat(64)}`,
      arns,
    ),
    taskDefinitionArn: tasks.linear,
  };
  writeFileSync(fake.state, JSON.stringify(state));
  const dockerBin = join(dir, "docker");
  writeFileSync(
    dockerBin,
    `#!/usr/bin/env node\nconsole.log("Digest: sha256:" + (process.argv.at(-1).includes("linear") ? "${"b".repeat(64)}" : "${"a".repeat(64)}"));\n`,
  );
  chmodSync(dockerBin, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await assert.rejects(
      () => awsCheckLive(pluginConfig, { report: false }),
      new RegExp(`linear: image drift .*desired .*qm-linear@sha256:${"b".repeat(64)}`),
    );
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecr describe-images|ecr batch-delete-image/);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS rejects stale service entries after a workload is removed", async () => {
  const single = oneServiceConfig();
  const stale: QmConfig = {
    ...single,
    aws: {
      ...single.aws!,
      services: { ...single.aws!.services, portal: config.aws!.services.portal! },
    },
  };
  const expected = /aws\.services topology mismatch \(disabled workloads: portal\)/;
  await assert.rejects(() => awsUp(stale, process.cwd(), { dryRun: true }), expected);
  await assert.rejects(() => awsCheckLive(stale, { report: false }), expected);
  assert.throws(() => awsStatus(stale), expected);
});

test("AWS up rejects an image label that differs from the durable directory before side effects", async () => {
  await assert.rejects(
    () => awsUp(oneServiceConfig(), process.cwd(), { yes: true, imageLabel: "other" }),
    /differs from durable aws\.imageLabel/,
  );
});

test("AWS plan rejects an explicit nonexistent source checkout before cloud access", async () => {
  await assert.rejects(
    () =>
      awsUp(oneServiceConfig(), process.cwd(), {
        dryRun: true,
        buildFrom: true,
        buildFromPath: "/definitely/not/a/qm/checkout",
      }),
    /not a QM checkout/,
  );
});

test("AWS mutations release the deploy lease when their initial service snapshot fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-snapshot-lease-"));
  const single = oneServiceConfig();
  const run = async (operation: () => void | Promise<void>, preflight = false): Promise<void> => {
    const fake = statefulAws(dir, single, {}, { failDescribe: true });
    try {
      await assert.rejects(async () => operation(), /DescribeServicesFailure/);
      const calls = readFileSync(fake.log, "utf8");
      if (preflight) assert.doesNotMatch(calls, /dynamodb/);
      else {
        assert.ok(calls.indexOf("dynamodb put-item") < calls.indexOf("ecs describe-services"));
        assert.ok(calls.indexOf("ecs describe-services") < calls.indexOf("dynamodb delete-item"));
      }
    } finally {
      fake.restore();
    }
  };
  try {
    await run(() => awsUp(single, dir, { yes: true }), true);
    await run(() => awsRollback(single));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS service rollback includes an update whose successful response was lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-update-response-"));
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single, {}, { failFirstUpdateAfterMutation: true });
  try {
    await assert.rejects(() => awsDown(single), /UpdateServiceResponseLost/);
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(state.services["acme-core"].desiredCount, 1);
    assert.equal(readFileSync(fake.log, "utf8").match(/ecs update-service/g)?.length, 2);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS down refuses foreign exact-name services before acquiring the lease or mutating ECS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-foreign-service-"));
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single, {}, { foreignServiceTags: true });
  try {
    await assert.rejects(() => awsDown(single), /ownership tags do not match deployment acme/);
    const calls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(calls, /dynamodb put-item|ecs update-service/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up refuses foreign exact-name services before acquiring the lease or publishing images", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-foreign-service-up-"));
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single, {}, { foreignServiceTags: true });
  try {
    await assert.rejects(() => awsUp(single, dir, { yes: true }), /ownership tags do not match deployment acme/);
    const calls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(calls, /dynamodb put-item|ecr get-login-password|ecs update-service/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS plan uses the package-pinned source image without consulting or mutating mutable labels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-plan-source-"));
  const single = oneServiceConfig();
  const taskArn = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1";
  const fake = statefulAws(
    dir,
    single,
    manifestItems([{ id: "current", imageLabel: "release", tasks: { core: taskArn } }], "current"),
  );
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  const secretArn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf";
  const arns = Object.fromEntries(computedSecrets(single).map((secret) => [secret.name, secretArn]));
  state.definitions[taskArn] = {
    ...renderTaskDefinition(
      single,
      "core",
      `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"b".repeat(64)}`,
      arns,
    ),
    taskDefinitionArn: taskArn,
  };
  writeFileSync(fake.state, JSON.stringify(state));
  const dockerLog = join(dir, "docker.log");
  writeFileSync(dockerLog, "");
  const dockerBin = join(dir, "docker");
  writeFileSync(
    dockerBin,
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(dockerLog)}, process.argv.slice(2).join(" ") + "\\n");\nconsole.log("Digest: sha256:${"b".repeat(64)}");\n`,
  );
  chmodSync(dockerBin, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
  try {
    await awsUp(single, dir, { dryRun: true });
    const calls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(calls, /ecr describe-images|ecr batch-delete-image|dynamodb put-item|ecs update-service/);
    assert.doesNotMatch(readFileSync(dockerLog, "utf8"), /buildx imagetools inspect/);
    assert.match(lines.join("\n"), new RegExp(`qm-core@sha256:${"a".repeat(64)}`));
  } finally {
    console.log = log;
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aws up resolves image digests only while holding the deploy lease", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-"));
  const dockerLog = join(dir, "docker.log");
  writeFileSync(dockerLog, "");
  const dockerBin = join(dir, "docker");
  writeFileSync(
    dockerBin,
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(dockerLog)}, process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  chmodSync(dockerBin, 0o755);
  const fake = statefulAws(dir, oneServiceConfig());
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  const lines: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
  try {
    await awsUp(oneServiceConfig(), dir, { yes: true });
    const calls = readFileSync(fake.log, "utf8");
    assert.match(
      calls,
      /ecs register-task-definition .*--tags \[\{"key":"ManagedBy","value":"qm-cli"\},\{"key":"Deployment","value":"acme"\}\]/,
    );
    const lease = calls.indexOf("dynamodb put-item");
    const login = calls.indexOf("get-login-password");
    const digest = calls.indexOf("ecr describe-images");
    const update = calls.indexOf("ecs update-service");
    const manifest = calls.indexOf("dynamodb transact-write-items");
    const promotion = calls.indexOf("ecr put-image");
    const cleanup = calls.indexOf("ecr batch-delete-image");
    const release = calls.indexOf("dynamodb delete-item");
    assert.ok(
      [lease, login, digest, update, manifest, promotion, cleanup, release].every((index) => index !== -1),
      calls,
    );
    assert.ok(
      calls.lastIndexOf("lambda-microvms get-microvm-image") > lease,
      "the deploy image is revalidated after acquiring the shared lease",
    );
    assert.ok(lease < login && login < digest, "push + digest resolution happen inside the lease");
    assert.ok(
      digest < update && update < manifest,
      "the staged digest drives ECS before the durable manifest is recorded",
    );
    assert.ok(manifest < promotion, "the stable tag is promoted only after deployment success is durable");
    assert.ok(promotion < cleanup && cleanup < release, "the staging tag is cleaned before releasing the lease");
    const now = Math.floor(Date.now() / 1000);
    const leaseExpiry = Number(calls.match(/dynamodb put-item[^\n]*"expiresAt":\{"N":"(\d+)"\}/)?.[1]);
    assert.ok(leaseExpiry > now && leaseExpiry <= now + 60 * 60 + 5, "the lease uses a bounded TTL");
    const transactions = calls.split("\n").filter((line) => line.includes("dynamodb transact-write-items"));
    assert.equal(transactions.length, 1, "the manifest is one unconditional transaction");
    assert.doesNotMatch(calls, /--client-request-token/);
    assert.doesNotMatch(calls, /dynamodb update-item/);
    assert.match(calls, /ecr batch-delete-image .*imageTag=qm-staging/);
    assert.ok(readFileSync(dockerLog, "utf8").includes("imagetools create"), "the image was pushed via docker");
    assert.match(readFileSync(dockerLog, "utf8"), /--tag [^\s]+\/qm-core:qm-staging/);
  } finally {
    console.log = log;
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up requires a complete trusted baseline before a partial deployment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-partial-up-"));
  const multi = twoServiceConfig();
  const first = statefulAws(dir, multi);
  try {
    await assert.rejects(
      () => awsUp(multi, dir, { dryRun: true, only: ["core"] }),
      /first AWS deployment must include every workload/,
    );
    await assert.rejects(
      () => awsUp(multi, dir, { yes: true, only: ["core"] }),
      /first AWS deployment must include every workload/,
    );
    const calls = readFileSync(first.log, "utf8");
    assert.doesNotMatch(calls, /ecr get-login-password|ecs update-service/);
    assert.match(calls, /dynamodb delete-item/);
  } finally {
    first.restore();
  }

  const tasks = {
    core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1",
    "web-ui": "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-web-ui:1",
  };
  const baseline = statefulAws(
    dir,
    multi,
    manifestItems(
      [
        {
          id: "baseline",
          imageLabel: "previous",
          tasks,
          imageProvenance: {
            core: { kind: "source-build" },
            "web-ui": { kind: "configured", source: "ghcr.io/qm/qm-web-ui:0.1.0" },
          },
        },
      ],
      "baseline",
    ),
  );
  const state = JSON.parse(readFileSync(baseline.state, "utf8"));
  state.definitions[tasks["web-ui"]] = {
    containerDefinitions: [
      {
        name: "web-ui",
        image: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-web-ui@sha256:${"d".repeat(64)}`,
      },
    ],
  };
  writeFileSync(baseline.state, JSON.stringify(state));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(multi, dir, { yes: true, only: ["core"] });
    const after = JSON.parse(readFileSync(baseline.state, "utf8"));
    const currentId = after.dynamo["deployment/current"].manifestId.S;
    const current = JSON.parse(after.dynamo[`deployment/manifest/${currentId}`].manifest.S);
    assert.equal(current.tasks["web-ui"], tasks["web-ui"]);
    assert.deepEqual(current.imageProvenance, {
      core: { kind: "configured", source: manifestRef("core") },
      "web-ui": { kind: "configured", source: "ghcr.io/qm/qm-web-ui:0.1.0" },
    });
  } finally {
    process.env.PATH = priorPath;
    baseline.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up cleans staging tags when ECS deployment fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-cleanup-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const fake = statefulAws(dir, oneServiceConfig(), {}, { ignoreUpdate: true });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await assert.rejects(() => awsUp(oneServiceConfig(), dir, { yes: true }), /did not reach the requested state/);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /ecr batch-delete-image .*imageTag=qm-staging/);
    assert.doesNotMatch(calls, /imageTag=release/);
    assert.ok(calls.indexOf("ecr batch-delete-image") < calls.indexOf("dynamodb delete-item"));
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up succeeds while a protected old task keeps the rollout from completing, even with a historical failed task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-drain-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const drainConfig = (): QmConfig => {
    const base = oneServiceConfig();
    return { ...base, aws: { ...base.aws!, alb: "legacy-alb" } };
  };
  const fake = statefulAws(dir, drainConfig(), {}, { drainRollout: true });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(drainConfig(), dir, { yes: true });
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.ok(state.dynamo["deployment/current"], "deployment manifest recorded despite the draining old task");
    const calls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(calls, /ecs wait services-stable/);
    assert.match(
      calls,
      /elbv2 describe-load-balancers --names legacy-alb/,
      "front-door lookup honors the configured ALB name",
    );
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up tolerates a transient describe-services failure while polling the rollout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-transient-describe-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const fake = statefulAws(dir, oneServiceConfig(), {}, { failDescribeOnceAfterUpdate: true });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(oneServiceConfig(), dir, { yes: true });
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.ok(state.describeFailedOnce, "the transient failure was actually injected");
    assert.ok(state.dynamo["deployment/current"], "deploy succeeded despite the transient poll failure");
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up aborts failed tasks only after four polls with no replacement running — longer than any single ENI/pull flake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-failed-tasks-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const fake = statefulAws(dir, oneServiceConfig(), {}, { primaryFailedTasks: true });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await assert.rejects(
      () => awsUp(oneServiceConfig(), dir, { yes: true }),
      /keeps failing tasks with no replacement starting \(failedTasks=1, 0\/1 running across \d+ polls\)/,
    );
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up survives a three-poll failed-task flake that ECS replaces — the window a transient ENI/pull failure needs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-transient-failed-task-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const fake = statefulAws(dir, oneServiceConfig(), {}, { transientFailedTaskPolls: 3 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(oneServiceConfig(), dir, { yes: true });
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.ok(state.failedTaskPolls >= 3, "the failed-task polls were actually served");
    assert.ok(state.dynamo["deployment/current"], "deploy succeeded despite the transient task failure");
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up survives alternating single-service stale reads — only the same workload's same failure on consecutive polls confirms an abort", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-alternating-stale-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const multi = twoServiceConfig();
  const fake = statefulAws(dir, multi, {}, { alternateStaleReadPolls: 4 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(multi, dir, { yes: true });
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.ok(state.stalePolls >= 4, "the alternating stale reads were actually served");
    assert.ok(
      state.dynamo["deployment/current"],
      "deploy succeeded despite four polls of alternating transient failures",
    );
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up still fails fast on a FAILED rollout state — the ECS circuit-breaker verdict needs no flake window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-rollout-failed-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const fake = statefulAws(dir, oneServiceConfig(), {}, { rolloutFailed: true });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await assert.rejects(() => awsUp(oneServiceConfig(), dir, { yes: true }), /PRIMARY rollout is FAILED/);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up preserves the staging tag when stable-label promotion fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-promotion-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const fake = statefulAws(dir, oneServiceConfig(), {}, { failPromotion: true });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(oneServiceConfig(), dir, { yes: true });
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /dynamodb transact-write-items/);
    assert.doesNotMatch(calls, /ecr batch-delete-image .*imageTag=qm-/);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up treats an already-current stable label as successful promotion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-current-label-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const fake = statefulAws(dir, oneServiceConfig(), {}, { promotionAlreadyCurrent: true });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(oneServiceConfig(), dir, { yes: true });
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /ecr put-image/);
    assert.match(calls, /ecr batch-delete-image .*imageTag=qm-staging/);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up keeps a healthy rollout and its staging tag when the manifest write fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-manifest-failure-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const fake = statefulAws(dir, oneServiceConfig(), {}, { failTransactions: true });
  const initialTask = JSON.parse(readFileSync(fake.state, "utf8")).services["acme-core"].taskDefinition;
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await assert.rejects(
      () => awsUp(oneServiceConfig(), dir, { yes: true }),
      /AWS deployment manifest write failed[\s\S]*check --live/,
    );
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.notEqual(state.services["acme-core"].taskDefinition, initialTask);
    assert.equal(state.dynamo["deployment/current"], undefined);
    const calls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(calls, /ecr batch-delete-image .*imageTag=qm-staging/);
    assert.ok(calls.indexOf("dynamodb transact-write-items") < calls.indexOf("dynamodb delete-item"));
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS rejects the Fly sandbox pin on MicroVM stacks and a frozen config override", async () => {
  const { sandbox: _sandbox, ...microvm } = config;
  const image = `registry.fly.io/acme-sandboxes@sha256:${"c".repeat(64)}`;
  await assert.rejects(() => awsPinSandbox(microvm as QmConfig, image), /Lambda MicroVM sandboxes.*infra build-image/);
  await assert.rejects(() => awsPinSandbox(config, image), /freezes the sandbox pin/);
});

const flySandboxPinlessConfig = (): QmConfig => ({
  ...oneServiceConfig(),
  sandbox: { backend: "sprites", app: "acme-sandboxes" },
});

const CORE_TASK = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1";
const CORE_IMAGE = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
const NEW_PIN = `registry.fly.io/acme-sandboxes@sha256:${"c".repeat(64)}`;
const OLD_PIN = `registry.fly.io/acme-sandboxes@sha256:${"b".repeat(64)}`;
const FAILED_PIN = `registry.fly.io/acme-sandboxes@sha256:${"d".repeat(64)}`;
const REBUILT_PIN = `registry.fly.io/acme-sandboxes@sha256:${"e".repeat(64)}`;

function seedCoreDefinition(statePath: string): void {
  const single = flySandboxPinlessConfig();
  const arns = Object.fromEntries(
    computedSecrets(single).map((secret) => [
      secret.name,
      "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf",
    ]),
  );
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.definitions[CORE_TASK] = renderTaskDefinition(
    { ...single, sandbox: { ...single.sandbox!, image: OLD_PIN } },
    "core",
    CORE_IMAGE,
    arns,
  );
  writeFileSync(statePath, JSON.stringify(state));
}

function currentManifestOf(statePath: string): { id: string; manifest: Record<string, unknown> } {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const id = state.dynamo["deployment/current"].manifestId.S as string;
  return { id, manifest: JSON.parse(state.dynamo[`deployment/manifest/${id}`].manifest.S) as Record<string, unknown> };
}

function coreTaskEnv(statePath: string): { task: string; env: Record<string, string> } {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const task = state.services["acme-core"].taskDefinition as string;
  const container = (state.definitions[task].containerDefinitions as Array<Record<string, unknown>>).find(
    (item) => item.name === "core",
  )!;
  const env = Object.fromEntries(
    (container.environment as Array<{ name: string; value: string }>).map((item) => [item.name, item.value]),
  ) as Record<string, string>;
  return { task, env };
}

test("sandbox pin repoints a live core through a re-rendered task and records the manifest under the deployed baseline's label", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-pin-live-"));
  const single = flySandboxPinlessConfig();
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [{ id: "baseline", imageLabel: "previous", sandboxImage: OLD_PIN, tasks: { core: CORE_TASK } }],
      "baseline",
    ),
    { failTransactionPuts: 2 },
  );
  seedCoreDefinition(fake.state);
  try {
    await awsPinSandbox(single, NEW_PIN);
    const { task, env } = coreTaskEnv(fake.state);
    assert.notEqual(task, CORE_TASK, "core was repointed to a re-rendered task definition");
    assert.equal(env.FLY_BASE_IMAGE, NEW_PIN, "the re-rendered task boots sandboxes from the published pin");
    const { id, manifest } = currentManifestOf(fake.state);
    assert.equal(manifest.sandboxImage, NEW_PIN);
    assert.deepEqual(manifest.tasks, { core: task });
    assert.equal(manifest.previous, "baseline");
    assert.equal(
      manifest.imageLabel,
      "previous",
      "the pin manifest keeps the deployed baseline's label, not the bumped aws.imageLabel",
    );
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(state.dynamo["deployment/label/previous"].manifestId.S, id);
    assert.equal(state.transactAttempts, 3, "two transient manifest-write failures are absorbed by in-process retries");
    assert.match(readFileSync(fake.log, "utf8"), /ecs update-service .*--service acme-core/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox pin on a scaled-to-zero core records a carried manifest without touching ECS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-pin-carried-"));
  const single = flySandboxPinlessConfig();
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [{ id: "baseline", imageLabel: "previous", sandboxImage: OLD_PIN, tasks: { core: CORE_TASK } }],
      "baseline",
    ),
  );
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  state.services["acme-core"].desiredCount = 0;
  writeFileSync(fake.state, JSON.stringify(state));
  try {
    await awsPinSandbox(single, NEW_PIN);
    const { id, manifest } = currentManifestOf(fake.state);
    assert.notEqual(id, "baseline");
    assert.equal(manifest.sandboxImage, NEW_PIN);
    assert.deepEqual(
      manifest.tasks,
      { core: CORE_TASK },
      "the pin is carried on the recorded tasks; it takes effect on the next up",
    );
    assert.equal(manifest.imageLabel, "previous");
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecs update-service|ecs register-task-definition/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed sandbox-pin rollout restores the prior core task and records no manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-pin-rollback-"));
  const single = flySandboxPinlessConfig();
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [{ id: "baseline", imageLabel: "previous", sandboxImage: OLD_PIN, tasks: { core: CORE_TASK } }],
      "baseline",
    ),
    { ignoreUpdate: true },
  );
  seedCoreDefinition(fake.state);
  try {
    await assert.rejects(() => awsPinSandbox(single, NEW_PIN), /did not reach the requested state/);
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(state.services["acme-core"].taskDefinition, CORE_TASK);
    assert.equal(state.dynamo["deployment/current"].manifestId.S, "baseline");
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /ecs update-service .*--service acme-core/);
    assert.doesNotMatch(calls, /dynamodb transact-write-items/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a manifest-write failure after the pin repoint is recoverable: the retry records it and up keeps the published pin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-pin-manifest-failure-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const single = flySandboxPinlessConfig();
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [{ id: "baseline", imageLabel: "release", sandboxImage: OLD_PIN, tasks: { core: CORE_TASK } }],
      "baseline",
    ),
    { failTransactionPuts: 3 },
  );
  seedCoreDefinition(fake.state);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await assert.rejects(() => awsPinSandbox(single, NEW_PIN), /rerun `qm sandbox publish` to record the pin/);
    const half = JSON.parse(readFileSync(fake.state, "utf8"));
    const repointed = half.services["acme-core"].taskDefinition as string;
    assert.notEqual(repointed, CORE_TASK, "the live repoint stays applied");
    assert.equal(
      half.dynamo["deployment/current"].manifestId.S,
      "baseline",
      "the durable manifest still names the stale pin",
    );

    await awsPinSandbox(single, NEW_PIN);
    const retried = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(retried.services["acme-core"].taskDefinition, repointed, "the retry records without another repoint");
    const { manifest } = currentManifestOf(fake.state);
    assert.equal(manifest.sandboxImage, NEW_PIN);
    assert.deepEqual(manifest.tasks, { core: repointed });

    await awsUp(single, dir, { yes: true });
    const { env } = coreTaskEnv(fake.state);
    assert.equal(env.FLY_BASE_IMAGE, NEW_PIN, "up resolves the recorded pin instead of reverting the published image");
    assert.equal(currentManifestOf(fake.state).manifest.sandboxImage, NEW_PIN);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a manifest-write failure rerun with a different digest still converges: publish repoints to the rebuilt pin and up keeps it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-pin-rerun-digest-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const single = flySandboxPinlessConfig();
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [{ id: "baseline", imageLabel: "release", sandboxImage: OLD_PIN, tasks: { core: CORE_TASK } }],
      "baseline",
    ),
    { failTransactionPuts: 3 },
  );
  seedCoreDefinition(fake.state);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await assert.rejects(() => awsPinSandbox(single, FAILED_PIN), /rerun `qm sandbox publish` to record the pin/);
    const half = coreTaskEnv(fake.state);
    assert.notEqual(half.task, CORE_TASK, "the repoint to the failed pin stays applied");
    assert.equal(half.env.FLY_BASE_IMAGE, FAILED_PIN);
    assert.equal(
      currentManifestOf(fake.state).manifest.sandboxImage,
      OLD_PIN,
      "the durable manifest still names the previous pin",
    );

    await awsPinSandbox(single, REBUILT_PIN);
    const rerun = coreTaskEnv(fake.state);
    assert.equal(rerun.env.FLY_BASE_IMAGE, REBUILT_PIN, "the rerun repoints core to the rebuilt digest");
    const { manifest } = currentManifestOf(fake.state);
    assert.equal(manifest.sandboxImage, REBUILT_PIN);
    assert.deepEqual(manifest.tasks, { core: rerun.task });

    await awsUp(single, dir, { yes: true });
    assert.equal(
      coreTaskEnv(fake.state).env.FLY_BASE_IMAGE,
      REBUILT_PIN,
      "up keeps the rerun's pin instead of reverting it",
    );
    assert.equal(currentManifestOf(fake.state).manifest.sandboxImage, REBUILT_PIN);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish refuses to record a core manually repointed at a different workload image", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-pin-manual-repoint-"));
  const single = flySandboxPinlessConfig();
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [{ id: "baseline", imageLabel: "release", sandboxImage: OLD_PIN, tasks: { core: CORE_TASK } }],
      "baseline",
    ),
  );
  seedCoreDefinition(fake.state);
  try {
    await awsPinSandbox(single, NEW_PIN);
    const recorded = currentManifestOf(fake.state);
    const deployedTask = (recorded.manifest.tasks as Record<string, string>).core!;

    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    const manual = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:99";
    const definition = structuredClone(state.definitions[deployedTask]) as {
      taskDefinitionArn: string;
      containerDefinitions: Array<{ image: string }>;
    };
    definition.taskDefinitionArn = manual;
    definition.containerDefinitions[0]!.image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"9".repeat(64)}`;
    state.definitions[manual] = definition;
    state.services["acme-core"].taskDefinition = manual;
    writeFileSync(fake.state, JSON.stringify(state));

    await assert.rejects(
      () => awsPinSandbox(single, NEW_PIN),
      /differs from the deployment manifest's core task beyond the sandbox pin; run `qm up --yes` to converge first/,
    );
    const after = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(
      after.dynamo["deployment/current"].manifestId.S,
      recorded.id,
      "the manual task is never recorded as the manifest's core task",
    );
    assert.equal(
      after.services["acme-core"].taskDefinition,
      manual,
      "publish mutates nothing before the converge guard",
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("up resolves the sandbox pin from the deployment manifest once the config override is removed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-pin-from-manifest-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const single = flySandboxPinlessConfig();
  const fake = statefulAws(
    dir,
    single,
    manifestItems(
      [{ id: "baseline", imageLabel: "release", sandboxImage: NEW_PIN, tasks: { core: CORE_TASK } }],
      "baseline",
    ),
  );
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(single, dir, { yes: true });
    const { task, env } = coreTaskEnv(fake.state);
    assert.equal(
      env.FLY_BASE_IMAGE,
      NEW_PIN,
      "core boots sandboxes from the manifest-recorded pin without a config override",
    );
    const { manifest } = currentManifestOf(fake.state);
    assert.equal(manifest.sandboxImage, NEW_PIN);
    assert.equal((manifest.tasks as Record<string, string>).core, task);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("up on a fly-sandbox stack fails closed before mutation when no pin source or no sandbox.app exists", async () => {
  const single = flySandboxPinlessConfig();
  const bareDir = mkdtempSync(join(tmpdir(), "qm-aws-pin-missing-"));
  const bare = statefulAws(bareDir, single);
  try {
    await assert.rejects(() => awsUp(single, bareDir, { yes: true }), /first deploy on this stack set sandbox\.image/);
    assert.doesNotMatch(
      readFileSync(bare.log, "utf8"),
      /rds create-db-snapshot|ecr get-login-password|ecs update-service|s3api put-object/,
    );
  } finally {
    bare.restore();
    rmSync(bareDir, { recursive: true, force: true });
  }
  const noApp: QmConfig = { ...single, sandbox: { backend: "sprites" } };
  const noAppDir = mkdtempSync(join(tmpdir(), "qm-aws-pin-no-app-"));
  const fake = statefulAws(
    noAppDir,
    noApp,
    manifestItems(
      [{ id: "baseline", imageLabel: "release", sandboxImage: NEW_PIN, tasks: { core: CORE_TASK } }],
      "baseline",
    ),
  );
  try {
    await assert.rejects(() => awsUp(noApp, noAppDir, { dryRun: true }), /no sandbox\.app to boot it in/);
  } finally {
    fake.restore();
    rmSync(noAppDir, { recursive: true, force: true });
  }
});

test("an --only deploy that skips core needs no pin source and records the pin baked into the carried core task", async () => {
  const tasks = {
    core: CORE_TASK,
    "web-ui": "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-web-ui:1",
  };
  const seedWorkloads = (statePath: string): void => {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.definitions[CORE_TASK] = { containerDefinitions: [{ name: "core", image: CORE_IMAGE }] };
    writeFileSync(statePath, JSON.stringify(state));
  };

  const overrideDir = mkdtempSync(join(tmpdir(), "qm-aws-only-pin-carry-"));
  const dockerBin = join(overrideDir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const overridden = twoServiceConfig();
  const bakedPin = `registry.fly.io/acme-sandboxes@sha256:${"9".repeat(64)}`;
  assert.notEqual(overridden.sandbox!.image, bakedPin);
  const carried = statefulAws(
    overrideDir,
    overridden,
    manifestItems([{ id: "baseline", imageLabel: "previous", sandboxImage: bakedPin, tasks }], "baseline"),
  );
  seedWorkloads(carried.state);
  const priorPath = process.env.PATH;
  process.env.PATH = `${overrideDir}:${priorPath}`;
  try {
    await awsUp(overridden, overrideDir, { yes: true, only: ["web-ui"] });
    const { manifest } = currentManifestOf(carried.state);
    assert.equal(
      manifest.sandboxImage,
      bakedPin,
      "the recorded pin is the one baked into the carried core task, not the config override",
    );
    assert.equal((manifest.tasks as Record<string, string>).core, CORE_TASK);
  } finally {
    process.env.PATH = priorPath;
    carried.restore();
    rmSync(overrideDir, { recursive: true, force: true });
  }

  const pinlessDir = mkdtempSync(join(tmpdir(), "qm-aws-only-pinless-"));
  const pinlessDocker = join(pinlessDir, "docker");
  writeFileSync(pinlessDocker, "#!/bin/sh\nexit 0\n");
  chmodSync(pinlessDocker, 0o755);
  const pinless: QmConfig = { ...twoServiceConfig(), sandbox: { backend: "sprites", app: "acme-sandboxes" } };
  const bare = statefulAws(
    pinlessDir,
    pinless,
    manifestItems([{ id: "baseline", imageLabel: "previous", tasks }], "baseline"),
  );
  seedWorkloads(bare.state);
  process.env.PATH = `${pinlessDir}:${priorPath}`;
  try {
    await awsUp(pinless, pinlessDir, { yes: true, only: ["web-ui"] });
    const { manifest } = currentManifestOf(bare.state);
    assert.equal(manifest.sandboxImage, undefined, "a core-less deploy never needs a pin on a pin-less stack");
    assert.equal((manifest.tasks as Record<string, string>).core, CORE_TASK);
  } finally {
    process.env.PATH = priorPath;
    bare.restore();
    rmSync(pinlessDir, { recursive: true, force: true });
  }
});

test("AWS front door tolerates exactly one extra port-80 HTTPS-redirect listener; any other extra listener still fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-front-door-listeners-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  const run = async (mode: "redirect" | "forward" | undefined, expected?: RegExp): Promise<void> => {
    const fake = statefulAws(dir, oneServiceConfig());
    const prior = process.env.AWS_FAKE_EXTRA_HTTP_LISTENER;
    if (mode) process.env.AWS_FAKE_EXTRA_HTTP_LISTENER = mode;
    try {
      if (expected) await assert.rejects(() => awsUp(oneServiceConfig(), dir, { dryRun: true }), expected);
      else await awsUp(oneServiceConfig(), dir, { dryRun: true });
    } finally {
      if (prior === undefined) delete process.env.AWS_FAKE_EXTRA_HTTP_LISTENER;
      else process.env.AWS_FAKE_EXTRA_HTTP_LISTENER = prior;
      fake.restore();
    }
  };
  try {
    await run(undefined);
    await run("redirect");
    await run(
      "forward",
      /expected exactly one public listener plus at most one port-80 HTTPS-redirect listener, found HTTPS:443 \(default fixed-response\), HTTP:80 \(default forward\)/,
    );
  } finally {
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS live check accepts a successful deploy mid-drain: PRIMARY at full strength (historical failed task included) while a protected old task keeps the rollout IN_PROGRESS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-check-drain-"));
  const single = oneServiceConfig();
  const taskArn = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1";
  const fake = statefulAws(
    dir,
    single,
    manifestItems([{ id: "current", imageLabel: "release", tasks: { core: taskArn } }], "current"),
    { drainRollout: true },
  );
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  const secretArn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf";
  const arns = Object.fromEntries(computedSecrets(single).map((secret) => [secret.name, secretArn]));
  state.definitions[taskArn] = {
    ...renderTaskDefinition(
      single,
      "core",
      `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`,
      arns,
    ),
    taskDefinitionArn: taskArn,
  };
  writeFileSync(fake.state, JSON.stringify(state));
  try {
    await assert.doesNotReject(() => awsCheckLive(single, { report: false, configDir: dir }));
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS renders config secretEnv extras and aliases as Secrets Manager references", () => {
  const extras: QmConfig = {
    ...config,
    secretEnv: {
      core: { OPENAI_API_KEY: "OPENAI_API_KEY", DEPLOY_APPS_SESSION_SECRET: "PORTAL_SESSION_SECRET" },
      slack: { SLACK_AUX_BOT_TOKEN: "SLACK_AUX_BOT_TOKEN" },
    },
  };
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const task = renderTaskDefinition(extras, "core", image, { PORTAL_SESSION_SECRET: "arn:resolved:portal-session" });
  const secrets = Object.fromEntries(
    (task.containerDefinitions[0]!.secrets as Array<{ name: string; valueFrom: string }>).map((s) => [
      s.name,
      s.valueFrom,
    ]),
  );
  assert.equal(secrets.OPENAI_API_KEY, "arn:aws:secretsmanager:us-west-2:123456789012:secret:acme/qm/OPENAI_API_KEY");
  assert.equal(
    secrets.SLACK_AUX_BOT_TOKEN,
    "arn:aws:secretsmanager:us-west-2:123456789012:secret:acme/qm/SLACK_AUX_BOT_TOKEN",
    "a virtual service's extra folds onto the core task",
  );
  assert.equal(
    secrets.DEPLOY_APPS_SESSION_SECRET,
    "arn:resolved:portal-session",
    "an alias delivers the stored secret under its declared env name",
  );
  assert.equal(secrets.PORTAL_SESSION_SECRET, undefined, "the alias adds no plain-name delivery on core");
  const portalImage = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-portal@sha256:${"a".repeat(64)}`;
  const portalSecrets = (
    renderTaskDefinition(extras, "portal", portalImage).containerDefinitions[0]!.secrets as Array<{ name: string }>
  ).map((s) => s.name);
  assert.ok(portalSecrets.includes("PORTAL_SESSION_SECRET"), "the portal keeps its own plain delivery");
  assert.ok(!portalSecrets.includes("DEPLOY_APPS_SESSION_SECRET"));
});

test("env.core.SANDBOX_BACKEND adopts the deployment's substrate; the default is sprites", () => {
  assert.equal(serviceEnvironment(config, "core").SANDBOX_BACKEND, "sprites");
  const adopted: QmConfig = {
    ...config,
    env: { ...config.env, core: { ...config.env.core, SANDBOX_BACKEND: "sprites" } },
  };
  assert.equal(serviceEnvironment(adopted, "core").SANDBOX_BACKEND, "sprites");
});

test("env.core.S3_BUCKET adopts a pre-existing snapshot bucket; the derived object store remains the default", () => {
  assert.equal(serviceEnvironment(config, "core").S3_BUCKET, awsObjectStoreBucket(config));
  const adopted: QmConfig = {
    ...config,
    env: { ...config.env, core: { ...config.env.core, S3_BUCKET: "acme-prod-snapshots" } },
  };
  assert.equal(serviceEnvironment(adopted, "core").S3_BUCKET, "acme-prod-snapshots");
});

test("AWS renders adopted logGroup and stopTimeout pins; the defaults stay derived", () => {
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const derived = renderTaskDefinition(config, "core", image).containerDefinitions[0]!;
  assert.equal(
    (derived.logConfiguration as { options: Record<string, string> }).options["awslogs-group"],
    "/ecs/acme-core",
  );
  assert.equal(derived.stopTimeout, undefined);
  const adopted: QmConfig = {
    ...config,
    aws: {
      ...config.aws!,
      services: {
        ...config.aws!.services,
        core: { ...config.aws!.services.core!, logGroup: "/ecs/legacy-core", stopTimeout: 120 },
      },
    },
  };
  const container = renderTaskDefinition(adopted, "core", image).containerDefinitions[0]!;
  assert.equal(
    (container.logConfiguration as { options: Record<string, string> }).options["awslogs-group"],
    "/ecs/legacy-core",
  );
  assert.equal(container.stopTimeout, 120);
});

test("AWS doctor classifies an un-pushed secret store as pending, not drift", () => {
  const rnf = new Error(
    "An error occurred (ResourceNotFoundException) when calling the GetSecretValue operation: Secrets Manager can't find the specified secret.",
  );
  const secrets = computedSecrets({
    contract: 1,
    orgId: "acme",
    publicUrl: "https://acme.example.com",
    target: "aws",
    services: ["core"],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
  });
  const requiredNames = secrets.filter((secret) => secret.required).map((secret) => secret.name);
  assert.ok(requiredNames.length > 0);
  const probe = probeAwsSecretStore(
    secrets,
    () => {
      throw rnf;
    },
    () => assert.fail("PUBLIC_API_URL must not be validated when the store is empty"),
  );
  assert.deepEqual(probe.pending, requiredNames);
  assert.deepEqual(probe.failures, []);
  assert.equal(probe.values.size, 0);
});

test("AWS doctor still fails a pushed secret store holding a placeholder value", () => {
  const probe = probeAwsSecretStore(
    [
      {
        name: "CORE_SIGNING_SECRET",
        services: ["core"],
        description: "",
        required: true,
        managedBy: "operator",
      },
    ],
    () => "replace-me",
    () => {},
  );
  assert.deepEqual(probe.pending, []);
  assert.equal(probe.failures.length, 1);
  assert.match(probe.failures[0]!, /CORE_SIGNING_SECRET: missing, placeholder, or insecure value/);
});
