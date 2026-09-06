import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAwsPublicRouting } from "../src/backends/aws.ts";
import { loadConfigAt } from "../src/config.ts";
import { terraformVars } from "../src/terraform.ts";

function fixture(paths: unknown = ["/hooks/*"], blueGreen = false, priority = "2") {
  const dir = mkdtempSync(join(tmpdir(), "qm-public-paths-"));
  const configPath = join(dir, "qm.config.jsonc");
  const service = (name: string) => ({
    ecrRepository: name,
    ecsService: name,
    cpu: 256,
    memory: 512,
    architecture: "arm64",
    targetGroup: name,
  });
  writeFileSync(
    configPath,
    JSON.stringify({
      contract: 1,
      orgId: "acme",
      target: "aws",
      publicUrl: "https://acme.example",
      apiUrl: "https://api.acme.example",
      services: ["core", "portal", "web-ui"],
      env: { core: { AWS_DEPLOY_IMAGE: "acme-sandbox" } },
      plugins: [{ name: "hooks", image: "ghcr.io/acme/hooks:1" }],
      aws: {
        accountId: "123456789012",
        region: "us-west-2",
        cluster: "acme",
        deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
        secretsPrefix: "acme/",
        imageLabel: "latest",
        networking: { cloudMapNamespace: "acme.internal" },
        services: {
          "web-ui": service("web-ui"),
          core: service("core"),
          portal: service("portal"),
          hooks: { ...service("hooks"), publicPaths: paths },
        },
      },
    }),
  );
  const names = ["core", "portal", "hooks"];
  const groups = names.flatMap((name) => [
    { TargetGroupArn: name, TargetGroupName: name },
    ...(blueGreen ? [{ TargetGroupArn: `${name}-alternate`, TargetGroupName: `${name}-alternate` }] : []),
  ]);
  const rules = names
    .filter((name) => blueGreen || name !== "portal")
    .map((name) => ({
      RuleArn: `${name}-rule`,
      IsDefault: false,
      Priority: { hooks: priority, core: "11", portal: "13" }[name],
      Actions: [
        blueGreen
          ? {
              Type: "forward",
              ForwardConfig: {
                TargetGroups: [
                  { TargetGroupArn: name, Weight: 1 },
                  { TargetGroupArn: `${name}-alternate`, Weight: 0 },
                ],
              },
            }
          : { Type: "forward", TargetGroupArn: name },
      ],
      Conditions: [
        name === "core"
          ? { Field: "host-header", HostHeaderConfig: { Values: ["api.acme.example"] } }
          : { Field: "path-pattern", PathPatternConfig: { Values: name === "portal" ? ["/*"] : ["/hooks/*"] } },
      ],
    }));
  const responses = {
    "describe-load-balancers": {
      LoadBalancers: [{ LoadBalancerArn: "alb", DNSName: "acme.example", State: { Code: "active" } }],
    },
    "describe-listeners": {
      Listeners: [
        {
          ListenerArn: "listener",
          Port: 443,
          Protocol: "HTTPS",
          Certificates: [{ CertificateArn: "cert" }],
          DefaultActions: [
            blueGreen
              ? { Type: "fixed-response", FixedResponseConfig: { StatusCode: "404" } }
              : { Type: "forward", TargetGroupArn: "portal" },
          ],
        },
      ],
    },
    "describe-target-groups": { TargetGroups: groups },
    "describe-rules": { Rules: rules },
  };
  const bin = join(dir, "aws");
  writeFileSync(
    bin,
    `#!${process.execPath}\nconst responses=${JSON.stringify(responses)};for(const arg of process.argv){if(responses[arg]){console.log(JSON.stringify(responses[arg]));process.exit(0)}}process.exit(1);`,
    { mode: 0o755 },
  );
  const prior = process.env.AWS_BIN;
  process.env.AWS_BIN = bin;
  const services = new Map(
    names.map((name) => [
      name,
      {
        loadBalancers: [
          {
            targetGroupArn: name,
            ...(blueGreen
              ? {
                  advancedConfiguration: {
                    alternateTargetGroupArn: `${name}-alternate`,
                    productionListenerRule: `${name}-rule`,
                  },
                }
              : {}),
          },
        ],
      },
    ]),
  );
  return {
    configPath,
    services,
    close() {
      if (prior === undefined) delete process.env.AWS_BIN;
      else process.env.AWS_BIN = prior;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const blueGreen of [false, true]) {
  test(`declared public plugin paths qualify ${blueGreen ? "blue/green" : "rolling"} ingress`, () => {
    const f = fixture(undefined, blueGreen);
    try {
      const config = loadConfigAt(f.configPath).config;
      assert.equal(assertAwsPublicRouting(config, f.services).get("hooks"), "hooks");
      assert.match(terraformVars(config, "", ["core_public_hosts"]), /"public_paths": \[\s*"\/hooks\/\*"/);
    } finally {
      f.close();
    }
  });
  test(`public plugin cannot sit behind core or portal ${blueGreen ? "blue/green" : "rolling"} routes`, () => {
    const f = fixture(undefined, blueGreen, "15");
    try {
      assert.throws(() => assertAwsPublicRouting(loadConfigAt(f.configPath).config, f.services), /must precede/);
    } finally {
      f.close();
    }
  });
}

test("public plugin live routing cannot broaden declared paths", () => {
  const f = fixture(["/hooks/events/*"]);
  try {
    assert.throws(() => assertAwsPublicRouting(loadConfigAt(f.configPath).config, f.services), /exactly its declared/);
  } finally {
    f.close();
  }
});

for (const paths of [[], ["/*"], ["/v1/*"], ["/hooks/../*"], ["/hooks/?"], ["/hooks/*", "/hooks/*"]]) {
  test(`reject unsafe public plugin paths ${JSON.stringify(paths)}`, () => {
    const f = fixture(paths);
    try {
      assert.throws(() => loadConfigAt(f.configPath), /publicPaths/);
    } finally {
      f.close();
    }
  });
}

for (const name of ["v1", "d", "key", "models", "slack"]) {
  test(`a plugin cannot claim the core ${name} namespace`, () => {
    const f = fixture();
    try {
      const raw = JSON.parse(readFileSync(f.configPath, "utf8"));
      raw.plugins[0].name = name;
      raw.aws.services[name] = { ...raw.aws.services.hooks, publicPaths: [`/${name}/*`] };
      delete raw.aws.services.hooks;
      writeFileSync(f.configPath, JSON.stringify(raw));
      assert.throws(() => loadConfigAt(f.configPath), /publicPaths|collides|built-in/);
    } finally {
      f.close();
    }
  });
}
