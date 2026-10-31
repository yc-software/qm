import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTaskDefinition } from "../src/backends/aws.ts";
import type { QmConfig } from "../src/config.ts";
import { renderTerraformVars } from "../src/terraform.ts";

const service = (name: string) => ({ ecrRepository: `qm-${name}`, ecsService: `acme-${name}`, cpu: 512, memory: 1024 });

const config: QmConfig = {
  contract: 1,
  orgId: "acme",
  publicUrl: "https://agent.acme.example",
  apiUrl: "https://api.acme.example",
  target: "aws",
  services: ["core", "egress-proxy"],
  plugins: [],
  skills: [],
  imageOverrides: {},
  env: { core: { AWS_DEPLOY_IMAGE: "acme-qm-sandbox" } },
  aws: {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme-qm",
    deployRoleArn: "arn:aws:iam::123456789012:role/acme-deploy",
    imageLabel: "release",
    secretsPrefix: "acme/qm/",
    networking: { cloudMapNamespace: "acme.internal" },
    services: { core: service("core"), "egress-proxy": service("egress-proxy") },
  },
};

const image = `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm-egress-proxy@sha256:${"a".repeat(64)}`;
const proxyContainer = (deployment = config) =>
  renderTaskDefinition(deployment, "egress-proxy", image).containerDefinitions[0]!;
const coreApiUrl = (deployment: QmConfig) =>
  (proxyContainer(deployment).environment as Array<{ name: string; value: string }>).find(
    (entry) => entry.name === "CORE_API_URL",
  )?.value;

test("AWS runs the egress proxy as plain TCP with the keys it verifies and relays with", () => {
  const container = proxyContainer();
  assert.deepEqual(container.portMappings, [
    { name: "egress-proxy", containerPort: 48080, hostPort: 48080, protocol: "tcp" },
  ]);
  assert.deepEqual(
    (container.secrets as Array<{ name: string }>).map((secret) => secret.name),
    ["CAPABILITY_SECRET", "CORE_SIGNING_SECRET"],
  );
  assert.equal(coreApiUrl(config), "https://api.acme.example");
  const { apiUrl: _apiUrl, ...withoutApiUrl } = config;
  assert.equal(coreApiUrl(withoutApiUrl), "https://agent.acme.example");
});

const adminSocket = "/tmp/envoy-admin.sock";

function listen(server: Server, ...args: unknown[]): Promise<void> {
  return new Promise((resolve) => (server.listen as (...a: unknown[]) => void)(...args, resolve));
}

test(
  "the AWS proxy health check passes only while the decision service listens and Envoy reports ready",
  { skip: existsSync(adminSocket) ? `${adminSocket} is in use` : false },
  async () => {
    const [, ...command] = (proxyContainer().healthCheck as { command: string[] }).command;
    const probe = () =>
      new Promise<number | null>((resolve) =>
        spawn(command[0]!, command.slice(1), { timeout: 10_000 }).on("exit", resolve),
      );
    assert.notEqual(await probe(), 0);
    let ready = 200;
    const authz = createTcpServer((socket) => socket.end());
    const envoy = createHttpServer((_req, res) => res.writeHead(ready).end());
    await listen(authz, 48081, "127.0.0.1");
    try {
      assert.notEqual(await probe(), 0);
      await listen(envoy, adminSocket);
      assert.equal(await probe(), 0);
      ready = 503;
      assert.notEqual(await probe(), 0);
    } finally {
      authz.close();
      envoy.close();
    }
  },
);

test("a vendored AWS scaffold without the proxy load balancer refuses the egress proxy", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-legacy-egress-"));
  try {
    const infra = join(dir, "infra");
    mkdirSync(infra);
    writeFileSync(join(infra, "terraform.tfvars"), "services = {}\n");
    writeFileSync(join(infra, "variables.tf"), 'variable "services" { type = map(any) }\n');
    writeFileSync(join(infra, "main.tf"), 'resource "aws_lb" "this" {}\n');
    assert.throws(() => renderTerraformVars(config, dir), /AWS scaffold predates the egress-proxy service/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
