import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { test } from "node:test";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

test("the package uses the organization scope while keeping the qm command", () => {
  const packageManifest = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as {
    name?: string;
    bin?: Record<string, string>;
  };
  assert.equal(packageManifest.name, "@yc-software/qm");
  assert.equal(packageManifest.bin?.qm, "dist/bin/qm.js");
});

test(
  "the packed npm artifact creates and operates a standalone deployment repository",
  { timeout: 60_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "qm-package-"));
    let registry: Server | undefined;
    try {
      const env = { ...process.env, NPM_CONFIG_CACHE: join(dir, "npm-cache") };
      const packed = JSON.parse(
        execFileSync("npm", ["pack", "--json", "--pack-destination", dir], { cwd: cliDir, encoding: "utf8", env }),
      ) as Array<{ filename: string; files: Array<{ path: string }> }>;
      const deployment = join(dir, "deployment");
      const awsDeployment = join(dir, "aws-deployment");
      const packageManifest = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as Record<string, unknown>;
      const version = packageManifest["version"] as string;
      const published = new Map([
        ["@yc-software/qm", { manifest: packageManifest, bytes: readFileSync(join(dir, packed[0]!.filename)) }],
      ]);
      for (const name of Object.keys(packageManifest["dependencies"] as Record<string, string>)) {
        const source = join(cliDir, "node_modules", name);
        const [dependency] = JSON.parse(
          execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], {
            cwd: source,
            encoding: "utf8",
            env,
          }),
        ) as Array<{ filename: string }>;
        published.set(name, {
          manifest: JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as Record<string, unknown>,
          bytes: readFileSync(join(dir, dependency!.filename)),
        });
      }
      registry = createServer((request, response) => {
        const origin = `http://${request.headers.host}`;
        const path = decodeURIComponent(request.url ?? "").slice(1);
        const metadata = published.get(path);
        if (metadata) {
          const release = metadata.manifest["version"] as string;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              name: path,
              "dist-tags": { latest: release },
              versions: {
                [release]: {
                  ...metadata.manifest,
                  dist: {
                    tarball: `${origin}/${path}/-/package-${release}.tgz`,
                    shasum: createHash("sha1").update(metadata.bytes).digest("hex"),
                    integrity: `sha512-${createHash("sha512").update(metadata.bytes).digest("base64")}`,
                  },
                },
              },
            }),
          );
          return;
        }
        const tarball = /^(.+)\/-\/package-[^/]+\.tgz$/.exec(path);
        const archive = tarball && published.get(tarball[1]!);
        if (archive) {
          response.setHeader("content-type", "application/octet-stream");
          response.end(archive.bytes);
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      await new Promise<void>((resolve, reject) => registry!.once("error", reject).listen(0, "127.0.0.1", resolve));
      const registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`;
      const consumers = [
        { dir: deployment, org: "acme", target: "docker" },
        { dir: awsDeployment, org: "acme-aws", target: "aws" },
      ] as const;
      for (const consumer of consumers) {
        mkdirSync(consumer.dir, { recursive: true });
        writeFileSync(join(consumer.dir, ".gitignore"), ".DS_Store\n");
        await execFileAsync(
          "npm",
          [
            "exec",
            "--yes",
            `--package=@yc-software/qm@${version}`,
            "--",
            "qm",
            "init",
            ".",
            "--org",
            consumer.org,
            "--target",
            consumer.target,
          ],
          {
            cwd: consumer.dir,
            env: { ...env, NPM_CONFIG_REGISTRY: registryUrl },
          },
        );
        await execFileAsync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
          cwd: consumer.dir,
          env: { ...env, NPM_CONFIG_REGISTRY: registryUrl },
        });
        assert.ok(existsSync(join(consumer.dir, "package-lock.json")));
        await execFileAsync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
          cwd: consumer.dir,
          env: { ...env, NPM_CONFIG_REGISTRY: registryUrl },
        });
        const installed = join(consumer.dir, "node_modules", "@yc-software", "qm");
        assert.equal(lstatSync(installed).isSymbolicLink(), false);
        assert.ok(realpathSync(installed).startsWith(`${realpathSync(consumer.dir)}/`));
        const imageManifest = JSON.parse(readFileSync(join(installed, "manifest.json"), "utf8")) as {
          sandboxBase: string;
          services: Record<string, string>;
        };
        for (const reference of [imageManifest.sandboxBase, ...Object.values(imageManifest.services)]) {
          assert.match(reference, /@sha256:[a-f0-9]{64}$/, "every package-selected runtime image is immutable");
        }
        const consumerPackage = JSON.parse(readFileSync(join(consumer.dir, "package.json"), "utf8")) as {
          private?: boolean;
          scripts?: Record<string, string>;
          dependencies?: Record<string, string>;
        };
        assert.equal(consumerPackage.private, true);
        assert.equal(consumerPackage.scripts?.deploy, "qm up");
        assert.equal(consumerPackage.dependencies?.["@yc-software/qm"], version);
      }
      await new Promise<void>((resolve, reject) => registry!.close((error) => (error ? reject(error) : resolve())));
      registry = undefined;
      const bin = join(deployment, "node_modules", ".bin", "qm");
      const awsBin = join(awsDeployment, "node_modules", ".bin", "qm");
      rmSync(join(dir, packed[0]!.filename));

      assert.ok(existsSync(join(deployment, "deployment.md")));
      assert.ok(existsSync(join(deployment, ".codex", "skills", "deploy-qm", "SKILL.md")));
      for (const provider of ["aws", "slack"]) {
        assert.ok(existsSync(join(deployment, ".codex", "skills", "deploy-qm", "references", `${provider}.md`)));
      }
      assert.equal(statSync(join(deployment, ".env")).mode & 0o777, 0o600);
      assert.doesNotMatch(
        readFileSync(join(deployment, "deployment.md"), "utf8"),
        /QM_REPO|cli\/bin\/qm\.ts|fresh QM clone|source checkout/i,
      );
      assert.match(
        readFileSync(join(deployment, "deployment.md"), "utf8"),
        /"OIDC_JWKS_URI": "https:\/\/www\.googleapis\.com\/oauth2\/v3\/certs"/,
      );
      for (const rule of [".env", "node_modules/", ".generated/"]) {
        assert.ok(readFileSync(join(deployment, ".gitignore"), "utf8").split(/\r?\n/).includes(rule));
      }
      for (const rule of ["infra/.terraform/", "infra/*.tfstate", "infra/*.tfstate.*", "infra/*.tfplan"]) {
        assert.ok(readFileSync(join(awsDeployment, ".gitignore"), "utf8").split(/\r?\n/).includes(rule));
      }

      assert.match(execFileSync(bin, ["version"], { encoding: "utf8" }), /^\d+\.\d+\.\d+/);
      assert.match(execFileSync(bin, ["check"], { cwd: deployment, encoding: "utf8", env }), /check passed/);
      const dockerPlan = execFileSync(bin, ["plan", "--target", "docker"], {
        cwd: deployment,
        encoding: "utf8",
        env,
      });
      assert.match(dockerPlan, /Plan only/);
      assert.doesNotMatch(dockerPlan, /\bPI_(?:MODEL|DETECT_MODEL)\b/);
      assert.match(
        execFileSync(bin, ["sandbox", "build", "--dry-run"], { cwd: deployment, encoding: "utf8", env }),
        /qm-sandbox-base@sha256:a{64}/,
      );
      execFileSync(bin, ["slack", "render"], { cwd: deployment, stdio: "pipe", env });
      execFileSync(bin, ["conformance", "--static"], { cwd: deployment, stdio: "pipe", env });
      assert.match(execFileSync(awsBin, ["check"], { cwd: awsDeployment, encoding: "utf8", env }), /check passed/);
      execFileSync(awsBin, ["infra", "render"], { cwd: awsDeployment, stdio: "pipe", env });
      const outputs = JSON.parse(
        execFileSync(awsBin, ["outputs", "--json"], { cwd: awsDeployment, encoding: "utf8", env }),
      ) as {
        webUiUrl?: string;
        adminOnboardingUrl?: string;
      };
      assert.equal(outputs.webUiUrl, "https://acme-aws.example.com");
      assert.equal(outputs.adminOnboardingUrl, "https://acme-aws.example.com/admin/onboarding");
      const awsConfigPath = join(awsDeployment, "qm.config.jsonc");
      writeFileSync(
        awsConfigPath,
        readFileSync(awsConfigPath, "utf8").replace(
          /"AWS_DEPLOY_IMAGE": ([^,]+),/,
          '"AWS_DEPLOY_IMAGE": $1, "AWS_DEPLOY_IMAGE_VERSION": "1",',
        ),
      );
      const cluster = "acme-aws-qm";
      const portalTarget = `arn:aws:elasticloadbalancing:us-west-2:000000000000:targetgroup/${cluster}-port-${createHash("sha1").update(`${cluster}:portal`).digest("hex").slice(0, 6)}/1`;
      const fakeAws = join(dir, "aws");
      writeFileSync(
        fakeAws,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args.slice(0, 2).join(" ");
const option = (name) => args[args.indexOf(name) + 1];
const json = (value) => process.stdout.write(JSON.stringify(value));
if (command === "sts get-caller-identity") process.stdout.write("000000000000\\n");
else if (command === "elbv2 describe-load-balancers") json({ LoadBalancers: [{ LoadBalancerArn: "arn:alb", DNSName: "replace-with-alb-hostname", State: { Code: "active" } }] });
else if (command === "elbv2 describe-listeners") json({ Listeners: [{ ListenerArn: "arn:listener", Protocol: "HTTP", Port: 80, DefaultActions: [{ Type: "forward", TargetGroupArn: ${JSON.stringify(portalTarget)} }] }] });
else if (command === "elbv2 describe-target-groups") json({ TargetGroups: [{ TargetGroupArn: ${JSON.stringify(portalTarget)}, TargetGroupName: ${JSON.stringify(portalTarget.split("/")[1])} }] });
else if (command === "elbv2 describe-rules") json({ Rules: [] });
else if (command === "ecs describe-services") {
  const start = args.indexOf("--services") + 1;
  const end = args.indexOf("--region");
  json({ services: args.slice(start, end).map((serviceName) => ({
    serviceName,
    status: "ACTIVE",
    desiredCount: 0,
    taskDefinition: "arn:task/" + serviceName + ":1",
    loadBalancers: serviceName.endsWith("-portal") ? [{ targetGroupArn: ${JSON.stringify(portalTarget)} }] : [],
    tags: [{ key: "Deployment", value: "acme-aws" }, { key: "ManagedBy", value: "terraform" }],
  })) });
} else if (command === "ecs describe-task-definition") json({ taskDefinition: { family: "legacy", containerDefinitions: [] } });
else if (command === "lambda-microvms get-microvm-image") json({ imageArn: "arn:aws:lambda:us-west-2:000000000000:microvm-image:acme-aws-qm-sandbox" });
else if (command === "lambda-microvms list-microvm-image-versions") json({ items: [{ imageVersion: "1", state: "SUCCESSFUL", status: "ACTIVE" }] });
else if (command === "secretsmanager get-secret-value") {
  const name = option("--secret-id").split("/").at(-1);
  const value = name === "ADMIN_GRANTS" ? "admin@example.com:org_admin"
    : name === "PUBLIC_API_URL" ? "https://acme-aws.example.com"
    : name.endsWith("SIGNING_SECRET") || name === "CONNECTOR_SECRET_KEY" ? "a".repeat(64)
    : "fixture-" + name.toLowerCase();
  if (args.includes("--query")) process.stdout.write(value + "\\n");
  else json({ ARN: "arn:secret/" + name, SecretString: value });
} else json({});
`,
      );
      chmodSync(fakeAws, 0o755);
      const awsPlan = execFileSync(awsBin, ["plan"], {
        cwd: awsDeployment,
        encoding: "utf8",
        env: { ...env, AWS_BIN: fakeAws },
      });
      assert.match(awsPlan, /Plan only/);
      assert.match(awsPlan, /000000000000\.dkr\.ecr\.us-west-2\.amazonaws\.com\/acme-aws-qm-core@sha256:a{64}/);
      assert.doesNotMatch(awsPlan, /\bPI_(?:MODEL|DETECT_MODEL)\b/);
      execFileSync(awsBin, ["conformance", "--static"], { cwd: awsDeployment, stdio: "pipe", env });

      const imported = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          'import("@yc-software/qm/contract").then((m) => process.stdout.write(String(m.contractVersion)))',
        ],
        { cwd: deployment, encoding: "utf8" },
      );
      assert.equal(imported, "1");
      assert.ok(packed[0]!.files.some(({ path }) => path === "LICENSE"));
      assert.ok(packed[0]!.files.some(({ path }) => path === "templates/aws/microvm-agent/Dockerfile"));
      assert.ok(packed[0]!.files.some(({ path }) => path === "templates/aws/microvm-agent/agent.mjs"));
      assert.ok(packed[0]!.files.some(({ path }) => path === "templates/deployment/deployment.md"));
      assert.ok(packed[0]!.files.some(({ path }) => path === "templates/deployment/references/porter.md"));
      assert.ok(!packed[0]!.files.some(({ path }) => path.startsWith("templates/fly/")));
      assert.ok(!packed[0]!.files.some(({ path }) => path === "src/contract.ts" || path === "bin/qm.ts"));
    } finally {
      if (registry) await new Promise<void>((resolve) => registry!.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
