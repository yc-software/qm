import test from "node:test";
import https from "node:https";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertAwsDeploymentStorage,
  assertAwsServiceDiscovery,
  assertAwsPublicListener,
  assertAwsPublicRouting,
  assertGithubDeployTrust,
  awsCheckLive,
  awsCoreRequest,
  awsBackgroundWorkBootState,
  awsDeploymentLayerTransport,
  awsDown,
  awsLogs,
  awsMigrateCandidate,
  awsRollback,
  awsSecretsPush,
  awsSetBackgroundWork,
  taskDefinitionForBackgroundWork,
  awsStatus,
  awsUp,
  githubTrustSubject,
  imageTransferArgs,
  isPinnedWorkloadImage,
  probeAwsSecretStore,
  renderTaskDefinition,
  secretArns,
  serviceEnvironment,
  taskDefinitionChanges,
  taskDefinitionDiff,
  awsTargetGroupName,
} from "../src/backends/aws.ts";
import type { QmConfig } from "../src/config.ts";
import { runnableServices } from "../src/services.ts";
import { computedSecrets } from "../src/secrets.ts";
import { awsObjectStoreBucket } from "../src/terraform.ts";
import { withAwsLease } from "../src/aws-lease.ts";
import { manifestRef } from "../src/manifest.ts";
import { hostingProvider } from "../src/backends/registry.ts";
import { awsCoreHostnames } from "../src/aws-routing.ts";

process.env.QM_AWS_ROLLOUT_POLL_MS = "5";
process.env.QM_AWS_LIVE_PROBE_POLL_MS = "5";
process.env.QM_AWS_LIVE_PROBE_DEADLINE_MS = "20";

const EMPTY_LAYER_BODY = JSON.stringify({ contract: 1, tools: [], skills: [] });
const EMPTY_LAYER = {
  key: "deployment/layers/empty.json",
  sha256: createHash("sha256").update(EMPTY_LAYER_BODY).digest("hex"),
};
const TEST_SECRET_VALUE = "test-secret-value".repeat(3);

const targetGroupArn = (name: string, revision = 1): string =>
  `arn:aws:elasticloadbalancing:us-west-2:123456789012:targetgroup/${name}/${revision}`;
const frontDoorAlternate = "front-door-alternate";
const productionRuleArn = (route: string): string =>
  `arn:aws:elasticloadbalancing:us-west-2:123456789012:listener-rule/app/test/1/2/${route}`;

interface FrontDoor {
  blueGreen?: boolean;
  frontDoorTargetGroup?: string;
  apiHosts?: string[];
  apiTargetGroup?: string;
}

const coreApiAlternate = "core-api-alternate";

function frontDoorAttachments(door: FrontDoor): Array<Record<string, unknown>> {
  const attachment = (route: string, name: string, alternate: string, containerPort: number) => ({
    targetGroupArn: targetGroupArn(name),
    containerName: "core",
    containerPort,
    ...(door.blueGreen
      ? {
          advancedConfiguration: {
            alternateTargetGroupArn: targetGroupArn(alternate, 2),
            productionListenerRule: productionRuleArn(route),
          },
        }
      : {}),
  });
  return [
    attachment(
      "core-public",
      door.frontDoorTargetGroup ?? awsTargetGroupName(config, "core-public"),
      frontDoorAlternate,
      8000,
    ),
    ...(door.apiHosts?.length ? [attachment("core", door.apiTargetGroup ?? "core-api", coreApiAlternate, 8080)] : []),
  ];
}

function coreApiRoute(door: FrontDoor): {
  groups: Array<{ TargetGroupArn: string; TargetGroupName: string }>;
  rules: Array<Record<string, unknown>>;
} {
  if (!door.apiHosts?.length) return { groups: [], rules: [] };
  const name = door.apiTargetGroup ?? "core-api";
  const primary = targetGroupArn(name);
  const alternate = targetGroupArn(coreApiAlternate, 2);
  return {
    groups: [
      { TargetGroupArn: primary, TargetGroupName: name },
      ...(door.blueGreen ? [{ TargetGroupArn: alternate, TargetGroupName: coreApiAlternate }] : []),
    ],
    rules: [
      {
        RuleArn: productionRuleArn("core"),
        Priority: "1000",
        IsDefault: false,
        Actions: [
          door.blueGreen
            ? {
                Type: "forward",
                ForwardConfig: {
                  TargetGroups: [
                    { TargetGroupArn: primary, Weight: 1 },
                    { TargetGroupArn: alternate, Weight: 0 },
                  ],
                },
              }
            : { Type: "forward", TargetGroupArn: primary },
        ],
        Conditions: [{ Field: "host-header", HostHeaderConfig: { Values: door.apiHosts } }],
      },
    ],
  };
}

function fakeAws(
  dir: string,
  script: string,
  ingress: FrontDoor & {
    sharedHost?: string;
    sharedAppsHost?: string;
    siblingHost?: string;
    siblingAppsHost?: string;
    siblingOwnTarget?: boolean;
    statefulTargetHealth?: boolean;
  } = {},
): { log: string; restore: () => void } {
  const bin = join(dir, "aws-fake");
  const log = join(dir, "aws.log");
  const frontDoorName = ingress.frontDoorTargetGroup ?? awsTargetGroupName(config, "core-public");
  const targetArn = targetGroupArn(frontDoorName);
  const alternateArn = targetGroupArn(frontDoorAlternate, 2);
  const groups = [
    { TargetGroupArn: targetArn, TargetGroupName: frontDoorName },
    ...(ingress.blueGreen ? [{ TargetGroupArn: alternateArn, TargetGroupName: frontDoorAlternate }] : []),
    ...coreApiRoute(ingress).groups,
  ];
  const baseRules: Array<Record<string, unknown>> = ingress.blueGreen
    ? [
        {
          RuleArn: productionRuleArn("core-public"),
          Priority: "50000",
          IsDefault: false,
          Actions: [
            {
              Type: "forward",
              ForwardConfig: {
                TargetGroups: [
                  { TargetGroupArn: targetArn, Weight: 1 },
                  { TargetGroupArn: alternateArn, Weight: 0 },
                ],
              },
            },
          ],
          Conditions: [{ Field: "path-pattern", PathPatternConfig: { Values: ["/*"] } }],
        },
      ]
    : [];
  baseRules.unshift(...coreApiRoute(ingress).rules);
  if (ingress.sharedHost) {
    (baseRules.at(-1)!.Conditions as unknown[]).push({
      Field: "host-header",
      HostHeaderConfig: { Values: [ingress.sharedHost, ...(ingress.sharedAppsHost ? [ingress.sharedAppsHost] : [])] },
    });
    groups.push({ TargetGroupArn: "other-target", TargetGroupName: "other-target" });
    baseRules.push({
      RuleArn: "other-rule",
      IsDefault: false,
      Actions: [{ Type: "forward", TargetGroupArn: ingress.siblingOwnTarget ? targetArn : "other-target" }],
      Conditions: [
        {
          Field: "host-header",
          HostHeaderConfig: {
            Values: [
              ingress.siblingHost ?? "other.example",
              ...(ingress.siblingAppsHost ? [ingress.siblingAppsHost] : []),
            ],
          },
        },
      ],
    });
  }
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
else if (a.includes("cloudfront list-distributions")) console.log(process.env.AWS_FAKE_CLOUDFRONT || "{}");
else if (a.includes("elbv2 describe-load-balancers")) console.log(JSON.stringify({ LoadBalancers: [{ LoadBalancerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:loadbalancer/app/test/1", DNSName: process.env.AWS_FAKE_ALB_DNS || "agent.acme.example", State: { Code: "active" } }] }));
else if (a.includes("elbv2 describe-listeners")) {
  const protocol = process.env.AWS_FAKE_LISTENER_PROTOCOL || "HTTPS";
  const defaults = process.env.AWS_FAKE_DEFAULT_FORWARD === "1" ? [{ Type: "forward", TargetGroupArn: ${JSON.stringify(targetArn)} }] : process.env.AWS_FAKE_DEFAULT_404 === "1" || ${JSON.stringify(Boolean(ingress.blueGreen))} ? [{ Type: "fixed-response", FixedResponseConfig: { StatusCode: "404" } }] : [{ Type: "forward", TargetGroupArn: ${JSON.stringify(targetArn)} }];
  const listeners = [{ ListenerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:listener/app/test/1/2", Protocol: protocol, Port: protocol === "HTTPS" ? 443 : 80, Certificates: protocol === "HTTPS" ? [{ CertificateArn: "arn:aws:acm:us-west-2:123456789012:certificate/test" }] : [], DefaultActions: defaults }];
  if (process.env.AWS_FAKE_EXTRA_HTTP_LISTENER === "redirect") listeners.push({ ListenerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:listener/app/test/1/3", Protocol: "HTTP", Port: 80, Certificates: [], DefaultActions: [{ Type: "redirect", RedirectConfig: { Protocol: "HTTPS", Port: "443", StatusCode: "HTTP_301" } }] });
  if (process.env.AWS_FAKE_EXTRA_HTTP_LISTENER === "forward") listeners.push({ ListenerArn: "arn:aws:elasticloadbalancing:us-west-2:123456789012:listener/app/test/1/3", Protocol: "HTTP", Port: 80, Certificates: [], DefaultActions: [{ Type: "forward", TargetGroupArn: ${JSON.stringify(targetArn)} }] });
  console.log(JSON.stringify({ Listeners: listeners }));
}
else if (a.includes("elbv2 describe-target-groups")) console.log(JSON.stringify({ TargetGroups: ${JSON.stringify(groups)} }));
else if (a.includes("elbv2 describe-rules")) {
  const rules = ${JSON.stringify(baseRules)};
  if (process.env.AWS_FAKE_CORE_HOST_RULE) rules.unshift({ IsDefault: false, Priority: "10", Actions: [{ Type: "forward", TargetGroupArn: process.env.AWS_FAKE_CORE_HOST_RULE }], Conditions: [{ Field: "host-header", HostHeaderConfig: { Values: ["api.agent.acme.example"] } }] });
  if (process.env.AWS_FAKE_FRONT_DOOR_HOST === "1") rules[rules.length - 1].Conditions = [{ Field: "host-header", HostHeaderConfig: { Values: ["api.agent.acme.example"] } }];
  if (process.env.AWS_FAKE_EXTRA_RULE === "1") rules.push({ IsDefault: false, Actions: [{ Type: "fixed-response", FixedResponseConfig: { StatusCode: "503" } }], Conditions: [{ Field: "path-pattern", PathPatternConfig: { Values: ["/status/*"] } }] });
  console.log(JSON.stringify({ Rules: rules }));
}
else if (a.includes("elbv2 describe-target-health") && !${JSON.stringify(ingress.statefulTargetHealth ?? false)}) console.log(JSON.stringify({ TargetHealthDescriptions: [{ TargetHealth: { State: process.env.AWS_FAKE_UNHEALTHY_TARGET === "1" ? "unhealthy" : "healthy" } }] }));
else if (a.includes("secretsmanager describe-secret")) console.log(JSON.stringify({ ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf", DeletedDate: process.env.AWS_FAKE_SECRET_DELETED || undefined, VersionIdsToStages: { current: ["AWSCURRENT"] } }));
else {
${script}
}
`,
  );
  chmodSync(bin, 0o755);
  const prior = process.env.AWS_BIN;
  const priorFetch = globalThis.fetch;
  const priorRequest = https.request;
  https.request = ((url: URL, options: https.RequestOptions, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { end(body?: string): void };
    request.end = (body) => {
      void globalThis
        .fetch(url, {
          method: options.method,
          headers: options.headers as Record<string, string>,
          body,
          signal: options.signal,
        })
        .then(async (result) => {
          const response = Object.assign(new EventEmitter(), { statusCode: result.status });
          callback(response);
          try {
            response.emit("data", Buffer.from(await result.text()));
            response.emit("end");
          } catch (error) {
            response.emit("error", error);
          }
        })
        .catch((error) => request.emit("error", error));
    };
    return request;
  }) as typeof https.request;
  process.env.AWS_BIN = bin;
  globalThis.fetch = async () => new Response("", { status: Number(process.env.AWS_FAKE_HTTP_STATUS ?? 404) });
  return {
    log,
    restore: () => {
      if (prior === undefined) delete process.env.AWS_BIN;
      else process.env.AWS_BIN = prior;
      globalThis.fetch = priorFetch;
      https.request = priorRequest;
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
    failNativeStatusOnceAfterUpdate?: boolean;
    ignoreUpdate?: boolean;
    failFirstUpdateAfterMutation?: boolean;
    failForcedDeploymentResponse?: boolean;
    failTransactions?: boolean;
    failTransactionPuts?: number;
    failPromotion?: boolean;
    promotionAlreadyCurrent?: boolean;
    drainPolls?: number;
    rollingTasks?: {
      retiringPolls: number;
      retiring?: number;
      targetHealthPolls?: number;
      health?: string[];
      failInventory?: boolean;
    };
    inactiveDeploymentRunning?: number;
    primaryFailedTasks?: boolean;
    rolloutFailed?: boolean;
    transientFailedTaskPolls?: number;
    alternateStaleReadPolls?: number;
    blueGreenBakePolls?: number;
    migrationExitCode?: number;
    foreignServiceTags?: boolean;
    progressFile?: string;
    sabotageProgress?: boolean;
  } = {},
): {
  log: string;
  state: string;
  restore: () => void;
} {
  const state = join(dir, "aws-state.json");
  const door: FrontDoor = {
    blueGreen: Boolean(opts.blueGreenBakePolls),
    apiHosts: configured.aws?.sharedAlb ? [] : awsCoreHostnames(configured),
  };
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
      revision: 1,
    }),
  );
  const fake = fakeAws(
    dir,
    `
const args = process.argv.slice(2);
const progressFile = ${JSON.stringify(opts.progressFile)};
if (progressFile) fs.appendFileSync(progressFile + ".samples", JSON.stringify({ args, published: fs.existsSync(progressFile) }) + "\\n");
if (progressFile && ${JSON.stringify(opts.sabotageProgress ?? false)} && a.includes("ecs update-service")) fs.mkdirSync(progressFile, { recursive: true });
const statePath = ${JSON.stringify(state)};
const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(s));
const after = (flag) => args[args.indexOf(flag) + 1];
if (a.includes("secretsmanager get-secret-value") && !a.includes("--query")) console.log(JSON.stringify({ ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf", SecretString: a.includes("PUBLIC_API_URL") ? (process.env.AWS_FAKE_PUBLIC_API_URL || ${JSON.stringify(configured.apiUrl ?? configured.publicUrl)}) : (a.includes("DEPLOYMENT_CONTROL_SECRET") ? "separate-control-secret-value-0000000000" : (a.includes("CORE_SIGNING_SECRET") && process.env.AWS_FAKE_SECRET_VALUE || ${JSON.stringify(TEST_SECRET_VALUE)})) }));
else if (a.includes("secretsmanager get-secret-value") && a.includes("--query SecretString")) console.log(a.includes("PUBLIC_API_URL") ? (process.env.AWS_FAKE_PUBLIC_API_URL || ${JSON.stringify(configured.apiUrl ?? configured.publicUrl)}) : (a.includes("DEPLOYMENT_CONTROL_SECRET") ? "separate-control-secret-value-0000000000" : (a.includes("CORE_SIGNING_SECRET") && process.env.AWS_FAKE_SECRET_VALUE || ${JSON.stringify(TEST_SECRET_VALUE)})));
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
  const blocked = s.blockDisabledDrain && names.some((name) => s.definitions[s.services[name]?.taskDefinition]?.containerDefinitions?.some((container) => container.name === "core" && container.environment?.some((entry) => entry.name === "BACKGROUND_WORK_ENABLED" && entry.value === "0")));
  const draining = (s.drainPolls || 0) > 0 || blocked || (${JSON.stringify(Boolean(opts.rollingTasks))} && s.updated);
  if (s.drainPolls > 0) { s.drainPolls--; save(); }
  const retiringRunning = ${JSON.stringify(Boolean(opts.rollingTasks))} && s.updated ? (s.retiringPolls > 0 && (${JSON.stringify(opts.rollingTasks?.retiring ?? 2)} > 1) ? 1 : 0) : 1;
  if (${JSON.stringify(Boolean(opts.rollingTasks))} && s.updated && s.retiringPolls > 0) { s.retiringPolls--; save(); }
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
  const blueGreenBakePolls = ${JSON.stringify(opts.blueGreenBakePolls ?? 0)};
  let blueGreenBaking = false;
  if (blueGreenBakePolls && s.updated) {
    s.blueGreenPolls = (s.blueGreenPolls || 0) + 1;
    save();
    blueGreenBaking = s.blueGreenPolls <= blueGreenBakePolls;
  }
  console.log(JSON.stringify({ services: names.flatMap((name) => {
    const service = s.services[name];
    if (!service) return [];
    if (name === staleName && service.previousTaskDefinition) {
      return [{ serviceName: name, status: "ACTIVE", desiredCount: service.desiredCount, runningCount: service.desiredCount, taskDefinition: service.previousTaskDefinition, deployments: [{ id: service.deploymentId, status: "PRIMARY", taskDefinition: service.previousTaskDefinition, rolloutState: "COMPLETED", runningCount: service.desiredCount, failedTasks: 0 }], tags: [{ key: "Deployment", value: ${JSON.stringify(opts.foreignServiceTags ? "other" : configured.orgId)} }, { key: "ManagedBy", value: "terraform" }], ...(s.serviceOverrides?.[name] || {}) }];
    }
    const deployments = draining
      ? [
          { id: service.deploymentId, status: "PRIMARY", taskDefinition: service.taskDefinition, rolloutState: "IN_PROGRESS", runningCount: service.desiredCount, failedTasks: 1 },
          { id: "old", status: "ACTIVE", taskDefinition: service.taskDefinition, rolloutState: "COMPLETED", runningCount: retiringRunning, failedTasks: 0 },
        ]
      : ${JSON.stringify(opts.rolloutFailed ?? false)}
        ? [{ id: service.deploymentId, status: "PRIMARY", taskDefinition: service.taskDefinition, rolloutState: "FAILED", runningCount: 0, failedTasks: 1 }]
      : ${JSON.stringify(opts.primaryFailedTasks ?? false)} || transientlyFailing
        ? [{ id: service.deploymentId, status: "PRIMARY", taskDefinition: service.taskDefinition, rolloutState: "IN_PROGRESS", runningCount: 0, failedTasks: 1 }]
        : blueGreenBakePolls
          ? [{ id: service.deploymentId, status: "PRIMARY", taskDefinition: service.taskDefinition, rolloutState: "COMPLETED", runningCount: service.desiredCount, failedTasks: 0 }]
        : [{ id: service.deploymentId, status: "PRIMARY", taskDefinition: service.taskDefinition, rolloutState: "COMPLETED", runningCount: service.desiredCount, failedTasks: transientFailedTaskPolls && s.updated ? 1 : 0 }];
    return [{ serviceName: name, status: "ACTIVE", launchType: "FARGATE", platformVersion: "1.4.0", networkConfiguration: { awsvpcConfiguration: { subnets: ["subnet-a", "subnet-b"], securityGroups: ["sg-core"], assignPublicIp: "ENABLED" } }, desiredCount: service.desiredCount, runningCount: draining ? service.desiredCount + 1 : service.desiredCount, taskDefinition: service.taskDefinition, deploymentConfiguration: { strategy: blueGreenBakePolls ? "BLUE_GREEN" : "ROLLING" }, deployments: [...deployments, ...(${JSON.stringify(opts.inactiveDeploymentRunning === undefined ? [] : [{ id: "inactive", status: "INACTIVE", rolloutState: "COMPLETED", runningCount: opts.inactiveDeploymentRunning, failedTasks: 0 }])}).map(deployment => ({ taskDefinition: service.taskDefinition, ...deployment }))].map(deployment => ({ pendingCount: 0, ...deployment })), pendingCount: 0, loadBalancers: service.workload === "core" ? ${JSON.stringify(frontDoorAttachments(door))} : [], tags: [{ key: "Deployment", value: ${JSON.stringify(opts.foreignServiceTags ? "other" : configured.orgId)} }, { key: "ManagedBy", value: "terraform" }], ...(s.serviceOverrides?.[name] || {}) }];
  }), failures: names.filter((name) => !s.services[name]).map((name) => ({ arn: name, reason: "MISSING" })) }));
}
else if (a.includes("ecs list-service-deployments") && ${JSON.stringify(opts.failNativeStatusOnceAfterUpdate ?? false)} && s.updated && !s.nativeStatusFailedOnce) {
  s.nativeStatusFailedOnce = true;
  save();
  console.error("TransientNativeStatusFailure");
  process.exit(1);
}
else if (a.includes("ecs list-service-deployments")) {
  const name = after("--service");
  const service = s.services[name];
  const revision = "service-revision-for-" + String(service?.deploymentId || "").replace(/^ecs-svc\\//, "");
  const status = s.nativeStatus || ((s.blueGreenPolls || 0) === 1 ? "PENDING" : (s.blueGreenPolls || 0) <= ${JSON.stringify(opts.blueGreenBakePolls ?? 0)} ? "IN_PROGRESS" : "SUCCESSFUL");
  const prior = service?.previousTaskDefinition ? [{ targetServiceRevisionArn: "arn:aws:ecs:us-west-2:123456789012:service-revision/acme-qm/" + name + "/previous", status: "SUCCESSFUL", createdAt: 1700000000000 }] : [];
  const current = service && (s.blueGreenPolls || 0) !== 1 ? [{ targetServiceRevisionArn: "arn:aws:ecs:us-west-2:123456789012:service-revision/acme-qm/" + name + "/" + revision, status, createdAt: 1700000000000 + s.revision }] : [];
  console.log(JSON.stringify({ serviceDeployments: [...prior, ...current] }));
}
else if (a.includes("ecs describe-service-revisions")) {
  const start = args.indexOf("--service-revision-arns") + 1;
  const end = Math.min(...[args.indexOf("--output", start), args.indexOf("--region", start)].filter((index) => index >= 0));
  const arns = args.slice(start, end);
  console.log(JSON.stringify({ serviceRevisions: arns.flatMap((arn) => {
    const name = arn.split("/").at(-2);
    const service = name ? s.services[name] : undefined;
    return service ? [{ serviceRevisionArn: arn, taskDefinition: arn.endsWith("/previous") ? service.previousTaskDefinition : service.taskDefinition }] : [];
  }) }));
}
else if (${JSON.stringify(Boolean(opts.rollingTasks))} && s.updated && a.includes("ecs list-tasks")) {
  const rolling = ${JSON.stringify(opts.rollingTasks ?? {})};
  if (rolling.failInventory) { console.error("ListTasksFailure"); process.exit(1); }
  const name = after("--service-name");
  const arn = (id) => "arn:aws:ecs:us-west-2:123456789012:task/" + name + "/" + id;
  console.log(JSON.stringify({ taskArns: after("--desired-status") === "STOPPED" ? Array.from({ length: rolling.retiring ?? 2 }, (_, index) => arn("retiring-" + index)) : Array.from({ length: s.services[name].desiredCount }, (_, index) => arn("current-" + index)) }));
}
else if (${JSON.stringify(Boolean(opts.rollingTasks))} && s.updated && a.includes("ecs describe-tasks")) {
  const rolling = ${JSON.stringify(opts.rollingTasks ?? {})};
  const requested = args.slice(args.indexOf("--tasks") + 1).filter(arg => arg.startsWith("arn:"));
  console.log(JSON.stringify({ tasks: requested.map(taskArn => {
    const service = s.services[taskArn.split("/").at(-2)];
    const [kind, index] = taskArn.split("/").at(-1).split("-");
    if (kind === "retiring") return { taskArn, taskDefinitionArn: service.previousTaskDefinition, startedBy: "ecs-svc/retiring", desiredStatus: "STOPPED", healthStatus: "HEALTHY", lastStatus: s.retiringPolls > 0 ? (index === "0" ? "STOPPING" : "RUNNING") : (index === "0" ? "DEPROVISIONING" : "STOPPED") };
    return { taskArn, taskDefinitionArn: service.taskDefinition, startedBy: service.deploymentId, desiredStatus: "RUNNING", lastStatus: "RUNNING", healthStatus: (rolling.health ?? [])[Number(index)] ?? "HEALTHY", containers: [{ networkInterfaces: [{ privateIpv4Address: "10.0.2." + index }] }] };
  }), failures: [] }));
}
else if (${JSON.stringify(Boolean(opts.rollingTasks))} && a.includes("elbv2 describe-target-health")) {
  if (!s.updated) console.log(JSON.stringify({ TargetHealthDescriptions: [{ TargetHealth: { State: "healthy" } }] }));
  else {
    if (s.targetHealthPolls > 0) { s.targetHealthPolls--; save(); }
    const service = Object.values(s.services).find(item => item.workload === "core");
    console.log(JSON.stringify({ TargetHealthDescriptions: Array.from({ length: service.desiredCount }, (_, index) => ({ Target: { Id: "10.0.2." + index, Port: 8080 }, TargetHealth: { State: s.targetHealthPolls > 0 ? "initial" : "healthy" } })) }));
  }
}
else if (a.includes("ecs list-tasks") && s.taskInventory) console.log(JSON.stringify({ taskArns: (s.taskInventory[after("--service-name")] || []).filter(task => task.desiredStatus === after("--desired-status")).map(task => task.taskArn) }));
else if (a.includes("ecs describe-tasks") && s.taskInventory) {
  const requested = args.slice(args.indexOf("--tasks") + 1).filter(arg => arg.startsWith("arn:"));
  console.log(JSON.stringify({tasks: Object.values(s.taskInventory).flat().filter(task => requested.includes(task.taskArn) && task.taskArn !== s.omitTask), failures: s.inventoryFailures || []}));
}
else if (a.includes("ecs list-tasks") && s.taskInventory?.[after("--service-name")]) console.log(JSON.stringify({ taskArns: after("--desired-status") === "STOPPED" ? [] : s.taskInventory[after("--service-name")].map(task => task.taskArn) }));
else if (a.includes("ecs describe-tasks") && Object.values(s.taskInventory || {}).flat().some(task => args.includes(task.taskArn))) console.log(JSON.stringify({ tasks: Object.values(s.taskInventory).flat().filter(task => args.includes(task.taskArn)), failures: [] }));
else if (a.includes("ecs list-tasks")) console.log(JSON.stringify({ taskArns: process.env.AWS_FAKE_NO_RUNNING_TASK ? [] : [...(process.env.AWS_FAKE_LARGE_ROLLOUT ? Array.from({ length: 100 }, (_, i) => "arn:aws:ecs:us-west-2:123456789012:task/old-core-" + i) : []), "arn:aws:ecs:us-west-2:123456789012:task/live-core"] }));
else if (a.includes("ecs describe-tasks") && a.includes("task/old-core-")) console.log(JSON.stringify({ tasks: [] }));
else if (a.includes("ecs describe-tasks") && a.includes("task/live-core")) console.log(JSON.stringify({ tasks: [{ taskArn: "arn:aws:ecs:us-west-2:123456789012:task/live-core", taskDefinitionArn: process.env.AWS_FAKE_STALE_CORE ? "stale-task-definition" : s.services["acme-core"].taskDefinition, lastStatus: "RUNNING", healthStatus: "HEALTHY", containers: [{ name: "core", networkInterfaces: [{ privateIpv4Address: "10.0.1.8" }] }] }] }));
else if (a.includes("ecs run-task")) console.log(JSON.stringify({ tasks: [{ taskArn: "arn:aws:ecs:us-west-2:123456789012:task/canary" }] }));
else if (a.includes("ecs describe-tasks") && s.missingPolls > 0) { s.missingPolls--; save(); console.log(JSON.stringify({ tasks: [], failures: [{ arn: "arn:aws:ecs:us-west-2:123456789012:task/canary", reason: s.failureReason || "MISSING" }] })); }
else if (a.includes("ecs describe-tasks") && s.runningPolls > 0) { s.runningPolls--; save(); console.log(JSON.stringify({ tasks: [{ lastStatus: "RUNNING", containers: [{ name: "core" }] }], failures: [] })); }
else if (a.includes("ecs describe-tasks")) { const exitCode = Number(process.env.AWS_FAKE_CANARY_EXIT || "0") || ${JSON.stringify(opts.migrationExitCode ?? 0)}; console.log(JSON.stringify({ tasks: [{ lastStatus: "STOPPED", stoppedReason: "Essential container in task exited", containers: [{ name: "core", exitCode, reason: process.env.AWS_FAKE_CANARY_REASON ?? (exitCode && ${JSON.stringify(Boolean(opts.migrationExitCode ?? 0))} ? "migration failed" : undefined) }] }], failures: [] })); }
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
else if (a.includes("ecs deregister-task-definition")) console.log("");
else if (a.includes("ecs update-service")) {
  const name = after("--service");
  const service = s.services[name];
  if (!service) process.exit(4);
  service.previousTaskDefinition = service.taskDefinition;
  if (!${JSON.stringify(opts.ignoreUpdate ?? false)} && args.includes("--task-definition")) service.taskDefinition = after("--task-definition");
  if (!${JSON.stringify(opts.ignoreUpdate ?? false)} && args.includes("--desired-count")) service.desiredCount = Number(after("--desired-count"));
  if (!${JSON.stringify(opts.ignoreUpdate ?? false)}) service.deploymentId = "ecs-svc/" + name + "-" + (++s.revision);
  if (s.stoppedInventory) delete s.taskInventory;
  s.updated = true;
  s.drainPolls = ${JSON.stringify(opts.drainPolls ?? 0)};
  s.retiringPolls = ${JSON.stringify(opts.rollingTasks?.retiringPolls ?? 0)};
  s.targetHealthPolls = ${JSON.stringify(opts.rollingTasks?.targetHealthPolls ?? 0)};
  s.blueGreenPolls = 0;
  if (s.failNextUpdatesAfterMutation > 0 || (${JSON.stringify(opts.failFirstUpdateAfterMutation ?? false)} && !s.failedFirstUpdate)) {
    if (s.failNextUpdatesAfterMutation > 0) s.failNextUpdatesAfterMutation--;
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
  if (s.failNextTransactions > 0) { s.failNextTransactions--; save(); console.error("TransactionRejected"); process.exit(1); }
  if (${JSON.stringify(opts.failTransactions ?? false)}) { console.error("TransactionRejected"); process.exit(1); }
  const failTransactionPuts = ${JSON.stringify(opts.failTransactionPuts ?? 0)};
  if (failTransactionPuts) {
    s.transactAttempts = (s.transactAttempts || 0) + 1;
    save();
    if (s.transactAttempts <= failTransactionPuts) { console.error("TransactionRejected"); process.exit(1); }
  }
  for (const write of JSON.parse(after("--transact-items"))) {
    if (write.Put) {
      if (write.Put.ConditionExpression === "attribute_not_exists(lockKey)" && s.dynamo[write.Put.Item.lockKey.S]) { console.error("ConditionalCheckFailedException"); process.exit(1); }
      s.dynamo[write.Put.Item.lockKey.S] = write.Put.Item;
    }
    if (write.Delete) delete s.dynamo[write.Delete.Key.lockKey.S];
  }
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
else if (a.includes("rds describe-db-instances")) console.log(JSON.stringify({ DBInstances: [{ DBInstanceStatus: process.env.AWS_FAKE_DB_STATUS ?? "available", BackupRetentionPeriod: Number(process.env.AWS_FAKE_DB_RETENTION ?? "7"), ...(process.env.AWS_FAKE_DB_RESTORABLE_AT === "" ? {} : { LatestRestorableTime: process.env.AWS_FAKE_DB_RESTORABLE_AT ?? new Date(Date.now() - 30000).toISOString() }) }] }));
else console.log("");`,
    { ...door, statefulTargetHealth: Boolean(opts.rollingTasks) },
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
  services: ["core", "slack"],
  plugins: [],
  skills: [],
  imageOverrides: {},
  sandbox: {
    backend: "sprites",
    app: "acme-sandboxes",
    secretEnv: ["ACME_API_KEY"],
  },
  env: {
    core: { AWS_DEPLOY_IMAGE: "acme-qm-sandbox", AWS_DEPLOY_IMAGE_VERSION: "1" },
  },
  aws: {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme-qm",
    deployRoleArn: "arn:aws:iam::123456789012:role/acme-deploy",
    imageLabel: "release",
    secretsPrefix: "acme/qm/",
    networking: { cloudMapNamespace: "acme.internal" },
    services: { core: { ecrRepository: "qm-core", ecsService: "acme-core", cpu: 2048, memory: 4096 } },
  },
};

test("AWS environment derives identity, public URLs, private wiring, and MicroVM coordinates", () => {
  const core = serviceEnvironment(config, "core");
  assert.equal(core.ORG_ID, "acme");
  assert.equal(core.PUBLIC_WEB_URL, "https://agent.acme.example");
  assert.equal(core.PUBLIC_WEB_URL, "https://agent.acme.example");
  assert.equal(core.PUBLIC_PORT, "8000");
  assert.equal(core.PORTAL_XFF_TRUSTED_HOPS, "1");
  assert.equal(core.REQUIRE_SIGNED_PORTAL_IDENTITY, undefined);
  assert.equal(core.SANDBOX_BACKEND, "sprites");
  assert.equal(core.AWS_SANDBOX_IMAGE, undefined);
  const { sandbox: _sandbox, ...rest } = config;
  const microvm = serviceEnvironment(rest as QmConfig, "core");
  assert.equal(microvm.SANDBOX_BACKEND, "aws");
  assert.equal(microvm.AWS_SANDBOX_REGION, "us-west-2");
  assert.equal(microvm.AWS_SANDBOX_IMAGE, "acme-qm-sandbox");
  assert.equal(microvm.AWS_SANDBOX_IMAGE_VERSION, "1");
  assert.equal(microvm.AWS_SANDBOX_EXEC_ROLE_ARN, "arn:aws:iam::123456789012:role/acme-qm-microvm-exec");
  assert.equal(microvm.AWS_SANDBOX_S3_BUCKET, awsObjectStoreBucket(config));
  assert.equal(core.SNAPSHOT_STORE, "s3");
  assert.equal(core.TRANSFER_STORE, "s3");
  assert.equal(core.S3_REGION, "us-west-2");
  assert.equal(core.DEPLOY_PROVIDER, "aws");
  assert.equal(core.AWS_DEPLOY_REGION, "us-west-2");
  assert.equal(core.PORT, "8080");
});

test("AWS hosting preserves an explicit publishing provider independently of sandbox selection", () => {
  for (const sandbox of [config.sandbox, undefined]) {
    for (const provider of ["fly", "porter"]) {
      const selected: QmConfig = {
        ...config,
        sandbox,
        env: { ...config.env, core: { ...config.env.core, DEPLOY_PROVIDER: provider } },
      };
      const core = serviceEnvironment(selected, "core");
      assert.equal(core.DEPLOY_PROVIDER, provider);
      assert.equal(core.SANDBOX_BACKEND, sandbox?.backend ?? "aws");
      assert.equal(core.SNAPSHOT_STORE, "s3");
      assert.equal(serviceEnvironment(selected, "egress-proxy").DEPLOY_PROVIDER, undefined);
    }
  }
});

test("a configured bot identity lands in the AWS core task env and only there", () => {
  const branded = { ...config, botName: "straylight", orgName: "Straylight Industries" };
  const core = serviceEnvironment(branded, "core");
  assert.equal(core.ORG_BRAND_SELF_LABEL, "straylight");
  assert.equal(core.ORG_BRAND_ORG_NAME, "Straylight Industries");
  assert.equal(core.AUTH_BRAND_NAME, "straylight");
  assert.equal(serviceEnvironment(branded, "egress-proxy").ORG_BRAND_SELF_LABEL, undefined);
  assert.equal(serviceEnvironment(config, "core").ORG_BRAND_SELF_LABEL, undefined);
});

test("AWS routes security screen proxy configuration and its token only to core", () => {
  const screened: QmConfig = {
    ...config,
    securityScreen: {
      mode: "enforce",
      classifier: "proxy",
      provider: "example-screen",
      endpoint: "https://screen.example.test/classify",
    },
    secretEnv: { core: { SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN" } },
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(serviceEnvironment(screened, "core")).filter(([name]) => name.startsWith("SECURITY_SCREEN_")),
    ),
    {
      SECURITY_SCREEN_CLASSIFIER: "proxy",
      SECURITY_SCREEN_PROXY_ENDPOINT: "https://screen.example.test/classify",
      SECURITY_SCREEN_PROXY_PROVIDER: "example-screen",
    },
  );
  assert.deepEqual(
    Object.keys(serviceEnvironment(screened, "egress-proxy")).filter((name) => name.startsWith("SECURITY_SCREEN_")),
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
      core: { ...config.env.core, PORT: "9000", PUBLIC_PORT: "9100" },
    },
  };
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const container = renderTaskDefinition(configured, "core", image).containerDefinitions[0]!;
  const environment = Object.fromEntries(
    (container.environment as Array<{ name: string; value: string }>).map(({ name, value }) => [name, value]),
  );
  assert.equal(environment.PORT, "8080");
  assert.equal(environment.PUBLIC_PORT, "8000");
  assert.deepEqual(container.portMappings, [
    { name: "core", containerPort: 8080, hostPort: 8080, protocol: "tcp", appProtocol: "http" },
    { name: "core-public", containerPort: 8000, hostPort: 8000, protocol: "tcp", appProtocol: "http" },
  ]);
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
        SNAPSHOT_STORE: "local",
        TRANSFER_STORE: "local",
      },
    },
  };
  const core = serviceEnvironment(overridden, "core");
  assert.equal(core.SNAPSHOT_STORE, "s3");
  assert.equal(core.TRANSFER_STORE, "s3");
  assert.equal(core.SANDBOX_BACKEND, "sprites");
  const { sandbox: _sandbox, ...rest } = overridden;
  const microvm = serviceEnvironment(rest as QmConfig, "core");
  assert.equal(microvm.SNAPSHOT_STORE, "s3");
  assert.equal(microvm.SANDBOX_BACKEND, "aws");
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
  assert.doesNotThrow(() =>
    assertGithubDeployTrust(
      withSubjects(idPinned),
      "123456789012",
      "repo:acme@153323858/deploy@1253778415:environment:production",
    ),
  );
  assert.throws(
    () =>
      assertGithubDeployTrust(
        withSubjects(idPinned),
        "123456789012",
        "repo:acme@999/deploy@1253778415:environment:production",
      ),
    /only repo:acme@999\/deploy@1253778415:\* subjects/,
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
    writeFileSync(
      join(dir, "infra", "terraform.tfvars"),
      'github_repository = "acme/vendored"\ngithub_subject_prefix = "repo:acme@123/vendored@456"\ngithub_ref = "refs/heads/deploy"\n',
    );
    assert.equal(
      githubTrustSubject(dir),
      "repo:acme@123/vendored@456:ref:refs/heads/deploy",
      "an immutable GitHub OIDC prefix overrides the name-based prefix",
    );
    assert.equal(
      githubTrustSubject(dir, undefined, "production"),
      "repo:acme@123/vendored@456:environment:production",
      "the immutable prefix also applies to environment subjects",
    );
    process.env.GITHUB_REPOSITORY = "acme/from-actions";
    process.env.GITHUB_REF = "refs/heads/pr-branch";
    assert.equal(
      githubTrustSubject(dir),
      "repo:acme@123/vendored@456:ref:refs/heads/deploy",
      "the deployment's immutable prefix and ref shape the expected trust",
    );
    writeFileSync(
      join(dir, "infra", "terraform.tfvars"),
      'github_repository = "acme/vendored"\ngithub_subject_prefix = "repo:acme/vendored:environment:production"\ngithub_ref = "refs/heads/deploy"\n',
    );
    assert.throws(
      () => githubTrustSubject(dir),
      /github_subject_prefix must be an exact repo:owner\/repository prefix/,
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
  const fake = statefulAws(dir, config);
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

test("AWS deploy can prepare an exact candidate on the inactive production stack", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-inactive-candidate-"));
  const candidatePath = join(dir, "candidate.json");
  writeFileSync(
    candidatePath,
    JSON.stringify({
      contract: 1,
      accountId: "123456789012",
      region: "us-west-2",
      label: "candidate-deadbeef",
      images: {
        core: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`,
      },
      imageProvenance: { core: { kind: "source-build", source: "checkout" } },
      architectures: { core: "amd64" },
    }),
  );
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single);
  const prior = process.env.AWS_FAKE_ALB_DNS;
  process.env.AWS_FAKE_ALB_DNS = "192.0.2.1";
  try {
    await awsUp(single, dir, { yes: true, candidate: candidatePath, inactive: true });
    assert.match(readFileSync(fake.log, "utf8"), /ecs update-service/);
    await assert.rejects(
      () => awsUp(single, dir, { yes: true, inactive: true }),
      /--inactive is only valid for an exact candidate deployment/,
    );
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

test("AWS deploy requires the live ALB to send everything but declared routes to core's front door", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-live-routing-"));
  const run = async (
    env: "AWS_FAKE_DEFAULT_404" | "AWS_FAKE_DEFAULT_FORWARD" | "AWS_FAKE_EXTRA_RULE",
    expected: RegExp,
    blueGreen = false,
  ): Promise<void> => {
    const fake = statefulAws(dir, oneServiceConfig(), {}, blueGreen ? { blueGreenBakePolls: 1 } : {});
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
    await run("AWS_FAKE_DEFAULT_404", /listener default does not route only to the core front door/);
    await run("AWS_FAKE_EXTRA_RULE", /ALB has non-default rules beyond the declared plugin and core API routes/);
    await run("AWS_FAKE_DEFAULT_FORWARD", /blue\/green listener default must return a fixed 404 response/, true);
    await run("AWS_FAKE_EXTRA_RULE", /blue\/green ALB has unexpected non-default rules/, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS routes a separate apiUrl host and apps domain straight to core's API target group", () => {
  const configured: QmConfig = {
    ...config,
    apiUrl: "https://api.agent.acme.example",
    env: { ...config.env, core: { ...config.env.core, AWS_DEPLOY_APPS_DOMAIN: "apps.agent.acme.example" } },
  };
  const hosts = awsCoreHostnames(configured);
  assert.deepEqual(hosts, ["api.agent.acme.example", "*.apps.agent.acme.example"]);
  const front = targetGroupArn(awsTargetGroupName(config, "core-public"));
  for (const blueGreen of [false, true]) {
    const check = (
      door: FrontDoor,
      routed: QmConfig,
      attachments: Array<Record<string, unknown>>,
      expected?: RegExp,
    ) => {
      const dir = mkdtempSync(join(tmpdir(), "qm-aws-core-api-"));
      const fake = fakeAws(dir, "", door);
      try {
        const services = new Map([["core", { loadBalancers: attachments }]]);
        if (expected) assert.throws(() => assertAwsPublicRouting(routed, services), expected);
        else
          assert.deepEqual([...assertAwsPublicRouting(routed, services)].sort(), [
            ["core", targetGroupArn(door.apiTargetGroup ?? "core-api")],
            ["core-public", front],
          ]);
      } finally {
        fake.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const door: FrontDoor = { blueGreen, apiHosts: hosts };
    const attached = frontDoorAttachments(door);
    const unattached =
      /ECS service core must be attached to one target group on container port 8080 for core's API host rules \(api\.agent\.acme\.example, \*\.apps\.agent\.acme\.example\)/;
    const legacy = { ...door, apiTargetGroup: "legacy-api-tg" };
    check(door, configured, attached);
    check(legacy, configured, frontDoorAttachments(legacy));
    check({ blueGreen }, configured, frontDoorAttachments({ blueGreen }), unattached);
    check(door, configured, attached.slice(0, 1), unattached);
    check(door, configured, [attached[0]!, { ...attached[1]!, containerPort: 8000 }], unattached);
    check(
      door,
      configured,
      [attached[0]!, { ...attached[1]!, targetGroupArn: targetGroupArn("elsewhere") }],
      /target group for core is missing/,
    );
    check(
      { blueGreen, apiHosts: ["api.agent.acme.example"] },
      configured,
      attached,
      blueGreen
        ? /blue\/green ALB rule for core does not match its production route/
        : /core API host rules must route api\.agent\.acme\.example, \*\.apps\.agent\.acme\.example to core's API target group/,
    );
    check(
      { blueGreen, apiHosts: [...hosts, "other.example"] },
      configured,
      attached,
      blueGreen
        ? /blue\/green ALB rule for core does not match its production route/
        : /core API host rules must match only api\.agent\.acme\.example, \*\.apps\.agent\.acme\.example by host header/,
    );
    check(door, config, frontDoorAttachments({ blueGreen }), /ALB has target groups for private or unknown services/);
    if (blueGreen)
      check(
        door,
        { ...configured, env: config.env, aws: { ...config.aws!, sharedAlb: true, alb: "shared" } },
        attached,
        /shared ALB requires one blue\/green core front-door ingress without additional public routes/,
      );
  }
});

test("AWS live routing rejects a core host rule when no separate apiUrl host or apps domain is configured", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-front-door-"));
  for (const blueGreen of [false, true]) {
    const fake = fakeAws(dir, "", { blueGreen });
    const attached = new Map([["core", { loadBalancers: frontDoorAttachments({ blueGreen }) }]]);
    try {
      process.env.AWS_FAKE_CORE_HOST_RULE = targetGroupArn(awsTargetGroupName(config, "core-public"));
      assert.throws(
        () => assertAwsPublicRouting(config, attached),
        blueGreen
          ? /blue\/green ALB has unexpected non-default rules/
          : /non-default rules beyond the declared plugin and core API routes/,
      );
      delete process.env.AWS_FAKE_CORE_HOST_RULE;
      if (blueGreen) {
        process.env.AWS_FAKE_FRONT_DOOR_HOST = "1";
        assert.throws(
          () => assertAwsPublicRouting(config, attached),
          /blue\/green ALB rule for core-public does not match its production route/,
        );
      }
    } finally {
      delete process.env.AWS_FAKE_CORE_HOST_RULE;
      delete process.env.AWS_FAKE_FRONT_DOOR_HOST;
      fake.restore();
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

test("AWS up deploys core attached to its front-door and API target groups for a separate apiUrl host and apps domain", async () => {
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
  });
  const bothHosts = { apiUrl: "https://api.agent.acme.example", appsDomain: "apps.agent.acme.example" };
  const run = async (
    configured: QmConfig,
    env?: "AWS_FAKE_CORE_HOST_RULE" | "AWS_FAKE_PUBLIC_API_URL",
    expected?: RegExp,
    envValue = "1",
  ): Promise<void> => {
    const fake = statefulAws(dir, configured);
    const prior = env ? process.env[env] : undefined;
    if (env) process.env[env] = envValue;
    try {
      if (expected) await assert.rejects(() => awsUp(configured, dir, { dryRun: true }), expected);
      else await awsUp(configured, dir, { dryRun: true });
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
    await run(
      hostSplitConfig({}),
      "AWS_FAKE_CORE_HOST_RULE",
      /ALB has non-default rules beyond the declared plugin and core API routes/,
      targetGroupArn(awsTargetGroupName(config, "core-public")),
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
  const scaled = (desiredCount = 2): QmConfig => {
    const base = oneServiceConfig();
    return { ...base, aws: { ...base.aws!, services: { core: { ...base.aws!.services.core!, desiredCount } } } };
  };
  const fake = statefulAws(dir, scaled());
  const priorPath = process.env.PATH;
  const priorCanaryExit = process.env.AWS_FAKE_CANARY_EXIT;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(scaled(), dir, { yes: true });
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(state.services["acme-core"].desiredCount, 2);
    assert.match(readFileSync(fake.log, "utf8"), /ecs update-service .*--desired-count 2/);
    await assert.doesNotReject(() => awsCheckLive(scaled(), { report: false }));
    await awsUp(scaled(3), dir, { yes: true });
    const rescaled = JSON.parse(readFileSync(fake.state, "utf8"));
    const currentId = rescaled.dynamo["deployment/current"].manifestId.S;
    const current = JSON.parse(rescaled.dynamo[`deployment/manifest/${currentId}`].manifest.S);
    assert.deepEqual(current.counts, { core: 3 });
    await awsRollback(scaled(3));
    const rolledBack = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(rolledBack.services["acme-core"].desiredCount, 2);
    assert.match(
      readFileSync(fake.log, "utf8"),
      /ecs run-task .*postdeploy-smoke\.ts.*session.*http:\/\/10\.0\.1\.8:8080/,
    );
    process.env.AWS_FAKE_CANARY_EXIT = "1";
    await assert.rejects(
      () => awsCheckLive(scaled(), { report: false }),
      /core: private live session smoke failed: AWS canary task arn:aws:ecs:us-west-2:123456789012:task\/canary exited 1: Essential container in task exited/,
    );
    if (priorCanaryExit === undefined) delete process.env.AWS_FAKE_CANARY_EXIT;
    else process.env.AWS_FAKE_CANARY_EXIT = priorCanaryExit;
    rolledBack.services["acme-core"].desiredCount = 1;
    writeFileSync(fake.state, JSON.stringify(rolledBack));
    await assert.rejects(
      () => awsCheckLive(scaled(), { report: false }),
      /core: runtime is ACTIVE with 1\/1 running, expected 2/,
    );
  } finally {
    if (priorCanaryExit === undefined) delete process.env.AWS_FAKE_CANARY_EXIT;
    else process.env.AWS_FAKE_CANARY_EXIT = priorCanaryExit;
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up reapplies the recorded layer after starting a stopped core", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-stopped-layer-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(single, dir, { yes: true, sandboxDir: dir });
    const stopped = JSON.parse(readFileSync(fake.state, "utf8"));
    const previousId = stopped.dynamo["deployment/current"].manifestId.S;
    const previous = JSON.parse(stopped.dynamo[`deployment/manifest/${previousId}`].manifest.S);
    stopped.services["acme-core"].desiredCount = 0;
    writeFileSync(fake.state, JSON.stringify(stopped));
    const fetchLayer = globalThis.fetch;
    const writes: string[] = [];
    let stoppedReads = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/v1/deployment-layer")) {
        const current = JSON.parse(readFileSync(fake.state, "utf8"));
        if (current.services["acme-core"].desiredCount === 0) {
          stoppedReads++;
          return new Response("core is stopped", { status: 503 });
        }
        if (init?.method === "PUT") writes.push(String(init.body));
      }
      return fetchLayer(url, init);
    };
    await awsUp(single, dir, { yes: true, sandboxDir: dir });
    const resumed = JSON.parse(readFileSync(fake.state, "utf8"));
    const currentId = resumed.dynamo["deployment/current"].manifestId.S;
    const current = JSON.parse(resumed.dynamo[`deployment/manifest/${currentId}`].manifest.S);
    assert.equal(stoppedReads, 0);
    assert.deepEqual(writes, [EMPTY_LAYER_BODY]);
    assert.equal(resumed.services["acme-core"].desiredCount, 1);
    assert.deepEqual(current.layer, previous.layer);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up records a restore point before mutation during storage optimization", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-db-restore-point-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  const priorStatus = process.env.AWS_FAKE_DB_STATUS;
  process.env.AWS_FAKE_DB_STATUS = "storage-optimization";
  const started = Date.now();
  try {
    await awsUp(single, dir, { dryRun: true });
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /rds /, "plan is read-only and never touches RDS");
    await awsUp(single, dir, { yes: true });
    const calls = readFileSync(fake.log, "utf8");
    const lease = calls.indexOf("dynamodb put-item");
    const health = calls.indexOf("rds describe-db-instances --db-instance-identifier acme-qm-core");
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
    assert.ok(lease >= 0 && lease < health, "the restore-point check happens under the deploy lease");
    assert.ok(health < firstMutation, "the restore point is verified before the first mutation");
    assert.doesNotMatch(calls, /rds create-db-snapshot|rds describe-db-snapshots|rds delete-db-snapshot/);
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    const manifestId = state.dynamo["deployment/current"].manifestId.S as string;
    const manifest = JSON.parse(state.dynamo[`deployment/manifest/${manifestId}`].manifest.S) as {
      dbRestorePoint?: string;
    };
    const restorePoint = Date.parse(manifest.dbRestorePoint ?? "");
    assert.ok(
      restorePoint >= started && restorePoint <= Date.now(),
      "the manifest records the pre-deploy restore timestamp",
    );
  } finally {
    if (priorStatus === undefined) delete process.env.AWS_FAKE_DB_STATUS;
    else process.env.AWS_FAKE_DB_STATUS = priorStatus;
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up refuses to mutate when the database is unavailable, keeps no automated backups, or has a stale restore point", async () => {
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
    process.env.AWS_FAKE_DB_STATUS = "storage-optimization";
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
    process.env.AWS_FAKE_DB_RESTORABLE_AT = "";
    await assert.rejects(
      () => awsUp(single, dir, { yes: true }),
      /reports no LatestRestorableTime; point-in-time recovery is not active/,
    );
    process.env.AWS_FAKE_DB_RESTORABLE_AT = new Date(Date.now() - 3_600_000).toISOString();
    await assert.rejects(
      () => awsUp(single, dir, { yes: true }),
      /its continuous backup stream is behind, refusing to deploy without a fresh restore point/,
    );
    const calls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(calls, /rds create-db-snapshot|ecr get-login-password|ecs update-service|s3api put-object/);
  } finally {
    if (priorStatus === undefined) delete process.env.AWS_FAKE_DB_STATUS;
    else process.env.AWS_FAKE_DB_STATUS = priorStatus;
    if (priorRetention === undefined) delete process.env.AWS_FAKE_DB_RETENTION;
    else process.env.AWS_FAKE_DB_RETENTION = priorRetention;
    delete process.env.AWS_FAKE_DB_RESTORABLE_AT;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aws.predeployDbSnapshot false skips the restore-point check without touching RDS", async () => {
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
      dbRestorePoint?: string;
    };
    assert.equal(manifest.dbRestorePoint, undefined);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a no-op re-deploy records no manifest", async () => {
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
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up coalesces a requested restart into one deployment even when the task is unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-restart-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single, {}, { blueGreenBakePolls: 3 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(single, dir, { yes: true });
    const first = JSON.parse(readFileSync(fake.state, "utf8"));
    const firstId = first.dynamo["deployment/current"].manifestId.S;
    const previous = JSON.parse(first.dynamo[`deployment/manifest/${firstId}`].manifest.S);
    writeFileSync(fake.log, "");
    await awsUp(single, dir, { dryRun: true, restart: ["core"] });
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecs (?:register-task-definition|update-service)/);
    writeFileSync(fake.log, "");
    await awsUp(single, dir, { yes: true, restart: ["core"] });
    const second = JSON.parse(readFileSync(fake.state, "utf8"));
    const nextId = second.dynamo["deployment/current"].manifestId.S;
    const next = JSON.parse(second.dynamo[`deployment/manifest/${nextId}`].manifest.S);
    assert.notEqual(nextId, firstId);
    assert.notEqual(next.tasks.core, previous.tasks.core);
    assert.deepEqual(next.imageProvenance, previous.imageProvenance);
    const calls = readFileSync(fake.log, "utf8");
    assert.equal(calls.match(/ecs register-task-definition/g)?.length, 1);
    assert.equal(calls.match(/ecs update-service/g)?.length, 1);
    assert.ok((calls.match(/ecs list-service-deployments/g)?.length ?? 0) >= 4);
    assert.ok(calls.lastIndexOf("ecs list-service-deployments") < calls.lastIndexOf("dynamodb transact-write-items"));
    await assert.rejects(() => awsUp(single, dir, { yes: true, restart: ["missing"] }), /not selected/);
    await assert.rejects(() => awsUp(single, dir, { buildOnly: true, restart: ["core"] }), /cannot be used/);
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recorded background boot flags come from the manifest task and reject ambiguous settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-background-boot-"));
  const configured = oneServiceConfig();
  const fake = statefulAws(dir, configured);
  try {
    assert.equal(awsBackgroundWorkBootState(configured), undefined);
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    const task = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:42";
    state.dynamo = manifestItems([{ id: "recorded", tasks: { core: task } }], "recorded");
    const manifest = JSON.parse(state.dynamo["deployment/manifest/recorded"].manifest.S);
    const core: {
      name: string;
      environment: Array<{ name: string; value: string }>;
      secrets: Array<{ name: string }>;
    } = {
      name: "core",
      environment: [{ name: "BACKGROUND_WORK_ENABLED", value: "1" }],
      secrets: [],
    };
    state.definitions[task] = { containerDefinitions: [core] };
    const save = () => {
      state.dynamo["deployment/manifest/recorded"].manifest.S = JSON.stringify(manifest);
      writeFileSync(fake.state, JSON.stringify(state));
    };
    save();
    assert.deepEqual(awsBackgroundWorkBootState(configured), { enabled: true });
    assert.match(readFileSync(fake.log, "utf8"), /describe-task-definition --task-definition .*acme-core:42/);
    core.environment[0]!.value = "0";
    manifest.backgroundDeploymentId = "core:recorded";
    core.environment.push({ name: "BACKGROUND_DEPLOYMENT_ID", value: "core:recorded" });
    save();
    assert.deepEqual(awsBackgroundWorkBootState(configured), { enabled: false, deploymentId: "core:recorded" });
    core.environment[1]!.value = "wrong-identity";
    save();
    assert.throws(() => awsBackgroundWorkBootState(configured), /manifest background deployment identity/);
    core.environment[1]!.value = "core:recorded";
    for (const value of ["", "yes", "2"]) {
      core.environment[0]!.value = value;
      save();
      assert.throws(() => awsBackgroundWorkBootState(configured), /explicit BACKGROUND_WORK_ENABLED/);
    }
    core.environment[0]!.value = "1";
    core.environment.push({ ...core.environment[0]! });
    save();
    assert.throws(() => awsBackgroundWorkBootState(configured), /explicit BACKGROUND_WORK_ENABLED/);
    core.environment.pop();
    core.secrets.push({ name: "BACKGROUND_WORK_ENABLED" });
    save();
    assert.throws(() => awsBackgroundWorkBootState(configured), /supplied as secrets/);
    core.secrets = [];
    core.environment.shift();
    save();
    assert.throws(() => awsBackgroundWorkBootState(configured), /explicit BACKGROUND_WORK_ENABLED/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("background mode changes preserve task settings and reject secret-controlled modes", () => {
  const task = {
    family: "core",
    taskDefinitionArn: "read-only",
    status: "ACTIVE",
    cpu: "1024",
    volumes: [{ name: "scratch" }],
    containerDefinitions: [
      {
        name: "core",
        image: "pinned",
        environment: [{ name: "OTHER", value: "kept" }],
        secrets: [{ name: "TOKEN", valueFrom: "secret" }],
      },
      { name: "sidecar", image: "unchanged" },
    ],
  };
  const changed = taskDefinitionForBackgroundWork(task, false);
  assert.equal(changed.taskDefinitionArn, undefined);
  assert.equal(changed.status, undefined);
  assert.deepEqual(changed.volumes, task.volumes);
  const containers = changed.containerDefinitions as typeof task.containerDefinitions;
  assert.deepEqual(containers[1], task.containerDefinitions[1]);
  assert.deepEqual(containers[0]!.secrets, task.containerDefinitions[0]!.secrets);
  assert.deepEqual(containers[0]!.environment, [
    { name: "OTHER", value: "kept" },
    { name: "BACKGROUND_WORK_ENABLED", value: "0" },
  ]);
  assert.equal(task.containerDefinitions[0]!.environment!.length, 1);
  assert.throws(
    () =>
      taskDefinitionForBackgroundWork(
        { containerDefinitions: [{ name: "core", secrets: [{ name: "BACKGROUND_WORK_ENABLED" }] }] },
        true,
      ),
    /supplied as a secret/,
  );
});

test("background activation preserves candidate and manifest without another migration; demotion drains old tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-background-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const base = oneServiceConfig();
  const single = { ...base, env: { ...base.env, core: { ...base.env.core, BACKGROUND_WORK_ENABLED: "false" } } };
  const fake = statefulAws(dir, single, {}, { drainPolls: 6 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(single, dir, { yes: true });
    const readState = () => JSON.parse(readFileSync(fake.state, "utf8"));
    const manifest = () => {
      const state = readState();
      return JSON.parse(
        state.dynamo[`deployment/manifest/${state.dynamo["deployment/current"].manifestId.S}`].manifest.S,
      );
    };
    const initial = manifest();
    const candidate = {
      contract: 1,
      accountId: single.aws!.accountId,
      region: single.aws!.region,
      label: "verified",
      images: { core: readState().definitions[initial.tasks.core].containerDefinitions[0].image },
      imageProvenance: initial.imageProvenance,
    };
    const candidatePath = join(dir, "candidate.json");
    writeFileSync(candidatePath, JSON.stringify(candidate));
    writeFileSync(fake.log, "");
    await awsSetBackgroundWork(single, dir, true, candidatePath);
    assert.match(readFileSync(fake.log, "utf8"), /ecs register-task-definition/);
    writeFileSync(fake.log, "");
    await awsSetBackgroundWork(single, dir, false);
    const disabled = manifest();
    assert.notEqual(disabled.tasks.core, initial.tasks.core);
    assert.deepEqual(disabled.imageProvenance, initial.imageProvenance);
    assert.deepEqual(disabled.layer, initial.layer);
    assert.equal(disabled.dbRestorePoint, initial.dbRestorePoint);
    const disableCalls = readFileSync(fake.log, "utf8");
    assert.ok(
      (disableCalls.slice(disableCalls.indexOf("ecs update-service")).match(/ecs describe-services/g)?.length ?? 0) >=
        6,
    );
    const lostResponse = readState();
    lostResponse.failNextUpdatesAfterMutation = 1;
    writeFileSync(fake.state, JSON.stringify(lostResponse));
    writeFileSync(fake.log, "");
    await assert.rejects(() => awsSetBackgroundWork(single, dir, true, candidatePath), /UpdateServiceResponseLost/);
    assert.equal(manifest().id, disabled.id);
    const compensationCalls = readFileSync(fake.log, "utf8");
    assert.ok(
      (compensationCalls.slice(compensationCalls.lastIndexOf("ecs update-service")).match(/ecs describe-services/g)
        ?.length ?? 0) >= 6,
    );
    writeFileSync(fake.log, "");
    await awsSetBackgroundWork(single, dir, true, candidatePath);
    const active = manifest();
    assert.notEqual(active.tasks.core, disabled.tasks.core);
    assert.deepEqual(active.imageProvenance, initial.imageProvenance);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecs run-task|rds |ecr /);
    const core = readState().definitions[active.tasks.core].containerDefinitions[0];
    assert.equal(core.image, candidate.images.core);
    assert.equal(
      core.environment.find((entry: { name: string }) => entry.name === "BACKGROUND_WORK_ENABLED").value,
      "1",
    );
    writeFileSync(fake.log, "");
    await awsSetBackgroundWork(single, dir, true, candidatePath);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecs update-service|ecs register-task-definition/);
    candidate.images.core = candidate.images.core.replace(/sha256:.+$/, "sha256:" + "b".repeat(64));
    writeFileSync(candidatePath, JSON.stringify(candidate));
    await assert.rejects(() => awsSetBackgroundWork(single, dir, true, candidatePath), /expected release candidate/);
    const faulted = readState();
    faulted.failNextTransactions = 3;
    writeFileSync(fake.state, JSON.stringify(faulted));
    await assert.rejects(() => awsSetBackgroundWork(single, dir, false), /manifest write failed/);
    assert.equal(manifest().id, active.id);
    assert.equal(readState().services["acme-core"].taskDefinition, active.tasks.core);
    const busy = readState();
    busy.blockDisabledDrain = true;
    writeFileSync(fake.state, JSON.stringify(busy));
    const priorDeadline = process.env.QM_AWS_ROLLOUT_DEADLINE_MS;
    process.env.QM_AWS_ROLLOUT_DEADLINE_MS = "1500";
    try {
      await assert.rejects(() => awsSetBackgroundWork(single, dir, false), /timed out/);
      assert.equal(manifest().id, active.id);
      assert.equal(readState().services["acme-core"].taskDefinition, active.tasks.core);
    } finally {
      if (priorDeadline === undefined) delete process.env.QM_AWS_ROLLOUT_DEADLINE_MS;
      else process.env.QM_AWS_ROLLOUT_DEADLINE_MS = priorDeadline;
    }
    const drifted = readState();
    drifted.services["acme-core"].desiredCount++;
    writeFileSync(fake.state, JSON.stringify(drifted));
    await assert.rejects(() => awsSetBackgroundWork(single, dir, false), /differs from the deployment manifest/);
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
  const fake = statefulAws(dir, single, {}, { transientFailedTaskPolls: 3 });
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
  const fake = fakeAws(
    dir,
    `
if (a.includes("ecs describe-services")) console.log(JSON.stringify({ services: ${JSON.stringify(Object.entries(config.aws!.services).map(([name, spec]) => ({ serviceName: spec.ecsService, loadBalancers: name === "core" ? frontDoorAttachments({}) : [] })))} }));
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

test("AWS resolves optional secret ARNs without reading their plaintext values", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-optional-secret-metadata-"));
  const fake = fakeAws(
    dir,
    `
if (a.includes("secretsmanager get-secret-value")) {
  if (a.includes("OPENROUTER_API_KEY")) {
    console.error("AccessDeniedException");
    process.exit(1);
  }
  console.log(JSON.stringify({ ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf", SecretString: ${JSON.stringify(TEST_SECRET_VALUE)} }));
} else console.log("");`,
  );
  try {
    const arns = secretArns(oneServiceConfig());
    assert.ok(arns.OPENROUTER_API_KEY);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /secretsmanager describe-secret .*OPENROUTER_API_KEY/);
    assert.doesNotMatch(calls, /secretsmanager get-secret-value .*OPENROUTER_API_KEY/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS omits optional secrets that are scheduled for deletion", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-optional-secret-deleting-"));
  const fake = fakeAws(
    dir,
    `
if (a.includes("secretsmanager get-secret-value")) console.log(JSON.stringify({ ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf", SecretString: ${JSON.stringify(TEST_SECRET_VALUE)} }));
else console.log("");`,
  );
  const prior = process.env.AWS_FAKE_SECRET_DELETED;
  process.env.AWS_FAKE_SECRET_DELETED = "2026-08-03T22:01:01Z";
  try {
    const arns = secretArns(oneServiceConfig());
    assert.equal(arns.OPENROUTER_API_KEY, undefined);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /secretsmanager describe-secret .*OPENROUTER_API_KEY/);
    assert.doesNotMatch(calls, /secretsmanager get-secret-value .*OPENROUTER_API_KEY/);
  } finally {
    if (prior === undefined) delete process.env.AWS_FAKE_SECRET_DELETED;
    else process.env.AWS_FAKE_SECRET_DELETED = prior;
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
  assert.equal(task.runtimePlatform.cpuArchitecture, "X86_64");
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
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "PORTAL_EXPECTED_TEAM_ID",
    "PORTAL_IDENTITY_SECRET",
    "PORTAL_SESSION_SECRET",
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
  amd64Core.aws!.services.core!.architecture = "arm64";
  assert.equal(renderTaskDefinition(amd64Core, "core", coreImage).runtimePlatform.cpuArchitecture, "ARM64");
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

test("AWS source builds honor configured build args and record git provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-build-args-"));
  const sourceDir = join(dir, "source");
  const dockerLog = join(dir, "docker.log");
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerLog, "");
  writeFileSync(
    dockerBin,
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(dockerLog)}, process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  chmodSync(dockerBin, 0o755);
  mkdirSync(join(sourceDir, "deploy", "core"), { recursive: true });
  writeFileSync(join(sourceDir, "deploy", "core", "Dockerfile"), "FROM scratch\nLABEL service=core\n");
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
    aws: {
      ...config.aws!,
      services: {
        core: { ...config.aws!.services.core!, architecture: "amd64", buildArgs: { WEB_UI_BASE: "/custom/" } },
      },
    },
  };
  const fake = statefulAws(dir, webUiConfig);
  try {
    await awsUp(webUiConfig, dir, { yes: true, buildFrom: true, buildFromPath: sourceDir });
    const build = readFileSync(dockerLog, "utf8")
      .split("\n")
      .find((line) => line.includes("buildx build") && line.includes("qm-core"));
    assert.match(build ?? "", /--platform linux\/amd64/);
    assert.match(build ?? "", /--provenance=false/);
    assert.match(build ?? "", /--build-arg WEB_UI_BASE=\/custom\//);
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    const manifestId = state.dynamo["deployment/current"].manifestId.S;
    const manifest = JSON.parse(state.dynamo[`deployment/manifest/${manifestId}`].manifest.S);
    assert.deepEqual(manifest.imageProvenance.core, {
      kind: "source-build",
      source: "checkout",
      gitCommit: head,
      dirty: true,
    });
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
  mkdirSync(join(sourceDir, "deploy", "core"), { recursive: true });
  writeFileSync(join(sourceDir, "deploy", "core", "Dockerfile"), "FROM scratch\nLABEL service=core\n");
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
    aws: {
      ...config.aws!,
      services: { core: { ...config.aws!.services.core!, dockerfile: "layered/core.Dockerfile" } },
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
    const dirtySource = join(dir, "dirty-source");
    mkdirSync(join(dirtySource, "deploy", "core"), { recursive: true });
    writeFileSync(join(dirtySource, "deploy", "core", "Dockerfile"), "FROM scratch\nLABEL service=core\n");
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
        linear: {
          ecrRepository: "qm-linear",
          ecsService: "acme-linear",
          cpu: 256,
          memory: 512,
          architecture: "amd64",
          assumeRoleArns: ["arn:aws:iam::111122223333:role/model-gateway"],
        },
      },
    },
  };
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-linear@sha256:${"c".repeat(64)}`;
  const task = renderTaskDefinition(pluginConfig, "linear", image, {
    CORE_SIGNING_SECRET: "arn:core-signing",
    LINEAR_TOKEN: "arn:linear-token",
  });
  const container = task.containerDefinitions[0]!;
  assert.equal(task.taskRoleArn, "arn:aws:iam::123456789012:role/acme-qm-linear-task");
  assert.equal(container.name, "linear");
  assert.equal(container.stopTimeout, undefined);
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

test("AWS coreless workloads receive no core endpoint or source-auth secret", () => {
  const pluginConfig: QmConfig = {
    ...config,
    plugins: [{ name: "signer", image: "ghcr.io/acme/signer:1", coreAccess: false }],
    aws: {
      ...config.aws!,
      services: {
        ...config.aws!.services,
        signer: {
          ecrRepository: "qm-signer",
          ecsService: "acme-signer",
          cpu: 256,
          memory: 512,
          architecture: "arm64",
        },
      },
    },
  };
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-signer@sha256:${"c".repeat(64)}`;
  const task = renderTaskDefinition(pluginConfig, "signer", image, {
    CORE_SIGNING_SECRET: "arn:core-signing",
  });
  const container = task.containerDefinitions[0]!;
  const environment = Object.fromEntries(
    (container.environment as Array<{ name: string; value: string }>).map(({ name, value }) => [name, value]),
  );
  assert.equal(environment.CORE_API_URL, undefined);
  assert.equal(environment.CORE_ORG_ID, "acme");
  assert.deepEqual(container.secrets, []);
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
  printf '%s\\n' '{"services":[{"serviceName":"acme-core","desiredCount":0,"runningCount":0,"tags":[{"key":"Deployment","value":"acme"},{"key":"ManagedBy","value":"terraform"}]},{"serviceName":"acme-web-ui","desiredCount":0,"runningCount":0,"tags":[{"key":"Deployment","value":"acme"},{"key":"ManagedBy","value":"terraform"}]},{"serviceName":"acme-portal","desiredCount":0,"runningCount":0,"tags":[{"key":"Deployment","value":"acme"},{"key":"ManagedBy","value":"terraform"}]}],"failures":[]}'
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

test("AWS secret rotation rejects architecture changes before uploading or restarting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-secret-architecture-"));
  const secretsConfig: QmConfig = { ...structuredClone(oneServiceConfig()), env: {} };
  const operator = computedSecrets(secretsConfig).filter(
    (secret) => secret.managedBy === "operator" && secret.required,
  );
  writeFileSync(join(dir, ".env"), operator.map((secret) => `${secret.name}=${TEST_SECRET_VALUE}`).join("\n"));
  const fake = statefulAws(dir, secretsConfig);
  const state = JSON.parse(readFileSync(fake.state, "utf8"));
  const taskArn = state.services["acme-core"].taskDefinition;
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  state.definitions[taskArn] = renderTaskDefinition(secretsConfig, "core", image);
  state.definitions[taskArn].runtimePlatform.cpuArchitecture = "ARM64";
  state.dynamo = manifestItems([{ id: "current", imageLabel: "release", tasks: { core: taskArn } }], "current");
  writeFileSync(fake.state, JSON.stringify(state));
  try {
    for (const architecture of [undefined, "amd64"] as const) {
      secretsConfig.aws!.services.core!.architecture = architecture;
      await assert.rejects(
        () => awsSecretsPush(secretsConfig, dir),
        /core uses ARM64 but its configuration selects X86_64/,
      );
      assert.doesNotMatch(
        readFileSync(fake.log, "utf8"),
        /secretsmanager put-secret-value|ecs (?:register-task-definition|update-service)/,
      );
    }
    secretsConfig.aws!.services.core!.architecture = "arm64";
    await awsSecretsPush(secretsConfig, dir);
    const rotated = JSON.parse(readFileSync(fake.state, "utf8"));
    const task = rotated.definitions[rotated.services["acme-core"].taskDefinition];
    assert.equal(task.runtimePlatform.cpuArchitecture, "ARM64");
    assert.equal(task.containerDefinitions[0].image, image);
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
  state.dynamo = manifestItems(
    [{ id: "current", imageLabel: "release", tasks: { core: oldTask }, counts: { core: 0 } }],
    "current",
  );
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
    assert.deepEqual(manifest.counts, { core: 0 });
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
    linear: state.services["acme-linear"].taskDefinition,
  };
  const arns = Object.fromEntries(
    required
      .map((secret) => secret.name)
      .map((name) => [name, "arn:aws:secretsmanager:us-west-2:123456789012:secret:test-AbCdEf"]),
  );
  for (const workload of ["core", "linear"] as const) {
    const repository = secretsConfig.aws!.services[workload]!.ecrRepository;
    const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/${repository}@sha256:${"a".repeat(64)}`;
    state.definitions[oldTasks[workload]] = renderTaskDefinition(secretsConfig, workload, image, arns);
  }
  state.dynamo = manifestItems([{ id: "current", imageLabel: "release", tasks: oldTasks }], "current");
  writeFileSync(fake.state, JSON.stringify(state));
  try {
    await assert.rejects(
      () => awsSecretsPush(secretsConfig, dir),
      /did not identify the replacement deployment for linear/,
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
      updates.some((line) => line.includes("--service acme-linear") && line.includes("--force-new-deployment")),
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

test("AWS migration runs the exact candidate core image inside the service VPC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-candidate-migrate-"));
  const candidatePath = join(dir, "candidate.json");
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  writeFileSync(
    candidatePath,
    JSON.stringify({
      contract: 1,
      accountId: "123456789012",
      region: "us-west-2",
      label: "candidate-deadbeef",
      images: { core: image },
      imageProvenance: { core: { kind: "source-build", source: "checkout" } },
      architectures: { core: "amd64" },
    }),
  );
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single);
  try {
    await awsMigrateCandidate(single, dir, candidatePath);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /ecs run-task .*--launch-type FARGATE/);
    assert.match(calls, /subnet-a/);
    assert.match(calls, /src\/migrate-main\.ts/);
    assert.match(calls, /ecs deregister-task-definition/);
    assert.ok(calls.indexOf("dynamodb put-item") < calls.indexOf("ecs run-task"));
    assert.ok(calls.indexOf("rds describe-db-instances") < calls.indexOf("ecs run-task"));
    assert.ok(calls.indexOf("ecs describe-tasks") < calls.indexOf("dynamodb delete-item"));
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    const registered = Object.values(state.definitions) as Array<{
      containerDefinitions: Array<{ image: string; healthCheck?: unknown }>;
    }>;
    assert.equal(registered.at(-1)?.containerDefinitions[0]?.image, image);
    assert.equal(registered.at(-1)?.containerDefinitions[0]?.healthCheck, undefined);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS migration polls a long-running task to its deadline without stopping it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-candidate-migrate-wait-"));
  const candidatePath = join(dir, "candidate.json");
  writeFileSync(
    candidatePath,
    JSON.stringify({
      contract: 1,
      accountId: "123456789012",
      region: "us-west-2",
      label: "candidate-deadbeef",
      images: { core: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}` },
      imageProvenance: { core: { kind: "source-build", source: "checkout" } },
      architectures: { core: "amd64" },
    }),
  );
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single);
  const setState = (patch: Record<string, unknown>): void => {
    writeFileSync(fake.state, JSON.stringify({ ...JSON.parse(readFileSync(fake.state, "utf8")), ...patch }));
    writeFileSync(fake.log, "");
  };
  const priorDeadline = process.env.QM_AWS_ROLLOUT_DEADLINE_MS;
  try {
    setState({ missingPolls: 2, runningPolls: 3 });
    await awsMigrateCandidate(single, dir, candidatePath);
    assert.equal(readFileSync(fake.log, "utf8").match(/ecs describe-tasks/g)?.length, 6);

    setState({ runningPolls: 1e9 });
    process.env.QM_AWS_ROLLOUT_DEADLINE_MS = "50";
    await assert.rejects(
      () => awsMigrateCandidate(single, dir, candidatePath),
      /task\/canary is still RUNNING and was left running/,
    );
    let calls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(calls, /ecs stop-task/);
    assert.match(calls, /ecs deregister-task-definition/);
    assert.match(calls, /dynamodb delete-item/);

    setState({ runningPolls: 0, missingPolls: 1e9 });
    await assert.rejects(
      () => awsMigrateCandidate(single, dir, candidatePath),
      /ECS still does not list arn:aws:ecs:us-west-2:123456789012:task\/canary/,
    );

    setState({ missingPolls: 1, failureReason: "ACCESS_DENIED" });
    await assert.rejects(
      () => awsMigrateCandidate(single, dir, candidatePath),
      /migration task arn:aws:ecs:us-west-2:123456789012:task\/canary failed \(ACCESS_DENIED\)/,
    );
    calls = readFileSync(fake.log, "utf8");
    assert.equal(calls.match(/ecs describe-tasks/g)?.length, 1);
    assert.match(calls, /dynamodb delete-item/);
  } finally {
    if (priorDeadline === undefined) delete process.env.QM_AWS_ROLLOUT_DEADLINE_MS;
    else process.env.QM_AWS_ROLLOUT_DEADLINE_MS = priorDeadline;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS builds one immutable candidate manifest and deploys its exact digest without rebuilding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-candidate-"));
  const candidatePath = join(dir, "candidate.json");
  const dockerLog = join(dir, "docker.log");
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerLog, "");
  writeFileSync(
    dockerBin,
    `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(dockerLog)}, process.argv.slice(2).join(" ") + "\\n");\n`,
  );
  chmodSync(dockerBin, 0o755);
  const single = oneServiceConfig();
  const fake = statefulAws(dir, single);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(single, dir, {
      buildOnly: true,
      buildFrom: true,
      imageLabel: "candidate-deadbeef",
      candidateOut: candidatePath,
    });
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
    assert.equal(candidate.contract, 1);
    assert.equal(candidate.accountId, "123456789012");
    assert.equal(candidate.region, "us-west-2");
    assert.equal(candidate.label, "candidate-deadbeef");
    assert.equal(
      candidate.images.core,
      `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`,
    );
    assert.equal(candidate.imageProvenance.core.kind, "source-build");
    assert.equal(candidate.imageProvenance.core.source, "checkout");
    assert.deepEqual(candidate.architectures, { core: "amd64" });
    assert.match(readFileSync(dockerLog, "utf8"), /buildx build .*candidate-deadbeef/);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /dynamodb|ecs |secretsmanager/);

    writeFileSync(dockerLog, "");
    writeFileSync(fake.log, "");
    await awsUp(single, dir, { yes: true, candidate: candidatePath });
    const deployCalls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(deployCalls, /ecr put-image|ecr batch-delete-image|ecr initiate-layer-upload/);
    assert.match(deployCalls, /ecs run-task .*src\/migrate-main\.ts/);
    assert.ok(deployCalls.indexOf("rds describe-db-instances") < deployCalls.indexOf("ecs run-task"));
    assert.ok(deployCalls.indexOf("ecs run-task") < deployCalls.indexOf("ecs update-service"));
    assert.doesNotMatch(deployCalls, /rds (?:create|describe|delete)-db-snapshot/);
    assert.doesNotMatch(deployCalls, /ecr get-login-password|ecr describe-images|imageTag=qm-staging/);
    assert.equal(readFileSync(dockerLog, "utf8"), "");
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    const current = state.dynamo["deployment/current"].manifestId.S;
    const deployed = JSON.parse(state.dynamo[`deployment/manifest/${current}`].manifest.S);
    assert.equal(state.definitions[deployed.tasks.core].containerDefinitions[0].image, candidate.images.core);
    assert.equal(deployCalls.match(/ecs register-task-definition/g)?.length, 1);
    assert.doesNotMatch(deployCalls, /ecs deregister-task-definition/);
    assert.ok(deployCalls.includes(`--task-definition ${deployed.tasks.core} --launch-type FARGATE`));
    assert.ok(state.definitions[deployed.tasks.core].containerDefinitions[0].healthCheck);
    writeFileSync(fake.log, "");
    await awsUp(single, dir, { yes: true, candidate: candidatePath });
    const repeatCalls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(repeatCalls, /ecs (?:register-task-definition|deregister-task-definition|update-service)/);
    assert.ok(repeatCalls.includes(`--task-definition ${deployed.tasks.core} --launch-type FARGATE`));
    assert.ok(Number.isFinite(Date.parse(deployed.dbRestorePoint)));
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS candidate builds honor their concurrency bound and join failures before publishing", async () => {
  for (const mode of ["serial", "parallel", "failure"]) {
    const dir = mkdtempSync(join(tmpdir(), "qm-aws-build-parallel-"));
    const candidatePath = join(dir, "candidate.json");
    const events = join(dir, "events");
    writeFileSync(events, "");
    const built = { ...twoServiceConfig(), plugins: [{ name: "linear" }] };
    mkdirSync(join(dir, "plugins", "linear"), { recursive: true });
    writeFileSync(join(dir, "plugins", "linear", "Dockerfile"), "FROM scratch\n");
    const fake = statefulAws(dir, built);
    const docker = join(dir, "docker");
    writeFileSync(
      docker,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "login" || args[1] === "inspect") process.exit(0);
const name = args[args.indexOf("-t") + 1].split("/").at(-1).split(":")[0].slice(3);
const dir = ${JSON.stringify(dir)};
const events = ${JSON.stringify(events)};
const mode = ${JSON.stringify(mode)};
const log = (event) => fs.appendFileSync(events, event + ":" + name + "\\n");
log("start");
fs.writeFileSync(path.join(dir, "started-" + name), "");
(async () => {
  if (mode !== "serial" && ["core", "linear"].includes(name)) {
    const deadline = Date.now() + 10000;
    while (!["core", "linear"].every((peer) => fs.existsSync(path.join(dir, "started-" + peer)))) {
      if (Date.now() > deadline) process.exit(9);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (mode === "failure" && name === "core") { log("fail"); process.exit(7); }
  await new Promise((resolve) => setTimeout(resolve, 50));
  log("end");
})();
`,
    );
    chmodSync(docker, 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = `${dir}:${priorPath}`;
    try {
      const provider = hostingProvider("aws");
      const context = {
        config: built,
        configDir: dir,
        configPath: join(dir, "qm.config.json"),
        sandboxDir: dir,
        target: "aws" as const,
      };
      const options = provider.upOptions(
        context,
        {
          "build-only": true,
          "build-from": true,
          ...(mode === "serial" ? {} : { "build-concurrency": "2" }),
          "image-label": "parallel-candidate",
          "candidate-out": candidatePath,
        },
        false,
      );
      const result = provider.createBackend(context).up(options);
      if (mode === "failure") {
        await assert.rejects(result, /docker exited with 7/);
        assert.equal(existsSync(candidatePath), false);
      } else {
        await result;
        const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
        assert.deepEqual(Object.keys(candidate.images).sort(), ["core", "linear"]);
        assert.deepEqual(Object.keys(candidate.imageProvenance).sort(), ["core", "linear"]);
        assert.ok(Object.values(candidate.images).every((image) => /@sha256:[a-f0-9]{64}$/.test(String(image))));
      }
      const lines = readFileSync(events, "utf8").trim().split("\n");
      let active = 0;
      let peak = 0;
      for (const line of lines) {
        active += line.startsWith("start:") ? 1 : -1;
        peak = Math.max(peak, active);
      }
      assert.equal(active, 0);
      assert.equal(peak, mode === "serial" ? 1 : 2);
      if (mode === "failure") {
        assert.ok(lines.includes("end:linear"));
        assert.equal(lines.filter((line) => line.startsWith("start:")).length, 2);
      }
      assert.doesNotMatch(readFileSync(fake.log, "utf8"), /dynamodb|ecs |secretsmanager/);
    } finally {
      process.env.PATH = priorPath;
      fake.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("AWS source builds reuse a per-repository registry cache when the builder can export one", async () => {
  for (const driver of ["", "docker", "docker-container"]) {
    const dir = mkdtempSync(join(tmpdir(), "qm-aws-build-cache-"));
    const candidatePath = join(dir, "candidate.json");
    const calls = join(dir, "docker-calls");
    const fake = statefulAws(dir, config);
    const docker = join(dir, "docker");
    writeFileSync(
      docker,
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[1] === "inspect") console.log("Name:   default\\nDriver: ${driver}\\n");
else if (args[0] !== "login") require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
`,
    );
    chmodSync(docker, 0o755);
    const priorPath = process.env.PATH;
    process.env.PATH = `${dir}:${priorPath}`;
    try {
      await awsUp(config, dir, {
        buildOnly: true,
        buildFrom: true,
        imageLabel: "cached-candidate",
        candidateOut: candidatePath,
      });
      const builds = readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(builds.length, runnableServices(config.services).length);
      for (const args of builds) {
        const tagged = args[args.indexOf("-t") + 1]!;
        const ref = `${tagged.slice(0, tagged.lastIndexOf(":"))}:buildcache-${args[args.indexOf("--platform") + 1]!.split("/")[1]}`;
        if (driver !== "docker-container") assert.ok(!args.includes("--cache-from") && !args.includes("--cache-to"));
        else {
          assert.equal(args[args.indexOf("--cache-from") + 1], `type=registry,ref=${ref}`);
          assert.equal(
            args[args.indexOf("--cache-to") + 1],
            `type=registry,ref=${ref},mode=max,image-manifest=true,oci-mediatypes=true,ignore-error=true`,
          );
        }
      }
    } finally {
      process.env.PATH = priorPath;
      fake.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("cancelling candidate builds terminates and joins every Docker child without a manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-build-cancel-"));
  const candidatePath = join(dir, "candidate.json");
  const built = { ...twoServiceConfig(), plugins: [{ name: "linear" }] };
  mkdirSync(join(dir, "plugins", "linear"), { recursive: true });
  writeFileSync(join(dir, "plugins", "linear", "Dockerfile"), "FROM scratch\n");
  const fake = statefulAws(dir, built);
  const docker = join(dir, "docker");
  writeFileSync(
    docker,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "login" || args[1] === "inspect") process.exit(0);
const name = args[args.indexOf("-t") + 1].split("/").at(-1).split(":")[0].slice(3);
const dir = ${JSON.stringify(dir)};
if (name === "core") process.on("SIGTERM", () => {});
if (name === "linear") {
  const plugin = 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(' + JSON.stringify(path.join(dir, "pid-linear-plugin")) + ', String(process.pid)); setTimeout(() => {}, 20000);';
  require("node:child_process").spawn(process.execPath, ["-e", plugin], { stdio: "inherit" });
}
fs.writeFileSync(path.join(dir, "pid-" + name), String(process.pid));
setTimeout(() => fs.writeFileSync(path.join(dir, "completed-" + name), ""), 20000);
`,
  );
  chmodSync(docker, 0o755);
  const moduleUrl = new URL("../src/backends/aws.ts", import.meta.url).href;
  const code = `const { awsUp } = await import(${JSON.stringify(moduleUrl)}); await awsUp(${JSON.stringify(built)}, ${JSON.stringify(dir)}, ${JSON.stringify({ buildOnly: true, buildFrom: true, buildConcurrency: 2, imageLabel: "cancelled-candidate", candidateOut: candidatePath })});`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    parent.once("error", reject);
    parent.once("exit", resolve);
  });
  try {
    const deadline = Date.now() + 10000;
    while (!["core", "linear", "linear-plugin"].every((name) => existsSync(join(dir, "pid-" + name)))) {
      assert.ok(Date.now() < deadline, "Docker children and nested buildx plugin must start");
      assert.equal(parent.exitCode, null);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    parent.kill("SIGTERM");
    assert.notEqual(await exited, 0);
    assert.equal(existsSync(candidatePath), false);
    for (const name of ["core", "linear", "linear-plugin"]) {
      const pid = Number(readFileSync(join(dir, "pid-" + name), "utf8"));
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
      assert.equal(existsSync(join(dir, "completed-" + name)), false);
    }
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /dynamodb|ecs |secretsmanager/);
  } finally {
    parent.kill("SIGKILL");
    for (const name of ["core", "linear", "linear-plugin"]) {
      const path = join(dir, "pid-" + name);
      if (existsSync(path)) {
        try {
          process.kill(Number(readFileSync(path, "utf8")), "SIGKILL");
        } catch {
          void 0;
        }
      }
    }
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS rejects invalid or misplaced candidate build concurrency before mutation", async () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(awsUp(config, ".", { buildOnly: true, buildConcurrency: value }), /positive integer/);
  }
  await assert.rejects(awsUp(config, ".", { buildConcurrency: 2 }), /requires --build-only/);
  const shared = structuredClone(twoServiceConfig());
  shared.aws!.services.linear!.ecrRepository = shared.aws!.services.core!.ecrRepository;
  await assert.rejects(awsUp(shared, ".", { buildOnly: true, buildConcurrency: 2 }), /distinct ECR repositories/);
});

test("AWS candidate deploy fails closed on account, repository, or missing-workload drift", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-candidate-invalid-"));
  const candidatePath = join(dir, "candidate.json");
  const base = {
    contract: 1,
    accountId: "123456789012",
    region: "us-west-2",
    label: "candidate-deadbeef",
    images: {
      core: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`,
    },
    imageProvenance: { core: { kind: "source-build", source: "checkout" } },
    architectures: { core: "amd64" },
  };
  const fake = fakeAws(dir, "");
  try {
    writeFileSync(candidatePath, JSON.stringify({ ...base, accountId: "999999999999" }));
    await assert.rejects(
      () => awsUp(oneServiceConfig(), dir, { dryRun: true, candidate: candidatePath }),
      /invalid contract/,
    );
    writeFileSync(
      candidatePath,
      JSON.stringify({
        ...base,
        images: { core: `123456789012.dkr.ecr.us-west-2.amazonaws.com/other@sha256:${"a".repeat(64)}` },
      }),
    );
    await assert.rejects(
      () => awsUp(oneServiceConfig(), dir, { dryRun: true, candidate: candidatePath }),
      /invalid core image/,
    );
    writeFileSync(candidatePath, JSON.stringify({ ...base, images: {}, imageProvenance: {}, architectures: {} }));
    await assert.rejects(
      () => awsUp(oneServiceConfig(), dir, { dryRun: true, candidate: candidatePath }),
      /does not contain core/,
    );
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS candidate consumption rejects unknown or mismatched source image architectures before AWS access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-candidate-architecture-"));
  const candidatePath = join(dir, "candidate.json");
  const single = structuredClone(oneServiceConfig());
  const candidate = {
    contract: 1,
    accountId: "123456789012",
    region: "us-west-2",
    label: "legacy-arm64",
    images: { core: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}` },
    imageProvenance: { core: { kind: "source-build", source: "checkout" } },
  };
  const fake = statefulAws(dir, single);
  try {
    for (const architectures of [
      undefined,
      null,
      [],
      "amd64",
      {},
      { core: "arm64" },
      { core: "invalid" },
      { core: "amd64", unknown: "amd64" },
    ]) {
      writeFileSync(candidatePath, JSON.stringify({ ...candidate, architectures }));
      await assert.rejects(
        () => awsUp(single, dir, { yes: true, candidate: candidatePath }),
        /architecture|invalid contract/,
      );
      await assert.rejects(() => awsMigrateCandidate(single, dir, candidatePath), /architecture|invalid contract/);
      assert.equal(readFileSync(fake.log, "utf8"), "");
    }
    single.aws!.services.core!.architecture = "arm64";
    writeFileSync(candidatePath, JSON.stringify(candidate));
    await awsMigrateCandidate(single, dir, candidatePath);
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    const registered = Object.values(state.definitions) as Array<{
      runtimePlatform?: { cpuArchitecture?: string };
      containerDefinitions: Array<{ image: string }>;
    }>;
    assert.equal(registered.at(-1)?.runtimePlatform?.cpuArchitecture, "ARM64");
    assert.equal(registered.at(-1)?.containerDefinitions[0]?.image, candidate.images.core);
    delete single.aws!.services.core!.architecture;
    writeFileSync(
      candidatePath,
      JSON.stringify({ ...candidate, imageProvenance: { core: { kind: "configured", source: manifestRef("core") } } }),
    );
    await awsMigrateCandidate(single, dir, candidatePath);
    const configured = JSON.parse(readFileSync(fake.state, "utf8"));
    const configuredTasks = Object.values(configured.definitions) as Array<{
      runtimePlatform?: { cpuArchitecture?: string };
    }>;
    assert.equal(configuredTasks.at(-1)?.runtimePlatform?.cpuArchitecture, "X86_64");
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS migration failure deregisters the candidate task and releases the deploy lease", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-candidate-migrate-failure-"));
  const candidatePath = join(dir, "candidate.json");
  writeFileSync(
    candidatePath,
    JSON.stringify({
      contract: 1,
      accountId: "123456789012",
      region: "us-west-2",
      label: "candidate-deadbeef",
      images: {
        core: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`,
      },
      imageProvenance: { core: { kind: "source-build", source: "checkout" } },
      architectures: { core: "amd64" },
    }),
  );
  const fake = statefulAws(dir, oneServiceConfig(), {}, { migrationExitCode: 1 });
  try {
    await assert.rejects(
      () => awsMigrateCandidate(oneServiceConfig(), dir, candidatePath),
      /migration task arn:aws:ecs:us-west-2:123456789012:task\/canary exited 1: migration failed; Essential container in task exited/,
    );
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /ecs deregister-task-definition/);
    assert.match(calls, /dynamodb delete-item/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS candidate deploy migration failure preserves the runtime and releases the lease", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-candidate-migrate-failure-"));
  const candidatePath = join(dir, "candidate.json");
  writeFileSync(
    candidatePath,
    JSON.stringify({
      contract: 1,
      accountId: "123456789012",
      region: "us-west-2",
      label: "candidate-deadbeef",
      images: {
        core: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`,
      },
      imageProvenance: { core: { kind: "source-build", source: "checkout" } },
      architectures: { core: "amd64" },
    }),
  );
  const fake = statefulAws(dir, oneServiceConfig(), {}, { migrationExitCode: 1 });
  const before = JSON.parse(readFileSync(fake.state, "utf8"));
  try {
    await assert.rejects(
      () => awsUp(oneServiceConfig(), dir, { yes: true, candidate: candidatePath }),
      /migration task arn:aws:ecs:us-west-2:123456789012:task\/canary exited 1: migration failed; Essential container in task exited/,
    );
    const calls = readFileSync(fake.log, "utf8");
    assert.doesNotMatch(calls, /ecs (?:deregister-task-definition|update-service)/);
    assert.equal(calls.match(/ecs register-task-definition/g)?.length, 1);
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(state.services["acme-core"].taskDefinition, before.services["acme-core"].taskDefinition);
    assert.match(calls, /dynamodb delete-item/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

const linearService = {
  ecrRepository: "qm-linear",
  ecsService: "acme-linear",
  cpu: 256,
  memory: 512,
  architecture: "amd64" as const,
};

const twoServiceConfig = (): QmConfig => ({
  ...config,
  plugins: [{ name: "linear", image: "ghcr.io/acme/linear:1" }],
  aws: { ...config.aws!, services: { core: config.aws!.services.core!, linear: linearService } },
});

function manifestItems(
  manifests: Array<{
    id: string;
    previous?: string;
    imageLabel?: string;
    dbSnapshot?: string;
    dbRestorePoint?: string;
    tasks: Record<string, string>;
    counts?: Record<string, number>;
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
    linear: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-linear:4",
  };
  const current = {
    core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:9",
    linear: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-linear:8",
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
    assert.match(calls, /--task-definition arn:aws:ecs:us-west-2:123456789012:task-definition\/acme-linear:4/);
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

test("AWS rollback surfaces the restore point recorded before the rolled-back deployment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-rollback-restore-point-"));
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
          dbRestorePoint: "2026-07-29T00:00:00.000Z",
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
    assert.match(
      out,
      /the database restore point taken before the first rolled-back deployment is 2026-07-29T00:00:00\.000Z/,
    );
    assert.match(
      out,
      /restore-db-instance-to-point-in-time --source-db-instance-identifier acme-qm-core --target-db-instance-identifier acme-qm-core-restored --restore-time 2026-07-29T00:00:00\.000Z --region us-west-2, then repoint the stack at the restored instance/,
    );
  } finally {
    console.log = log;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS rollback across a mixed chain surfaces the oldest rolled-back restore, legacy snapshot included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-rollback-mixed-chain-"));
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
          dbRestorePoint: "2026-07-29T00:00:00.000Z",
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
      /the database snapshot taken before the first rolled-back deployment is acme-qm-core-predeploy-b \(restore: aws rds restore-db-instance-from-db-snapshot/,
      "the legacy snapshot on the oldest rolled-back deployment wins over the newer restore point",
    );
    assert.doesNotMatch(out, /2026-07-29T00:00:00\.000Z/);
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
        { id: "current", previous: "old", tasks: { core: "core:2", linear: "web:2" } },
      ],
      "current",
    ),
  );
  try {
    await assert.rejects(() => awsRollback(multi), /missing workloads: linear/);
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
    assert.match(out, /linear\s*\| line-from-/);
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
        /core-public target group has no healthy targets/.test(error.message) &&
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
    await assert.rejects(
      () =>
        awsCheckLive(
          {
            ...single,
            aws: { ...single.aws!, services: { core: { ...single.aws!.services.core!, architecture: "arm64" } } },
          },
          { report: false },
        ),
      /task-definition drift.*runtimePlatform.cpuArchitecture/,
    );
    process.env.AWS_FAKE_SECRET_VALUE = "short";
    await assert.rejects(() => awsCheckLive(single, { report: false }), /secret CORE_SIGNING_SECRET/);
    if (priorSecretValue === undefined) delete process.env.AWS_FAKE_SECRET_VALUE;
    else process.env.AWS_FAKE_SECRET_VALUE = priorSecretValue;
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecr describe-images/);
    assert.doesNotMatch(readFileSync(dockerLog, "utf8"), /buildx imagetools inspect/);
    const overridden: QmConfig = {
      ...single,
      imageOverrides: { core: `ghcr.io/acme/core@sha256:${"b".repeat(64)}` },
      aws: { ...single.aws!, services: { core: { ...single.aws!.services.core!, architecture: "amd64" } } },
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
      services: { ...single.aws!.services, linear: linearService },
    },
  };
  const expected = /aws\.services topology mismatch \(disabled workloads: linear\)/;
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
    linear: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-linear:1",
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
            linear: { kind: "configured", source: "ghcr.io/acme/linear:1" },
          },
        },
      ],
      "baseline",
    ),
  );
  const state = JSON.parse(readFileSync(baseline.state, "utf8"));
  state.definitions[tasks.linear] = {
    containerDefinitions: [
      {
        name: "linear",
        image: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-linear@sha256:${"d".repeat(64)}`,
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
    assert.equal(current.tasks.linear, tasks.linear);
    assert.deepEqual(current.imageProvenance, {
      core: { kind: "configured", source: manifestRef("core") },
      linear: { kind: "configured", source: "ghcr.io/acme/linear:1" },
    });
  } finally {
    process.env.PATH = priorPath;
    baseline.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS up can introduce a selected workload onto a trusted deployment baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-partial-add-"));
  const multi = twoServiceConfig();
  const coreTask = "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1";
  const baseline = statefulAws(
    dir,
    multi,
    manifestItems(
      [
        {
          id: "baseline",
          imageLabel: "previous",
          tasks: { core: coreTask },
          imageProvenance: { core: { kind: "configured", source: "ghcr.io/acme/qm-core:0.1.0" } },
        },
      ],
      "baseline",
    ),
  );
  const state = JSON.parse(readFileSync(baseline.state, "utf8"));
  state.definitions[coreTask] = {
    containerDefinitions: [
      {
        name: "core",
        image: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"d".repeat(64)}`,
      },
    ],
  };
  writeFileSync(baseline.state, JSON.stringify(state));
  await assert.rejects(
    () => awsUp(multi, dir, { dryRun: true, only: ["linear"] }),
    /selected workload linear .* must be scaled to zero before adoption/,
  );
  state.services["acme-linear"].desiredCount = 0;
  writeFileSync(baseline.state, JSON.stringify(state));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(multi, dir, { yes: true, only: ["linear"] });
    const after = JSON.parse(readFileSync(baseline.state, "utf8"));
    const currentId = after.dynamo["deployment/current"].manifestId.S;
    const current = JSON.parse(after.dynamo[`deployment/manifest/${currentId}`].manifest.S);
    assert.equal(current.tasks.core, coreTask);
    assert.match(current.tasks.linear, /task-definition\/acme-linear:2$/);
    const previous = JSON.parse(after.dynamo["deployment/manifest/baseline"].manifest.S);
    assert.match(previous.tasks.linear, /task-definition\/acme-linear:1$/);
    assert.equal(previous.counts.linear, 0);
    const calls = readFileSync(baseline.log, "utf8");
    assert.doesNotMatch(calls, /ecs update-service .*--service acme-core/);
    assert.match(calls, /ecs update-service .*--service acme-linear/);
    await awsRollback(multi);
    const rolledBack = JSON.parse(readFileSync(baseline.state, "utf8"));
    assert.match(rolledBack.services["acme-linear"].taskDefinition, /task-definition\/acme-linear:1$/);
    assert.equal(rolledBack.services["acme-linear"].desiredCount, 0);
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

test("AWS up looks up the front door by the configured ALB name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-alb-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const albConfig = (): QmConfig => {
    const base = oneServiceConfig();
    return { ...base, aws: { ...base.aws!, alb: "legacy-alb" } };
  };
  const fake = statefulAws(dir, albConfig());
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(albConfig(), dir, { yes: true });
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.ok(state.dynamo["deployment/current"]);
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

test("AWS up waits for native blue-green success instead of trusting the stale legacy rollout field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-blue-green-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const fake = statefulAws(dir, oneServiceConfig(), {}, { blueGreenBakePolls: 4 });
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(oneServiceConfig(), dir, { yes: true });
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.ok(state.blueGreenPolls > 4);
    assert.ok(state.dynamo["deployment/current"]);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /ecs list-service-deployments/);
    assert.match(calls, /ecs describe-service-revisions/);
    assert.doesNotMatch(calls, /--deployment-configuration/);
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

test("AWS up tolerates a transient native blue-green status failure while polling the rollout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-transient-native-status-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const fake = statefulAws(
    dir,
    oneServiceConfig(),
    {},
    {
      blueGreenBakePolls: 2,
      failNativeStatusOnceAfterUpdate: true,
    },
  );
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(oneServiceConfig(), dir, { yes: true });
    const state = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.ok(state.nativeStatusFailedOnce, "the transient failure was actually injected");
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

for (const running of [0, 1]) {
  test(`AWS up treats a lingering INACTIVE deployment as retired only once its tasks stop: runningCount=${running}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-aws-up-inactive-deployment-"));
    const dockerBin = join(dir, "docker");
    writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
    chmodSync(dockerBin, 0o755);
    const fake = statefulAws(dir, oneServiceConfig(), {}, { inactiveDeploymentRunning: running });
    const priorPath = process.env.PATH;
    const priorDeadline = process.env.QM_AWS_ROLLOUT_DEADLINE_MS;
    process.env.PATH = `${dir}:${priorPath}`;
    process.env.QM_AWS_ROLLOUT_DEADLINE_MS = "1500";
    try {
      if (running === 0) await awsUp(oneServiceConfig(), dir, { yes: true });
      else
        await assert.rejects(
          () => awsUp(oneServiceConfig(), dir, { yes: true }),
          /timed out waiting for the AWS rollout/,
        );
    } finally {
      process.env.PATH = priorPath;
      if (priorDeadline === undefined) delete process.env.QM_AWS_ROLLOUT_DEADLINE_MS;
      else process.env.QM_AWS_ROLLOUT_DEADLINE_MS = priorDeadline;
      fake.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

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
      /expected exactly one public listener plus at most one port-80 HTTPS-redirect listener, found HTTPS:443 \(default forward\), HTTP:80 \(default forward\)/,
    );
  } finally {
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS renders config secretEnv extras and aliases as Secrets Manager references", () => {
  const extras: QmConfig = {
    ...config,
    secretEnv: {
      core: { OPENAI_API_KEY: "OPENAI_API_KEY", DEPLOY_APPS_SESSION_SECRET: "SHARED_SESSION_SECRET" },
      slack: { SLACK_AUX_BOT_TOKEN: "SLACK_AUX_BOT_TOKEN" },
    },
  };
  const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`;
  const task = renderTaskDefinition(extras, "core", image, { SHARED_SESSION_SECRET: "arn:resolved:shared-session" });
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
    "arn:resolved:shared-session",
    "an alias delivers the stored secret under its declared env name",
  );
  assert.equal(secrets.SHARED_SESSION_SECRET, undefined, "the alias adds no plain-name delivery on core");
});

test("env.core.SANDBOX_BACKEND adopts the deployment's substrate; the default is sprites", () => {
  assert.equal(serviceEnvironment(config, "core").SANDBOX_BACKEND, "sprites");
  const adopted: QmConfig = {
    ...config,
    env: { ...config.env, core: { ...config.env.core, SANDBOX_BACKEND: "sprites" } },
  };
  assert.equal(serviceEnvironment(adopted, "core").SANDBOX_BACKEND, "sprites");
  const agent37: QmConfig = {
    ...config,
    sandbox: undefined,
    env: { ...config.env, core: { ...config.env.core, SANDBOX_BACKEND: "agent37" } },
  };
  const agent37Env = serviceEnvironment(agent37, "core");
  assert.equal(agent37Env.SANDBOX_BACKEND, "agent37");
  assert.equal(agent37Env.AWS_SANDBOX_IMAGE, undefined);
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
  assert.equal(derived.stopTimeout, 60, "core waits out its 30 s drain plus 30 s to hand turns back");
  const withDrain = (drain: string): QmConfig => ({
    ...config,
    env: { ...config.env, core: { ...config.env.core, SHUTDOWN_DRAIN_MS: drain } },
  });
  assert.equal(renderTaskDefinition(withDrain("90000"), "core", image).containerDefinitions[0]!.stopTimeout, 120);
  assert.throws(() => renderTaskDefinition(withDrain("90001"), "core", image), /SHUTDOWN_DRAIN_MS=90001/);
  assert.equal(renderTaskDefinition(withDrain(""), "core", image).containerDefinitions[0]!.stopTimeout, 60);
  assert.throws(() => renderTaskDefinition(withDrain("soon"), "core", image), /SHUTDOWN_DRAIN_MS=soon/);
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
  const pinnedLongDrain: QmConfig = { ...adopted, env: withDrain("100000").env };
  assert.equal(renderTaskDefinition(pinnedLongDrain, "core", image).containerDefinitions[0]!.stopTimeout, 120);
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

test("AWS private canary reaches core without a core ingress target and refuses missing current tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-private-canary-"));
  writeFileSync(join(dir, "docker"), `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(join(dir, "docker"), 0o755);
  const fake = statefulAws(dir, config);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  try {
    await awsUp(config, dir, { yes: true });
    await awsCheckLive(config, { report: false });
    assert.match(
      readFileSync(fake.log, "utf8"),
      /ecs list-tasks .*--service-name acme-core .*--desired-status RUNNING/,
    );
    assert.match(readFileSync(fake.log, "utf8"), /postdeploy-smoke\.ts.*http:\/\/10\.0\.1\.8:8080/);
    const priorLarge = process.env.AWS_FAKE_LARGE_ROLLOUT;
    process.env.AWS_FAKE_LARGE_ROLLOUT = "1";
    try {
      await awsCheckLive(config, { report: false });
    } finally {
      if (priorLarge === undefined) delete process.env.AWS_FAKE_LARGE_ROLLOUT;
      else process.env.AWS_FAKE_LARGE_ROLLOUT = priorLarge;
    }
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /--no-paginate/);
    for (const [flag, failure] of [
      ["AWS_FAKE_NO_RUNNING_TASK", /no running tasks/],
      ["AWS_FAKE_STALE_CORE", /no current running task/],
    ] as const) {
      const prior = process.env[flag];
      process.env[flag] = "1";
      try {
        await assert.rejects(() => awsCheckLive(config, { report: false }), failure);
      } finally {
        if (prior === undefined) delete process.env[flag];
        else process.env[flag] = prior;
      }
    }
  } finally {
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS layer GET and PUT bind the selected ALB while retaining API Host, TLS name, and signed path", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-layer-target-"));
  const fake = fakeAws(dir, "console.log('')");
  const priorSecret = process.env.CORE_SIGNING_SECRET;
  const priorAlb = process.env.AWS_FAKE_ALB_DNS;
  process.env.CORE_SIGNING_SECRET = TEST_SECRET_VALUE;
  process.env.AWS_FAKE_ALB_DNS = "inactive-stack.elb.example";
  const calls: Array<{ url: URL; options: https.RequestOptions; body: string }> = [];
  t.mock.method(https, "request", (url: URL, options: https.RequestOptions, callback: (response: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { end(body?: string): void };
    request.end = (body = "") => {
      calls.push({ url, options, body });
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { statusCode: 307 });
        callback(response);
        response.emit("data", Buffer.from("redirect must not be followed"));
        response.emit("end");
      });
    };
    return request;
  });
  try {
    const configured = {
      ...config,
      aws: { ...config.aws!, alb: "inactive-stack" },
      apiUrl: "https://api.acme.example/base?revision=1",
    };
    for (const method of ["GET", "PUT"] as const) {
      const body = method === "PUT" ? '{"contract":1}' : "";
      const result = await awsDeploymentLayerTransport({ config: configured, configDir: dir, method, body });
      assert.equal(result.status, 307);
    }
    assert.equal(calls.length, 2);
    for (const { url, options, body } of calls) {
      assert.equal(url.href, "https://api.acme.example/base/v1/deployment-layer?revision=1");
      assert.equal(options.hostname, "inactive-stack.elb.example");
      assert.equal(options.servername, "api.acme.example");
      assert.notEqual(options.rejectUnauthorized, false);
      assert.equal(options.agent, false);
      assert.ok(options.signal instanceof AbortSignal);
      const headers = options.headers as Record<string, string>;
      assert.equal(headers.host, "api.acme.example");
      assert.equal(
        headers["x-signature"],
        `v0=${createHmac("sha256", TEST_SECRET_VALUE).update(`v0:${headers["x-timestamp"]}:${options.method}\n${url.pathname}${url.search}\n${body}`).digest("hex")}`,
      );
    }
    assert.match(readFileSync(fake.log, "utf8"), /describe-load-balancers --names inactive-stack/);
  } finally {
    t.mock.restoreAll();
    fake.restore();
    if (priorSecret === undefined) delete process.env.CORE_SIGNING_SECRET;
    else process.env.CORE_SIGNING_SECRET = priorSecret;
    if (priorAlb === undefined) delete process.env.AWS_FAKE_ALB_DNS;
    else process.env.AWS_FAKE_ALB_DNS = priorAlb;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS layer transport uses the HTTPS front door when an HTTP ALB origin is configured", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-layer-proxy-"));
  const fake = fakeAws(dir, "console.log('')");
  const priorSecret = process.env.CORE_SIGNING_SECRET;
  const priorProtocol = process.env.AWS_FAKE_LISTENER_PROTOCOL;
  const priorCloudFront = process.env.AWS_FAKE_CLOUDFRONT;
  const distribution = {
    DomainName: "test.cloudfront.net",
    Status: "Deployed",
    Enabled: true,
    CacheBehaviors: { Quantity: 0 },
    DefaultCacheBehavior: { TargetOriginId: "alb", MaxTTL: 0 },
    Origins: {
      Items: [
        {
          Id: "alb",
          DomainName: "agent.acme.example",
          OriginPath: "",
          CustomOriginConfig: { OriginProtocolPolicy: "http-only", HTTPPort: 80 },
        },
      ],
    },
  };
  const setDistribution = (value: unknown) => {
    process.env.AWS_FAKE_CLOUDFRONT = JSON.stringify({ DistributionList: { Items: [value] } });
  };
  setDistribution(distribution);
  process.env.AWS_FAKE_LISTENER_PROTOCOL = "HTTP";
  process.env.CORE_SIGNING_SECRET = TEST_SECRET_VALUE;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(https, "request", () => {
    throw new Error("must not dial the HTTP origin with TLS");
  });
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    calls.push({ url: url.href, init });
    return new Response("applied", { status: 200 });
  });
  try {
    const configured = {
      ...config,
      publicUrl: "https://test.cloudfront.net",
      env: { ...config.env, core: { ...config.env.core, AWS_PUBLIC_ORIGIN_URL: "http://acme-qm.elb.example" } },
    };
    for (const method of ["GET", "PUT"] as const) {
      const body = method === "PUT" ? '{"contract":1}' : "";
      assert.equal(
        (await awsDeploymentLayerTransport({ config: configured, configDir: dir, method, body })).status,
        200,
      );
    }
    assert.equal(calls.length, 2);
    for (const { url, init } of calls) {
      assert.equal(url, "https://test.cloudfront.net/v1/deployment-layer");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      const headers = init.headers as Record<string, string>;
      assert.equal(
        headers["x-signature"],
        `v0=${createHmac("sha256", TEST_SECRET_VALUE)
          .update(`v0:${headers["x-timestamp"]}:${init.method}\n/v1/deployment-layer\n${init.body ?? ""}`)
          .digest("hex")}`,
      );
    }
    const fetchBeforeLimit = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(" ".repeat(33)));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    try {
      await assert.rejects(
        awsCoreRequest(
          configured,
          new URL(configured.publicUrl),
          {
            method: "POST",
            body: "{}",
            redirect: "error",
            signal: AbortSignal.timeout(1000),
          },
          32,
        ),
        /size limit/,
      );
      assert.equal(cancelled, true);
    } finally {
      globalThis.fetch = fetchBeforeLimit;
    }
    for (const invalid of [
      { ...distribution, DomainName: "another.cloudfront.net" },
      { ...distribution, Enabled: false },
      { ...distribution, Status: "InProgress" },
      { ...distribution, ContinuousDeploymentPolicyId: "staging-policy" },
      { ...distribution, DomainName: "other.cloudfront.net", Aliases: { Items: ["test.cloudfront.net"] } },
      { ...distribution, DefaultCacheBehavior: { TargetOriginId: "alb", MaxTTL: 60 } },
      { ...distribution, DefaultCacheBehavior: { TargetOriginId: "alb", MaxTTL: 0, CachePolicyId: "managed" } },
      { ...distribution, CacheBehaviors: { Quantity: 1 } },
      { ...distribution, DefaultCacheBehavior: { TargetOriginId: "other", MaxTTL: 0 } },
      {
        ...distribution,
        DefaultCacheBehavior: { TargetOriginId: "alb", MaxTTL: 0, FunctionAssociations: { Quantity: 1 } },
      },
      {
        ...distribution,
        DefaultCacheBehavior: { TargetOriginId: "alb", MaxTTL: 0, LambdaFunctionAssociations: { Quantity: 1 } },
      },
      ...[
        { DomainName: "other-stack.elb.example" },
        { OriginPath: "/prefix" },
        { CustomOriginConfig: { OriginProtocolPolicy: "match-viewer", HTTPPort: 80 } },
      ].map((change) => ({ ...distribution, Origins: { Items: [{ ...distribution.Origins.Items[0], ...change }] } })),
    ]) {
      setDistribution(invalid);
      await assert.rejects(
        () => awsDeploymentLayerTransport({ config: configured, configDir: dir, method: "PUT", body: "{}" }),
        /routing directly to the selected ALB/,
      );
    }
    assert.equal(calls.length, 2);
  } finally {
    if (priorCloudFront === undefined) delete process.env.AWS_FAKE_CLOUDFRONT;
    else process.env.AWS_FAKE_CLOUDFRONT = priorCloudFront;
    t.mock.restoreAll();
    fake.restore();
    if (priorSecret === undefined) delete process.env.CORE_SIGNING_SECRET;
    else process.env.CORE_SIGNING_SECRET = priorSecret;
    if (priorProtocol === undefined) delete process.env.AWS_FAKE_LISTENER_PROTOCOL;
    else process.env.AWS_FAKE_LISTENER_PROTOCOL = priorProtocol;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS core transport bounds streamed TLS bodies and destroys oversized responses", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-core-body-limit-"));
  const fake = fakeAws(dir, "console.log('')");
  let destroyed = false;
  t.mock.method(https, "request", (_url: URL, _options: https.RequestOptions, callback: (value: unknown) => void) => {
    const request = new EventEmitter() as EventEmitter & { end(): void };
    request.end = () => {
      const response = Object.assign(new EventEmitter(), {
        statusCode: 200,
        destroy(error: Error) {
          destroyed = true;
          response.emit("error", error);
        },
      });
      callback(response);
      response.emit("data", Buffer.from(" ".repeat(16)));
      response.emit("data", Buffer.from(" ".repeat(17)));
      response.emit("end");
    };
    return request;
  });
  try {
    await assert.rejects(
      awsCoreRequest(
        config,
        new URL(config.publicUrl),
        {
          method: "POST",
          body: "{}",
          signal: AbortSignal.timeout(1000),
        },
        32,
      ),
      /size limit/,
    );
    assert.equal(destroyed, true);
  } finally {
    t.mock.restoreAll();
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS layer transport rejects invalid targets and propagates TLS and body failures without fallback", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-layer-failure-"));
  const fake = fakeAws(dir, "console.log('')");
  const priorSecret = process.env.CORE_SIGNING_SECRET;
  const priorAlb = process.env.AWS_FAKE_ALB_DNS;
  process.env.CORE_SIGNING_SECRET = TEST_SECRET_VALUE;
  let calls = 0;
  let failBody = false;
  t.mock.method(
    https,
    "request",
    (_url: URL, _options: https.RequestOptions, callback: (response: unknown) => void) => {
      calls++;
      const request = new EventEmitter() as EventEmitter & { end(): void };
      request.end = () =>
        queueMicrotask(() => {
          if (!failBody) request.emit("error", new Error("certificate verification failed"));
          else {
            const response = Object.assign(new EventEmitter(), { statusCode: 200 });
            callback(response);
            response.emit("data", Buffer.from("partial"));
            response.emit("error", new Error("response aborted"));
          }
        });
      return request;
    },
  );
  const send = (configured = config) =>
    awsDeploymentLayerTransport({ config: configured, configDir: dir, method: "GET", body: "" });
  try {
    process.env.AWS_FAKE_ALB_DNS = "invalid/target";
    await assert.rejects(send, /ALB hostname is invalid/);
    assert.equal(calls, 0);
    await assert.rejects(() => send({ ...config, apiUrl: "http://api.acme.example" }), /must be HTTPS/);
    assert.equal(calls, 0);
    process.env.AWS_FAKE_ALB_DNS = "inactive-stack.elb.example";
    await assert.rejects(send, /certificate verification failed/);
    assert.equal(calls, 1);
    failBody = true;
    await assert.rejects(send, /response aborted/);
    assert.equal(calls, 2);
  } finally {
    t.mock.restoreAll();
    fake.restore();
    if (priorSecret === undefined) delete process.env.CORE_SIGNING_SECRET;
    else process.env.CORE_SIGNING_SECRET = priorSecret;
    if (priorAlb === undefined) delete process.env.AWS_FAKE_ALB_DNS;
    else process.env.AWS_FAKE_ALB_DNS = priorAlb;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS layer deadline aborts a native response body that never finishes", async (t) => {
  const http = await import("node:http");
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => controller.signal);
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    response.write("partial");
    setTimeout(() => controller.abort(), 10);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-layer-abort-"));
  const fake = fakeAws(dir, "console.log('')");
  const priorSecret = process.env.CORE_SIGNING_SECRET;
  process.env.CORE_SIGNING_SECRET = TEST_SECRET_VALUE;
  let calls = 0;
  t.mock.method(
    https,
    "request",
    (_url: URL, options: https.RequestOptions, callback: (response: import("node:http").IncomingMessage) => void) => {
      calls++;
      return http.request({ ...options, hostname: "127.0.0.1", port: address.port }, callback);
    },
  );
  try {
    await assert.rejects(
      () => awsDeploymentLayerTransport({ config, configDir: dir, method: "GET", body: "" }),
      /abort/i,
    );
    assert.equal(calls, 1);
  } finally {
    t.mock.restoreAll();
    fake.restore();
    if (priorSecret === undefined) delete process.env.CORE_SIGNING_SECRET;
    else process.env.CORE_SIGNING_SECRET = priorSecret;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inactive AWS deploys return once prior tasks have exited, without waiting for ECS to complete the rollout", async () => {
  const stopping = /core \(prior tasks are still stopping\)/;
  const scenarios: Array<{
    name: string;
    inactive: boolean;
    rollingTasks: NonNullable<Parameters<typeof statefulAws>[3]>["rollingTasks"];
    rejects?: RegExp;
  }> = [
    { name: "prior tasks exit", inactive: true, rollingTasks: { retiringPolls: 3, targetHealthPolls: 4 } },
    {
      name: "prior task still stopping",
      inactive: true,
      rollingTasks: { retiringPolls: 1e9, retiring: 1 },
      rejects: stopping,
    },
    {
      name: "one new task unhealthy",
      inactive: true,
      rollingTasks: { retiringPolls: 0, health: ["HEALTHY", "UNHEALTHY"] },
      rejects: stopping,
    },
    {
      name: "new targets not yet healthy with no prior tasks",
      inactive: true,
      rollingTasks: { retiringPolls: 0, retiring: 0, targetHealthPolls: 1e9 },
      rejects: stopping,
    },
    {
      name: "task inventory unavailable",
      inactive: true,
      rollingTasks: { retiringPolls: 0, failInventory: true },
      rejects: stopping,
    },
    { name: "active stack", inactive: false, rollingTasks: { retiringPolls: 0 }, rejects: stopping },
  ];
  const priorDeadline = process.env.QM_AWS_ROLLOUT_DEADLINE_MS;
  try {
    for (const scenario of scenarios) {
      process.env.QM_AWS_ROLLOUT_DEADLINE_MS = scenario.rejects ? "800" : "15000";
      const dir = mkdtempSync(join(tmpdir(), "qm-aws-inactive-exit-"));
      const candidatePath = join(dir, "candidate.json");
      writeFileSync(
        candidatePath,
        JSON.stringify({
          contract: 1,
          accountId: "123456789012",
          region: "us-west-2",
          label: "candidate-deadbeef",
          images: { core: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}` },
          imageProvenance: { core: { kind: "source-build", source: "checkout" } },
          architectures: { core: "amd64" },
        }),
      );
      const base = oneServiceConfig();
      const single = {
        ...base,
        aws: { ...base.aws!, services: { core: { ...base.aws!.services.core!, desiredCount: 2 } } },
      };
      const fake = statefulAws(dir, single, {}, { rollingTasks: scenario.rollingTasks });
      const priorAlb = process.env.AWS_FAKE_ALB_DNS;
      if (scenario.inactive) process.env.AWS_FAKE_ALB_DNS = "192.0.2.1";
      try {
        const deploy = awsUp(single, dir, { yes: true, candidate: candidatePath, inactive: scenario.inactive });
        if (scenario.rejects) {
          await assert.rejects(deploy, scenario.rejects, scenario.name);
          continue;
        }
        await deploy;
        const state = JSON.parse(readFileSync(fake.state, "utf8"));
        assert.equal(state.retiringPolls, 0, scenario.name);
        assert.equal(state.targetHealthPolls, 0, scenario.name);
        const service = state.services[single.aws.services.core.ecsService];
        const manifest = JSON.parse(
          state.dynamo[`deployment/manifest/${state.dynamo["deployment/current"].manifestId.S}`].manifest.S,
        );
        assert.equal(manifest.tasks.core, service.taskDefinition, scenario.name);
        assert.notEqual(service.taskDefinition, service.previousTaskDefinition, scenario.name);
        const calls = readFileSync(fake.log, "utf8");
        assert.ok(
          calls.lastIndexOf("dynamodb delete-item") > calls.lastIndexOf("dynamodb transact-write-items"),
          scenario.name,
        );
      } finally {
        if (priorAlb === undefined) delete process.env.AWS_FAKE_ALB_DNS;
        else process.env.AWS_FAKE_ALB_DNS = priorAlb;
        fake.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    if (priorDeadline === undefined) delete process.env.QM_AWS_ROLLOUT_DEADLINE_MS;
    else process.env.QM_AWS_ROLLOUT_DEADLINE_MS = priorDeadline;
  }
});

test("shared deployment state isolates company manifests and leases without mutating candidate images", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-inactive-candidate-"));
  const candidatePath = join(dir, "candidate.json");
  writeFileSync(
    candidatePath,
    JSON.stringify({
      contract: 1,
      accountId: "123456789012",
      region: "us-west-2",
      label: "candidate-deadbeef",
      images: {
        core: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-core@sha256:${"a".repeat(64)}`,
      },
      imageProvenance: { core: { kind: "source-build", source: "checkout" } },
      architectures: { core: "amd64" },
    }),
  );
  const single = oneServiceConfig();
  single.aws!.deploymentState = { table: "fleet-deploy-locks", namespace: "acme" };
  const fake = statefulAws(dir, single);
  const prior = process.env.AWS_FAKE_ALB_DNS;
  process.env.AWS_FAKE_ALB_DNS = "192.0.2.1";
  try {
    await awsUp(single, dir, { yes: true, candidate: candidatePath, inactive: true });
    assert.match(readFileSync(fake.log, "utf8"), /ecs update-service/);
    const first = JSON.parse(readFileSync(fake.state, "utf8"));
    const pointer = first.dynamo["acme/deployment/current"].manifestId.S;
    assert.ok(first.dynamo[`acme/deployment/manifest/${pointer}`]);
    assert.ok(first.dynamo["acme/deployment/label/" + single.aws!.imageLabel]);
    assert.equal(first.dynamo["deployment/current"], undefined);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecr put-image|ecr batch-delete-image/);
    single.aws!.deploymentState.namespace = "second";
    await awsUp(single, dir, { yes: true, candidate: candidatePath, inactive: true });
    const second = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(second.dynamo["acme/deployment/current"].manifestId.S, pointer);
    assert.notEqual(second.dynamo["second/deployment/current"].manifestId.S, pointer);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /"S":"acme\/deploy"/);
    assert.match(calls, /"S":"second\/deploy"/);
  } finally {
    if (prior === undefined) delete process.env.AWS_FAKE_ALB_DNS;
    else process.env.AWS_FAKE_ALB_DNS = prior;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared ALB validates company routes while rejecting sibling overlap", () => {
  const company = { ...config, aws: { ...config.aws!, sharedAlb: true, alb: "shared" } };
  const primary = targetGroupArn(awsTargetGroupName(config, "core-public"));
  const services = new Map([["core", { loadBalancers: frontDoorAttachments({ blueGreen: true }) }]]);
  const hostname = new URL(company.publicUrl).hostname;
  for (const variant of [
    "valid",
    "same-host",
    "wildcard",
    "own-target",
    "wrong-host",
    "apps",
    "apps-missing",
    "apps-wrong",
    "sibling-apps",
  ]) {
    const appDomain = `apps.${hostname}`;
    const selected = variant.startsWith("apps")
      ? {
          ...company,
          env: {
            ...company.env,
            core: { ...company.env.core, DEPLOY_APPS_DOMAIN: appDomain, PORTAL_APPS_DOMAIN: appDomain },
          },
        }
      : company;
    const dir = mkdtempSync(join(tmpdir(), "qm-shared-alb-"));
    const fake = fakeAws(dir, "", {
      blueGreen: true,
      sharedHost: variant === "wrong-host" ? "wrong.example" : hostname,
      ...(variant === "apps" ? { sharedAppsHost: `*.${appDomain}` } : {}),
      ...(variant === "apps-wrong" ? { sharedAppsHost: `*.wrong.${hostname}` } : {}),
      ...(variant === "sibling-apps" ? { siblingAppsHost: "*.apps.other.example" } : {}),
      siblingHost:
        ({ "same-host": hostname, wildcard: "*.example" } as Record<string, string>)[variant] ?? "other.example",
      siblingOwnTarget: variant === "own-target",
    });
    try {
      if (["valid", "apps", "sibling-apps"].includes(variant))
        assert.equal(assertAwsPublicRouting(selected, services).get("core-public"), primary);
      else assert.throws(() => assertAwsPublicRouting(selected, services), /shared ALB/);
      assert.throws(
        () => assertAwsPublicRouting({ ...company, aws: { ...company.aws, sharedAlb: false } }, services),
        /unknown services/,
      );
    } finally {
      fake.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("shared ALB finds the front door's target group through core's targetGroup", () => {
  const company = { ...config, aws: { ...config.aws!, sharedAlb: true, alb: "shared" } };
  const door = { blueGreen: true, frontDoorTargetGroup: "acme-portal-tg" };
  const services = new Map([["core", { loadBalancers: frontDoorAttachments(door) }]]);
  const dir = mkdtempSync(join(tmpdir(), "qm-shared-alb-named-"));
  const fake = fakeAws(dir, "", {
    ...door,
    sharedHost: new URL(company.publicUrl).hostname,
    siblingHost: "other.example",
  });
  try {
    assert.equal(
      assertAwsPublicRouting(
        {
          ...company,
          aws: {
            ...company.aws,
            services: {
              ...company.aws.services,
              core: { ...company.aws.services.core!, targetGroup: "acme-portal-tg" },
            },
          },
        },
        services,
      ).get("core-public"),
      targetGroupArn("acme-portal-tg"),
    );
    assert.throws(() => assertAwsPublicRouting(company, services), /target group for core-public is missing/);
  } finally {
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const shared of [false, true]) {
  test(`AWS doctor checks ${shared ? "shared" : "dedicated"} discovery through ECS registrations`, () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-aws-discovery-"));
    const namespace = shared ? "shared.internal" : "acme.internal";
    const discoveryName = shared ? "acme-core" : "core";
    const arn = "arn:aws:servicediscovery:us-west-2:123456789012:namespace/ns-shared";
    const fake = fakeAws(
      dir,
      `
if (a.includes("list-namespaces")) console.log(JSON.stringify({Namespaces:[{Id:"ns-shared",Name:${JSON.stringify(namespace)},Arn:${JSON.stringify(arn)}}]}));
else if (a.includes("list-services")) console.log(JSON.stringify({Services:[{Name:${JSON.stringify(discoveryName)},Arn:"arn:registration"}]}));
else console.log("");`,
    );
    try {
      const endpoint = {
        portName: "core",
        discoveryName,
        clientAliases: [{ dnsName: "core.acme.internal", port: 8080 }],
      };
      const connect = { enabled: true, namespace: arn, services: [endpoint] };
      const services = new Map([
        ["core", { deployments: [{ status: "PRIMARY", serviceConnectConfiguration: connect }] }],
      ]);
      assert.doesNotThrow(() => assertAwsServiceDiscovery(oneServiceConfig(), services));
      endpoint.clientAliases[0]!.dnsName = "core.other.internal";
      assert.throws(() => assertAwsServiceDiscovery(oneServiceConfig(), services), /client alias/);
      endpoint.clientAliases[0]!.dnsName = "core.acme.internal";
      endpoint.discoveryName = "missing";
      assert.throws(() => assertAwsServiceDiscovery(oneServiceConfig(), services), /is missing from/);
      endpoint.discoveryName = discoveryName;
      connect.namespace = "missing.internal";
      assert.throws(() => assertAwsServiceDiscovery(oneServiceConfig(), services), /missing Cloud Map namespace/);
      assert.match(readFileSync(fake.log, "utf8"), /Values=ns-shared/);
    } finally {
      fake.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const mode of ["success", "migration-failure", "update-failure", "write-failure"] as const) {
  test(`AWS candidate deployment progress receipt: ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-aws-progress-"));
    const progressFile = join(dir, "progress.json");
    const candidatePath = join(dir, "candidate.json");
    const single = mode === "success" ? twoServiceConfig() : oneServiceConfig();
    writeFileSync(
      candidatePath,
      JSON.stringify({
        contract: 1,
        accountId: "123456789012",
        region: "us-west-2",
        label: "candidate-progress",
        images: Object.fromEntries(
          Object.keys(single.aws!.services).map((name) => [
            name,
            `123456789012.dkr.ecr.us-west-2.amazonaws.com/${single.aws!.services[name]!.ecrRepository}@sha256:${"a".repeat(64)}`,
          ]),
        ),
        imageProvenance: Object.fromEntries(
          Object.keys(single.aws!.services).map((name) => [name, { kind: "source-build", source: "checkout" }]),
        ),
        architectures: Object.fromEntries(Object.keys(single.aws!.services).map((name) => [name, "amd64"])),
      }),
    );
    const fake = statefulAws(
      dir,
      single,
      {},
      {
        progressFile,
        migrationExitCode: mode === "migration-failure" ? 1 : 0,
        failFirstUpdateAfterMutation: mode === "update-failure",
        sabotageProgress: mode === "write-failure",
      },
    );
    const priorFile = process.env.QM_DEPLOY_PROGRESS_FILE;
    const priorToken = process.env.QM_DEPLOY_PROGRESS_TOKEN;
    process.env.QM_DEPLOY_PROGRESS_FILE = progressFile;
    process.env.QM_DEPLOY_PROGRESS_TOKEN = "attempt-unique-token";
    try {
      const deploy = () => awsUp(single, dir, { yes: true, candidate: candidatePath });
      if (mode === "migration-failure" || mode === "update-failure") {
        await assert.rejects(deploy);
        assert.equal(existsSync(progressFile), false);
      } else {
        await deploy();
        const samples = readFileSync(progressFile + ".samples", "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const update = samples.findLastIndex((sample) => sample.args.includes("update-service"));
        assert.ok(update >= 0);
        assert.ok(samples.slice(0, update + 1).every((sample) => !sample.published));
        if (mode === "success") {
          assert.equal(samples[update + 1].published, true);
          const state = JSON.parse(readFileSync(fake.state, "utf8"));
          assert.deepEqual(JSON.parse(readFileSync(progressFile, "utf8")), {
            phase: "monitoring",
            token: "attempt-unique-token",
            orgId: single.orgId,
            targets: Object.fromEntries(
              Object.keys(single.aws!.services).map((name) => [name, state.services[`acme-${name}`].taskDefinition]),
            ),
          });
          assert.equal(statSync(progressFile).mode & 0o777, 0o600);
          writeFileSync(fake.log, "");
          await assert.rejects(deploy, /must not already exist/);
          assert.equal(readFileSync(fake.log, "utf8"), "");
          rmSync(progressFile);
          await deploy();
          assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecs update-service/);
          assert.equal(JSON.parse(readFileSync(progressFile, "utf8")).token, "attempt-unique-token");
        } else {
          assert.ok(statSync(progressFile).isDirectory());
        }
      }
    } finally {
      if (priorFile === undefined) delete process.env.QM_DEPLOY_PROGRESS_FILE;
      else process.env.QM_DEPLOY_PROGRESS_FILE = priorFile;
      if (priorToken === undefined) delete process.env.QM_DEPLOY_PROGRESS_TOKEN;
      else process.env.QM_DEPLOY_PROGRESS_TOKEN = priorToken;
      fake.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("AWS deployment progress rejects invalid options before AWS calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-aws-progress-validation-"));
  const fake = fakeAws(dir, "");
  const priorFile = process.env.QM_DEPLOY_PROGRESS_FILE;
  const priorToken = process.env.QM_DEPLOY_PROGRESS_TOKEN;
  try {
    for (const [file, token] of [
      ["relative.json", "attempt"],
      [join(dir, "receipt.json"), ""],
      ["", "attempt"],
    ]) {
      process.env.QM_DEPLOY_PROGRESS_FILE = file;
      process.env.QM_DEPLOY_PROGRESS_TOKEN = token;
      await assert.rejects(
        () => awsUp(oneServiceConfig(), dir, { yes: true, candidate: "candidate.json" }),
        /deployment progress requires/,
      );
    }
    process.env.QM_DEPLOY_PROGRESS_FILE = join(dir, "receipt.json");
    process.env.QM_DEPLOY_PROGRESS_TOKEN = "attempt";
    await assert.rejects(() => awsUp(oneServiceConfig(), dir, { yes: true }), /deployment progress requires/);
    assert.equal(readFileSync(fake.log, "utf8"), "");
  } finally {
    if (priorFile === undefined) delete process.env.QM_DEPLOY_PROGRESS_FILE;
    else process.env.QM_DEPLOY_PROGRESS_FILE = priorFile;
    if (priorToken === undefined) delete process.env.QM_DEPLOY_PROGRESS_TOKEN;
    else process.env.QM_DEPLOY_PROGRESS_TOKEN = priorToken;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("controlled AWS stacks allocate identities, verify the running stack in place, and hand over by task replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-controlled-background-"));
  const dockerBin = join(dir, "docker");
  writeFileSync(dockerBin, `#!/usr/bin/env node\nconsole.log("Digest: sha256:${"a".repeat(64)}");\n`);
  chmodSync(dockerBin, 0o755);
  const base = oneServiceConfig();
  const single: QmConfig = {
    ...base,
    env: { ...base.env, core: { ...base.env.core, BACKGROUND_WORK_ENABLED: "1" } },
    aws: { ...base.aws!, backgroundWorkControl: true },
  };
  const fake = statefulAws(dir, single);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dir}:${priorPath}`;
  const current = () => {
    const persisted = JSON.parse(readFileSync(fake.state, "utf8"));
    return JSON.parse(
      persisted.dynamo[`deployment/manifest/${persisted.dynamo["deployment/current"].manifestId.S}`].manifest.S,
    );
  };
  const fetchLayer = globalThis.fetch;
  try {
    await awsUp(single, dir, { yes: true });
    const manifest = current();
    assert.match(manifest.backgroundDeploymentId, /^acme-core:[0-9a-f-]{36}$/);
    let smokeCalls = 0;
    let smokeFailure = false;
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes("/v1/deployment/live-session")) return fetchLayer(url, init);
      smokeCalls++;
      const body = String(init?.body ?? "");
      const request = JSON.parse(body);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer separate-control-secret-value-0000000000");
      assert.equal(
        headers.get("x-signature"),
        `v0=${createHmac("sha256", TEST_SECRET_VALUE)
          .update(`v0:${headers.get("x-timestamp")}:POST\n/v1/deployment/live-session\n${body}`)
          .digest("hex")}`,
      );
      assert.deepEqual(request, {
        requestId: request.requestId,
        expectedDeploymentId: current().backgroundDeploymentId,
      });
      assert.ok(init?.signal instanceof AbortSignal);
      if (smokeFailure) throw new Error("disconnected with a sensitive credential");
      return new Response(
        ` \n\n${JSON.stringify({ ok: true, requestId: request.requestId, deploymentId: request.expectedDeploymentId })}\n`,
      );
    };
    writeFileSync(fake.log, "");
    await awsCheckLive(single, { configDir: dir, report: false });
    assert.equal(smokeCalls, 1);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecs run-task/);
    smokeFailure = true;
    await assert.rejects(awsCheckLive(single, { configDir: dir, report: false }), /unconfirmed/);
    assert.equal(smokeCalls, 2);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /ecs run-task/);
    smokeFailure = false;

    await awsUp(single, dir, { yes: true, restart: ["core"] });
    const replacement = current();
    assert.notEqual(replacement.backgroundDeploymentId, manifest.backgroundDeploymentId);
    assert.notEqual(replacement.tasks.core, manifest.tasks.core);
    const controlEnv = join(dir, "control.env");
    writeFileSync(
      controlEnv,
      computedSecrets(single)
        .filter((secret) => secret.managedBy !== "terraform")
        .map(
          (secret) =>
            `${secret.name}=${secret.name === "DEPLOYMENT_CONTROL_SECRET" ? "new-control-secret".repeat(3) : TEST_SECRET_VALUE}`,
        )
        .join("\n"),
    );
    writeFileSync(fake.log, "");
    await assert.rejects(awsSecretsPush(single, dir, controlEnv), /cannot be rotated/);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /put-secret-value|ecs update-service/);
    await awsRollback(single, manifest.id);
    const rolledBack = JSON.parse(readFileSync(fake.state, "utf8"));
    assert.equal(rolledBack.dynamo["deployment/current"].manifestId.S, manifest.id);
    assert.equal(rolledBack.services["acme-core"].taskDefinition, manifest.tasks.core);

    await awsSetBackgroundWork(single, dir, false);
    const demoted = current();
    assert.equal(demoted.backgroundDeploymentId, manifest.backgroundDeploymentId);
    assert.notEqual(demoted.tasks.core, manifest.tasks.core);
    const demotedCore = JSON.parse(readFileSync(fake.state, "utf8")).definitions[
      demoted.tasks.core
    ].containerDefinitions.find((container: { name: string }) => container.name === "core");
    assert.equal(
      demotedCore.environment.find((entry: { name: string }) => entry.name === "BACKGROUND_WORK_ENABLED").value,
      "0",
    );

    await awsSetBackgroundWork(single, dir, true);
    const reactivated = current();
    assert.match(reactivated.backgroundDeploymentId, /^acme-core:[0-9a-f-]{36}$/);
    assert.notEqual(
      reactivated.backgroundDeploymentId,
      manifest.backgroundDeploymentId,
      "turning background work back on starts a deployment newer than any other",
    );
    const reactivatedCore = JSON.parse(readFileSync(fake.state, "utf8")).definitions[
      reactivated.tasks.core
    ].containerDefinitions.find((container: { name: string }) => container.name === "core");
    assert.equal(
      reactivatedCore.environment.find((entry: { name: string }) => entry.name === "BACKGROUND_DEPLOYMENT_ID").value,
      reactivated.backgroundDeploymentId,
    );

    const inactive: QmConfig = {
      ...single,
      env: { ...single.env, core: { ...single.env.core, BACKGROUND_WORK_ENABLED: "0" } },
    };
    await awsUp(inactive, dir, { yes: true });
    writeFileSync(fake.log, "");
    await awsCheckLive(inactive, { configDir: dir, report: false });
    assert.equal(smokeCalls, 2);
    assert.match(readFileSync(fake.log, "utf8"), /ecs run-task/);
  } finally {
    globalThis.fetch = fetchLayer;
    process.env.PATH = priorPath;
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
