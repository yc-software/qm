import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILENAME,
  loadConfigAt,
  loadConfigInDir,
  mockHarnessWarning,
  sandboxCoreEnv,
  sandboxImagePinErrors,
  sandboxPinPending,
  updateConfigImageOverrides,
  updateConfigSandbox,
} from "../src/config.ts";

const BASE = { contract: 1, orgId: "acme", publicUrl: "http://localhost:8080", target: "docker", services: ["core"] };

function writeConfig(extra: Record<string, unknown>): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "qm-cfg-"));
  const path = join(dir, CONFIG_FILENAME);
  const env =
    extra.target === "aws"
      ? {
          ...(extra.env as Record<string, unknown> | undefined),
          core: {
            AWS_DEPLOY_IMAGE: "acme-sandbox",
            ...(extra.env as { core?: Record<string, unknown> } | undefined)?.core,
          },
        }
      : extra.env;
  writeFileSync(path, JSON.stringify({ ...BASE, ...extra, ...(env === undefined ? {} : { env }) }));
  return { dir, path };
}

function withConfig(extra: Record<string, unknown>, fn: (r: { dir: string; path: string }) => void): void {
  const r = writeConfig(extra);
  try {
    fn(r);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
}

test("required fields: orgId, target, services (must include core), valid service names", () => {
  withConfig({ orgId: "" }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /"orgId" must be a lowercase DNS label/),
  );
  for (const orgId of ["../other", "ACME", "a/b", "-acme", "acme-"]) {
    withConfig({ orgId }, ({ path }) =>
      assert.throws(() => loadConfigAt(path), /"orgId" must be a lowercase DNS label/),
    );
  }
  withConfig({ target: "k8s" }, ({ path }) => assert.throws(() => loadConfigAt(path), /"target" must be/));
  withConfig({ services: undefined }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /"services" must be an array/),
  );
  withConfig({ services: ["web-ui"] }, ({ path }) => assert.throws(() => loadConfigAt(path), /must include "core"/));
  withConfig({ services: ["core", "nope"] }, ({ path }) => assert.throws(() => loadConfigAt(path), /unknown service/));
  withConfig({ services: ["core", "web-ui", "admin", "portal"] }, ({ path }) => {
    const { config } = loadConfigAt(path);
    assert.deepEqual(config.services, ["core", "web-ui", "admin", "portal"]);
  });
});

test("apiUrl must be an http(s) origin URL; the trailing slash is stripped", () => {
  withConfig({ apiUrl: "https://api.acme.example/" }, ({ path }) =>
    assert.equal(loadConfigAt(path).config.apiUrl, "https://api.acme.example"),
  );
  withConfig({}, ({ path }) => assert.equal(loadConfigAt(path).config.apiUrl, undefined));
  for (const apiUrl of [
    "",
    "not a url",
    "ftp://api.acme.example",
    "https://api.acme.example/v1",
    "https://api.acme.example?x=1",
    "https://user:pw@api.acme.example",
    "https://api.acme.example.",
  ]) {
    withConfig({ apiUrl }, ({ path }) =>
      assert.throws(() => loadConfigAt(path), /"apiUrl" must be a non-empty http\(s\) origin URL/),
    );
  }
});

test("basePort must be a positive integer", () => {
  withConfig({ basePort: 9000 }, ({ path }) => assert.equal(loadConfigAt(path).config.basePort, 9000));
  withConfig({ basePort: -1 }, ({ path }) => assert.throws(() => loadConfigAt(path), /basePort/));
  withConfig({ basePort: 1.5 }, ({ path }) => assert.throws(() => loadConfigAt(path), /basePort/));
});

test("plugins: image is OPTIONAL (source plugins); env attaches to either; bad image rejected", () => {
  withConfig({ plugins: [{ name: "intercom", env: { INTERCOM_REGION: "us" } }] }, ({ path }) => {
    const { config } = loadConfigAt(path);
    const p0 = config.plugins[0]!;
    assert.equal(p0.name, "intercom");
    assert.equal(p0.image, undefined);
    assert.deepEqual(p0.env, { INTERCOM_REGION: "us" });
  });
  withConfig({ plugins: [{ name: "linear", image: "ghcr.io/acme/linear:1" }] }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.plugins[0]!.image, "ghcr.io/acme/linear:1");
  });
  withConfig({ plugins: [{ name: "x", image: "" }] }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /image must be a non-empty string/),
  );
  withConfig({ plugins: [{ name: "core" }] }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /collides with a built-in/),
  );
  withConfig({ plugins: [{ name: "a" }, { name: "a" }] }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /duplicate plugin name/),
  );
});

test("env (per-service) and imageOverrides validate by service name", () => {
  withConfig({ env: { core: { PUBLIC_WEB_URL: "http://x" } }, imageOverrides: { core: "ghcr.io/x:1" } }, ({ path }) => {
    const { config } = loadConfigAt(path);
    assert.deepEqual(config.env.core, { PUBLIC_WEB_URL: "http://x" });
    assert.equal(config.imageOverrides.core, "ghcr.io/x:1");
  });
  withConfig({ env: { nope: {} } }, ({ path }) => assert.throws(() => loadConfigAt(path), /unknown service/));
  withConfig({ env: { core: { S3_PREFIX: "core/" } } }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.env.core?.S3_PREFIX, "core/");
  });
});

test("listen ports are managed consistently across deployment targets", () => {
  withConfig({ env: { core: { PORT: "9000" } } }, ({ path }) => {
    assert.throws(() => loadConfigAt(path), /env\.core\.PORT.*managed/);
  });
  withConfig({ plugins: [{ name: "linear", env: { PORT: "9000" } }] }, ({ path }) => {
    assert.throws(() => loadConfigAt(path), /plugins\[0\]\.env\.PORT.*managed/);
  });
});

test("portal-mounted admin uses the portal's fixed /admin route", () => {
  withConfig({ services: ["core", "admin", "portal"], env: { admin: { ADMIN_BASE_PATH: "/ops" } } }, ({ path }) => {
    assert.throws(() => loadConfigAt(path), /env\.admin\.ADMIN_BASE_PATH.*must be "\/admin"/);
  });
  withConfig(
    { services: ["core", "admin", "portal"], secretEnv: { admin: { ADMIN_BASE_PATH: "ADMIN_PATH_SECRET" } } },
    ({ path }) => {
      assert.throws(() => loadConfigAt(path), /secretEnv\.admin\.ADMIN_BASE_PATH.*managed/);
    },
  );
  withConfig({ services: ["core", "admin", "portal"], env: { admin: { ADMIN_BASE_PATH: "/admin" } } }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.env.admin?.ADMIN_BASE_PATH, "/admin");
  });
});

test("model, skills, and the fly keys parse onto the config", () => {
  withConfig({ model: "claude-opus-4-8", skills: ["./skills/support"] }, ({ path }) => {
    const { config } = loadConfigAt(path);
    assert.equal(config.model, "claude-opus-4-8");
    assert.deepEqual(config.skills, ["./skills/support"]);
  });
  withConfig(
    { target: "fly", appPrefix: "qm", region: "sjc", flyOrg: "personal", imageFrom: "qm", deployAppPrefix: "qm-d" },
    ({ path }) => {
      const { config } = loadConfigAt(path);
      assert.equal(config.appPrefix, "qm");
      assert.equal(config.region, "sjc");
      assert.equal(config.flyOrg, "personal");
      assert.equal(config.imageFrom, "qm");
      assert.equal(config.deployAppPrefix, "qm-d");
    },
  );
});

test("custom portal issuers require an HTTPS JWKS URI on Fly", () => {
  withConfig(
    {
      target: "fly",
      services: ["core", "portal"],
      env: { portal: { OIDC_ISSUER: "https://auth.example.com" } },
    },
    ({ path }) => assert.throws(() => loadConfigAt(path), /OIDC_JWKS_URI/),
  );
});

test("AWS workload architecture accepts arm64 or amd64 only", () => {
  const aws = {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme",
    deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
    secretsPrefix: "acme/",
    imageLabel: "release",
    networking: { cloudMapNamespace: "acme.internal" },
    services: {
      core: { ecrRepository: "core", ecsService: "acme-core", cpu: 512, memory: 1024, architecture: "amd64" },
    },
  };
  withConfig({ target: "aws", aws }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.aws!.services.core!.architecture, "amd64");
  });
  withConfig(
    { target: "aws", aws: { ...aws, services: { core: { ...aws.services.core, architecture: "ppc64" } } } },
    ({ path }) => {
      assert.throws(() => loadConfigAt(path), /architecture.*must be "arm64" or "amd64"/);
    },
  );

  const untypedAws = { ...aws, services: { core: { ...aws.services.core, architecture: undefined } } };
  withConfig({ target: "aws", imageOverrides: { core: "ghcr.io/acme/core:1" }, aws: untypedAws }, ({ path }) => {
    assert.throws(() => loadConfigAt(path), /core\.architecture is required/);
  });
  withConfig(
    {
      target: "aws",
      plugins: [{ name: "linear", image: "ghcr.io/acme/linear:1" }],
      aws: {
        ...untypedAws,
        services: {
          ...untypedAws.services,
          linear: { ecrRepository: "linear", ecsService: "linear", cpu: 256, memory: 512 },
        },
      },
    },
    ({ path }) => {
      assert.throws(() => loadConfigAt(path), /linear\.architecture is required/);
    },
  );
});

test("AWS config rejects public surfaces without the HTTPS portal and real harnesses over HTTP", () => {
  const service = (name: string) => ({
    ecrRepository: `qm-${name}`,
    ecsService: `acme-${name}`,
    cpu: name === "core" ? 2048 : 512,
    memory: name === "core" ? 4096 : 1024,
  });
  const aws = (names: string[]) => ({
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme",
    deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
    secretsPrefix: "acme/",
    imageLabel: "release",
    networking: { cloudMapNamespace: "acme.internal" },
    services: Object.fromEntries(names.map((name) => [name, service(name)])),
  });
  const cases: Array<{ label: string; config: Record<string, unknown>; error: RegExp }> = [
    {
      label: "web-ui without portal",
      config: {
        target: "aws",
        publicUrl: "https://agent.acme.example",
        services: ["core", "web-ui"],
        aws: aws(["core", "web-ui"]),
      },
      error: /web-ui requires the authenticated portal/,
    },
    {
      label: "admin without portal",
      config: {
        target: "aws",
        publicUrl: "https://agent.acme.example",
        services: ["core", "admin"],
        aws: aws(["core", "admin"]),
      },
      error: /admin requires the authenticated portal/,
    },
    {
      label: "portal over HTTP",
      config: {
        target: "aws",
        publicUrl: "http://agent.acme.example",
        services: ["core", "web-ui", "portal"],
        env: { core: { HARNESS: "mock" } },
        aws: aws(["core", "web-ui", "portal"]),
      },
      error: /portal requires an HTTPS publicUrl/,
    },
    {
      label: "portal without a tenant gate",
      config: {
        target: "aws",
        publicUrl: "https://agent.acme.example",
        services: ["core", "web-ui", "portal"],
        env: { core: { HARNESS: "mock" }, portal: { OIDC_CLIENT_ID: "client", PORTAL_EXPECTED_TEAM_ID: " " } },
        aws: aws(["core", "web-ui", "portal"]),
      },
      error: /PORTAL_EXPECTED_TEAM_ID/,
    },
    {
      label: "custom OIDC issuer without a JWKS URI",
      config: {
        target: "aws",
        publicUrl: "https://agent.acme.example",
        services: ["core", "web-ui", "portal"],
        env: {
          core: { HARNESS: "mock" },
          portal: {
            OIDC_CLIENT_ID: "client",
            OIDC_ISSUER: "https://auth.example.com",
            OIDC_ALLOWED_EMAILS: "admin@example.com",
          },
        },
        aws: aws(["core", "web-ui", "portal"]),
      },
      error: /OIDC_JWKS_URI/,
    },
    {
      label: "custom OIDC issuer with an insecure JWKS URI",
      config: {
        target: "aws",
        publicUrl: "https://agent.acme.example",
        services: ["core", "web-ui", "portal"],
        env: {
          core: { HARNESS: "mock" },
          portal: {
            OIDC_CLIENT_ID: "client",
            OIDC_ISSUER: "https://auth.example.com",
            OIDC_JWKS_URI: "http://auth.example.com/jwks.json",
            OIDC_ALLOWED_EMAILS: "admin@example.com",
          },
        },
        aws: aws(["core", "web-ui", "portal"]),
      },
      error: /non-placeholder HTTPS URL/,
    },
    {
      label: "real harness over HTTP",
      config: {
        target: "aws",
        publicUrl: "http://agent.acme.example",
        services: ["core"],
        env: { core: { HARNESS: "pi" } },
        aws: aws(["core"]),
      },
      error: /HARNESS=pi requires an HTTPS publicUrl/,
    },
    {
      label: "apiUrl protocol differing from publicUrl",
      config: {
        target: "aws",
        publicUrl: "https://agent.acme.example",
        apiUrl: "http://api.agent.acme.example",
        services: ["core"],
        env: { core: { HARNESS: "mock" } },
        aws: aws(["core"]),
      },
      error: /apiUrl must use the same protocol as publicUrl/,
    },
  ];
  for (const deployBranch of ["refs/heads/main", "a..b", "bad branch", "release/", ".hidden", "x.lock"]) {
    cases.push({
      label: `deployBranch ${JSON.stringify(deployBranch)}`,
      config: {
        target: "aws",
        publicUrl: "http://agent.acme.example",
        services: ["core"],
        env: { core: { HARNESS: "mock" } },
        aws: { ...aws(["core"]), deployBranch },
      },
      error: /"aws\.deployBranch" must be a valid git branch name/,
    });
  }
  withConfig(
    {
      target: "aws",
      publicUrl: "http://agent.acme.example",
      services: ["core"],
      env: { core: { HARNESS: "mock" } },
      aws: { ...aws(["core"]), deployBranch: "release/prod-2", deployEnvironment: "production" },
    },
    ({ path }) => {
      assert.equal(loadConfigAt(path).config.aws?.deployBranch, "release/prod-2");
      assert.equal(loadConfigAt(path).config.aws?.deployEnvironment, "production");
    },
  );
  for (const deployEnvironment of ["bad:name", "bad environment", ".hidden", "x".repeat(256)]) {
    withConfig(
      {
        target: "aws",
        publicUrl: "http://agent.acme.example",
        services: ["core"],
        env: { core: { HARNESS: "mock" } },
        aws: { ...aws(["core"]), deployEnvironment },
      },
      ({ path }) =>
        assert.throws(
          () => loadConfigAt(path),
          /"aws\.deployEnvironment" must be a valid GitHub environment name/,
          JSON.stringify(deployEnvironment),
        ),
    );
  }
  for (const item of cases) {
    withConfig(item.config, ({ path }) => assert.throws(() => loadConfigAt(path), item.error, item.label));
  }
  withConfig(
    {
      target: "aws",
      publicUrl: "http://agent.acme.example",
      services: ["core"],
      env: { core: { HARNESS: "mock" } },
      aws: aws(["core"]),
    },
    ({ path }) => {
      assert.equal(loadConfigAt(path).config.env.core?.HARNESS, "mock");
    },
  );
  withConfig(
    {
      target: "aws",
      publicUrl: "https://agent.acme.example",
      services: ["core", "web-ui", "portal"],
      env: {
        core: { HARNESS: "pi" },
        portal: { OIDC_CLIENT_ID: "client", OIDC_ALLOWED_EMAIL_DOMAIN: "example.com", PORTAL_EXPECTED_TEAM_ID: "T123" },
      },
      aws: aws(["core", "web-ui", "portal"]),
    },
    ({ path }) => {
      assert.equal(loadConfigAt(path).config.services.includes("portal"), true);
    },
  );
  withConfig(
    {
      target: "aws",
      publicUrl: "https://agent.acme.example",
      services: ["core", "web-ui", "portal"],
      env: { core: { HARNESS: "pi" }, portal: { OIDC_CLIENT_ID: "client", OIDC_ALLOWED_EMAILS: "admin@example.com" } },
      aws: aws(["core", "web-ui", "portal"]),
    },
    ({ path }) => {
      assert.equal(loadConfigAt(path).config.env.portal?.OIDC_ALLOWED_EMAILS, "admin@example.com");
    },
  );
  withConfig(
    {
      target: "aws",
      publicUrl: "https://agent.acme.example",
      services: ["core", "web-ui", "portal"],
      env: { core: { HARNESS: "pi" }, portal: { OIDC_PRINCIPAL_CLAIM: "email" } },
      aws: aws(["core", "web-ui", "portal"]),
    },
    ({ path }) => {
      assert.equal(loadConfigAt(path).config.env.portal?.OIDC_CLIENT_ID, undefined);
    },
  );
});

test("AWS validates release labels, unique coordinates, Fargate sizes, and owned networking", () => {
  const service = { ecrRepository: "core", ecsService: "acme-core", cpu: 512, memory: 1024 };
  const aws = {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme",
    deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
    secretsPrefix: "acme/",
    imageLabel: "release-1",
    networking: { cloudMapNamespace: "acme.internal" },
    services: { core: service },
  };
  withConfig({ target: "aws", aws }, ({ path }) =>
    assert.equal(loadConfigAt(path).config.aws?.imageLabel, "release-1"),
  );
  for (const imageLabel of [undefined, "", ".release", "release!", "x".repeat(129)]) {
    withConfig({ target: "aws", aws: { ...aws, imageLabel } }, ({ path }) => {
      assert.throws(() => loadConfigAt(path), /aws\.imageLabel/);
    });
  }
  for (const invalid of [
    { cpu: 1, memory: 1 },
    { cpu: 256, memory: 768 },
    { cpu: 4096, memory: 4096 },
  ]) {
    withConfig({ target: "aws", aws: { ...aws, services: { core: { ...service, ...invalid } } } }, ({ path }) => {
      assert.throws(() => loadConfigAt(path), /not a supported Fargate task size/);
    });
  }
  for (const field of ["ecrRepository", "ecsService"] as const) {
    withConfig(
      {
        target: "aws",
        services: ["core", "web-ui"],
        aws: {
          ...aws,
          services: {
            core: service,
            "web-ui": { ...service, ecrRepository: "web", ecsService: "acme-web", [field]: service[field] },
          },
        },
      },
      ({ path }) => assert.throws(() => loadConfigAt(path), new RegExp(`duplicates aws\\.services\\.core\\.${field}`)),
    );
  }
  withConfig({ target: "aws", aws: { ...aws, alb: "legacy-alb", rdsInstance: "legacy-db" } }, ({ path }) => {
    const parsed = loadConfigAt(path).config.aws!;
    assert.equal(parsed.alb, "legacy-alb");
    assert.equal(parsed.rdsInstance, "legacy-db");
  });
  for (const alb of ["", "internal-thing", "has_underscore", "x".repeat(33)]) {
    withConfig({ target: "aws", aws: { ...aws, alb } }, ({ path }) => {
      assert.throws(() => loadConfigAt(path), /aws\.alb/);
    });
  }
  for (const rdsInstance of ["", "9starts-with-digit", "double--hyphen", "ends-", "Mixed-Case"]) {
    withConfig({ target: "aws", aws: { ...aws, rdsInstance } }, ({ path }) => {
      assert.throws(() => loadConfigAt(path), /aws\.rdsInstance/);
    });
  }
  for (const objectStoreBucket of ["legacy-bucket", "assets.acme.example", "192.168.5.bucket"]) {
    withConfig({ target: "aws", aws: { ...aws, objectStoreBucket } }, ({ path }) => {
      assert.equal(loadConfigAt(path).config.aws!.objectStoreBucket, objectStoreBucket);
    });
  }
  for (const objectStoreBucket of [
    "ab",
    ".leading-dot",
    "trailing-dot.",
    "double..dot",
    "Mixed.Case",
    "under_score",
    "x".repeat(64),
    "192.168.5.4",
  ]) {
    withConfig({ target: "aws", aws: { ...aws, objectStoreBucket } }, ({ path }) => {
      assert.throws(() => loadConfigAt(path), /aws\.objectStoreBucket.*valid S3 bucket name/);
    });
  }
  withConfig({ target: "aws", aws: { ...aws, predeployDbSnapshot: false } }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.aws!.predeployDbSnapshot, false);
  });
  for (const predeployDbSnapshot of ["false", 0, null]) {
    withConfig({ target: "aws", aws: { ...aws, predeployDbSnapshot } }, ({ path }) => {
      assert.throws(() => loadConfigAt(path), /aws\.predeployDbSnapshot/);
    });
  }
  withConfig({ target: "aws", aws: { ...aws, dbRetentionMinDays: 35 } }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.aws!.dbRetentionMinDays, 35);
  });
  for (const dbRetentionMinDays of ["7", 1.5, -1, 36, null]) {
    withConfig({ target: "aws", aws: { ...aws, dbRetentionMinDays } }, ({ path }) => {
      assert.throws(() => loadConfigAt(path), /aws\.dbRetentionMinDays/);
    });
  }
  withConfig(
    {
      target: "aws",
      aws: { ...aws, services: { core: { ...service, desiredCount: 2, targetGroup: "legacy-core-tg" } } },
    },
    ({ path }) => {
      const core = loadConfigAt(path).config.aws!.services.core!;
      assert.equal(core.desiredCount, 2);
      assert.equal(core.targetGroup, "legacy-core-tg");
    },
  );
  for (const desiredCount of [0, -1, 1.5, "2"]) {
    withConfig({ target: "aws", aws: { ...aws, services: { core: { ...service, desiredCount } } } }, ({ path }) => {
      assert.throws(() => loadConfigAt(path), /aws\.services\.core\.desiredCount/);
    });
  }
  for (const targetGroup of ["", "has_underscore", "-leading", "trailing-", "x".repeat(33)]) {
    withConfig({ target: "aws", aws: { ...aws, services: { core: { ...service, targetGroup } } } }, ({ path }) => {
      assert.throws(() => loadConfigAt(path), /aws\.services\.core\.targetGroup/);
    });
  }
  withConfig(
    {
      target: "aws",
      services: ["core", "web-ui"],
      aws: {
        ...aws,
        services: {
          core: { ...service, targetGroup: "shared-tg" },
          "web-ui": { ...service, ecrRepository: "web", ecsService: "acme-web", targetGroup: "shared-tg" },
        },
      },
    },
    ({ path }) => assert.throws(() => loadConfigAt(path), /duplicates aws\.services\.core\.targetGroup/),
  );
  withConfig(
    { target: "aws", aws: { ...aws, services: { core: { ...service, dockerfile: "layered/core.Dockerfile" } } } },
    ({ path }) => {
      assert.equal(loadConfigAt(path).config.aws?.services.core?.dockerfile, "layered/core.Dockerfile");
    },
  );
  for (const dockerfile of [
    "",
    "/abs/Dockerfile",
    "layered/../../escape.Dockerfile",
    "layered\\..\\escape.Dockerfile",
  ]) {
    withConfig({ target: "aws", aws: { ...aws, services: { core: { ...service, dockerfile } } } }, ({ path }) => {
      assert.throws(() => loadConfigAt(path), /services\.core\.dockerfile/);
    });
  }
  for (const field of ["subnets", "securityGroups"] as const) {
    withConfig({ target: "aws", aws: { ...aws, networking: { ...aws.networking, [field]: ["x"] } } }, ({ path }) => {
      assert.throws(() => loadConfigAt(path), new RegExp(`aws\\.networking\\.${field}.*not supported`));
    });
  }
});

test("AWS rejects coordinates that its Terraform-derived resources cannot accept", () => {
  const service = { ecrRepository: "core", ecsService: "acme-core", cpu: 512, memory: 1024 };
  const aws = {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme",
    deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
    secretsPrefix: "acme/",
    imageLabel: "release",
    networking: { cloudMapNamespace: "acme.internal" },
    services: { core: service },
  };
  for (const accountId of ["1", "12345678901x", "1234567890123"]) {
    withConfig({ target: "aws", aws: { ...aws, accountId } }, ({ path }) =>
      assert.throws(() => loadConfigAt(path), /aws\.accountId.*12 digits/),
    );
  }
  for (const region of [
    "cn-north-1",
    "us-gov-west-1",
    "us-iso-east-1",
    "us-isob-east-1",
    "eu-isoe-west-1",
    "us-isof-south-1",
  ]) {
    withConfig({ target: "aws", aws: { ...aws, region } }, ({ path }) =>
      assert.throws(() => loadConfigAt(path), /commercial AWS partition/),
    );
  }
  for (const cluster of ["Acme", "1acme", "acme--prod", "acme_", `a${"b".repeat(49)}`]) {
    withConfig({ target: "aws", aws: { ...aws, cluster } }, ({ path }) =>
      assert.throws(() => loadConfigAt(path), /aws\.cluster.*derived IAM and RDS/),
    );
  }
  for (const secretsPrefix of ["acme?", "x".repeat(257)]) {
    withConfig({ target: "aws", aws: { ...aws, secretsPrefix } }, ({ path }) =>
      assert.throws(() => loadConfigAt(path), /secretsPrefix.*AWS secret-name/),
    );
  }
  for (const cloudMapNamespace of ["-acme.internal", "acme..internal", `${"a".repeat(64)}.internal`, "a".repeat(254)]) {
    withConfig({ target: "aws", aws: { ...aws, networking: { cloudMapNamespace } } }, ({ path }) =>
      assert.throws(() => loadConfigAt(path), /cloudMapNamespace.*valid DNS/),
    );
  }
  for (const deployRoleArn of [
    "not-an-arn",
    "arn:aws:iam::999999999999:role/deploy",
    "arn:aws-cn:iam::123456789012:role/deploy",
    "arn:aws:iam::123456789012:user/deploy",
  ]) {
    withConfig({ target: "aws", aws: { ...aws, deployRoleArn } }, ({ path }) =>
      assert.throws(() => loadConfigAt(path), /deployRoleArn.*account 123456789012.*commercial AWS partition/),
    );
  }
  for (const role of ["taskRoleArn", "executionRoleArn"] as const) {
    for (const arn of [
      "not-an-arn",
      "arn:aws:iam::999999999999:role/custom",
      "arn:aws-cn:iam::123456789012:role/custom",
    ]) {
      withConfig({ target: "aws", aws: { ...aws, services: { core: { ...service, [role]: arn } } } }, ({ path }) => {
        assert.throws(() => loadConfigAt(path), new RegExp(`${role}.*account 123456789012.*commercial AWS partition`));
      });
    }
  }
  const longSecret = `X${"Y".repeat(300)}`;
  withConfig(
    {
      target: "aws",
      plugins: [{ name: "linear", secrets: [{ name: longSecret }] }],
      aws: { ...aws, secretsPrefix: "p".repeat(220) },
    },
    ({ path }) => assert.throws(() => loadConfigAt(path), /plus computed secret.*512-character/),
  );
});

test("sandbox.app drives FLY_SANDBOX_APP_NAME and the digest-pinned FLY_BASE_IMAGE", () => {
  withConfig(
    {
      sandbox: {
        app: "acme-sandboxes",
        image: "registry.fly.io/acme-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
      },
    },
    ({ path }) => {
      const { config } = loadConfigAt(path);
      assert.deepEqual(config.sandbox, {
        app: "acme-sandboxes",
        image: "registry.fly.io/acme-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
      });
      assert.deepEqual(sandboxCoreEnv(config), {
        env: {
          FLY_SANDBOX_APP_NAME: "acme-sandboxes",
          FLY_BASE_IMAGE:
            "registry.fly.io/acme-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
        },
        missingSecrets: [],
      });
    },
  );
});

test("a sandbox.app with no pinned image fails closed instead of fabricating a mutable tag", () => {
  withConfig({ sandbox: { app: "acme-sandboxes" } }, ({ path }) => {
    const { config } = loadConfigAt(path);
    assert.throws(() => sandboxCoreEnv(config), /no sandbox layer image is pinned.*qm sandbox publish/s);
  });
});

test("a tag-pinned sandbox.image is refused: staleness compares image references", () => {
  withConfig({ sandbox: { app: "acme-sandboxes", image: "registry.fly.io/shared-sandboxes:latest" } }, ({ path }) => {
    const { config } = loadConfigAt(path);
    assert.throws(() => sandboxCoreEnv(config), /must be pinned by digest/);
  });
});

test("a mutable sandbox tag fails check, while an unpublished deployment is only pending", () => {
  withConfig({ target: "fly", region: "sjc", flyOrg: "acme", sandbox: { app: "acme-sandboxes" } }, ({ path }) => {
    const { config } = loadConfigAt(path);
    assert.deepEqual(sandboxImagePinErrors(config), [], "check cannot demand a pin only `sandbox publish` can write");
    assert.equal(sandboxPinPending(config), true);
    assert.throws(
      () => sandboxCoreEnv(config),
      /no sandbox layer image is pinned/,
      "rendering core still fails closed",
    );
  });
  withConfig(
    {
      target: "fly",
      region: "sjc",
      flyOrg: "acme",
      sandbox: { app: "acme-sandboxes", image: "registry.fly.io/acme-sandboxes:latest" },
    },
    ({ path }) => {
      const { config } = loadConfigAt(path);
      const errors = sandboxImagePinErrors(config);
      assert.equal(errors.length, 1);
      assert.equal(errors[0]!.clause, "config.v1");
      assert.match(errors[0]!.message, /must be pinned by digest/);
    },
  );
  withConfig(
    {
      target: "fly",
      region: "sjc",
      flyOrg: "acme",
      sandbox: { app: "acme-sandboxes", image: `registry.fly.io/acme-sandboxes@sha256:${"1a".repeat(32)}` },
    },
    ({ path }) => {
      assert.deepEqual(sandboxImagePinErrors(loadConfigAt(path).config), []);
    },
  );
});

test("sandbox.image requires sandbox.app and must be non-empty", () => {
  withConfig(
    {
      sandbox: {
        image:
          "registry.fly.io/shared-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
      },
    },
    ({ path }) => {
      assert.throws(() => loadConfigAt(path), /"sandbox\.image" requires "sandbox\.app"/);
    },
  );
  withConfig({ sandbox: { app: "acme-sandboxes", image: "" } }, ({ path }) => {
    assert.throws(() => loadConfigAt(path), /"sandbox\.image" must be a non-empty string/);
  });
});

test("sandbox.env (literals) + sandbox.secretEnv (resolved) become FLY_RESIDENT_ENV_<KEY>", () => {
  withConfig(
    {
      sandbox: {
        app: "acme-sandboxes",
        image: "registry.fly.io/acme-sandboxes@sha256:1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a",
        env: { TZ: "America/Los_Angeles" },
        secretEnv: ["COMPANY_API_TOKEN"],
      },
    },
    ({ path }) => {
      const { config } = loadConfigAt(path);
      const resolved = sandboxCoreEnv(config, (n) => (n === "COMPANY_API_TOKEN" ? "sek-ret" : undefined));
      assert.equal(resolved.env.FLY_RESIDENT_ENV_TZ, "America/Los_Angeles");
      assert.equal(resolved.env.FLY_RESIDENT_ENV_COMPANY_API_TOKEN, "sek-ret");
      assert.deepEqual(resolved.missingSecrets, []);
      const missing = sandboxCoreEnv(config);
      assert.deepEqual(missing.missingSecrets, ["COMPANY_API_TOKEN"]);
      assert.equal(missing.env.FLY_RESIDENT_ENV_COMPANY_API_TOKEN, undefined);
      assert.equal(missing.env.FLY_RESIDENT_ENV_TZ, "America/Los_Angeles");
    },
  );
});

test("no sandbox block → no injected env, lenient undefined app", () => {
  withConfig({}, ({ path }) => {
    const { config } = loadConfigAt(path);
    assert.equal(config.sandbox, undefined);
    assert.deepEqual(sandboxCoreEnv(config), { env: {}, missingSecrets: [] });
  });
});

test("sandbox shape errors: object, app non-empty string, env string-map, secretEnv valid names", () => {
  const cases: Array<{ sandbox: unknown; rx: RegExp }> = [
    { sandbox: "x", rx: /"sandbox" must be an object/ },
    { sandbox: ["x"], rx: /"sandbox" must be an object/ },
    { sandbox: { app: "" }, rx: /"sandbox.app" must be a non-empty string/ },
    { sandbox: { app: 5 }, rx: /"sandbox.app" must be a non-empty string/ },
    { sandbox: { env: { TZ: 5 } }, rx: /"sandbox.env.TZ" must be a string/ },
    { sandbox: { env: { "1BAD": "x" } }, rx: /"sandbox.env" key .* is not a valid env var name/ },
    { sandbox: { secretEnv: "X" }, rx: /"sandbox.secretEnv" must be an array of strings/ },
    { sandbox: { secretEnv: ["1BAD"] }, rx: /not a valid env var name/ },
    { sandbox: { backend: "k8s", app: "acme-sandboxes" }, rx: /"sandbox.backend" must be "sprites".*or "aws"/ },
    { sandbox: { backend: "fly", app: "acme-sandboxes" }, rx: /"sandbox.backend" must be "sprites".*or "aws"/ },
    { sandbox: { backend: "sprites" }, rx: /"sandbox.backend": "sprites" requires "sandbox.app"/ },
    {
      sandbox: { backend: "aws", app: "acme-sandboxes" },
      rx: /"sandbox.backend": "aws" \(Lambda MicroVM sandboxes\) requires target "aws"/,
    },
  ];
  for (const { sandbox, rx } of cases) {
    withConfig({ sandbox }, ({ path }) =>
      assert.throws(() => loadConfigAt(path), rx, `expected ${JSON.stringify(sandbox)} rejected`),
    );
  }
});

test("aws target makes the sandbox substrate explicit: backend required with a sandbox block, sprites needs app, aws forbids fly-image settings", () => {
  const aws = {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme",
    deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
    secretsPrefix: "acme/",
    imageLabel: "release",
    networking: { cloudMapNamespace: "acme.internal" },
    services: { core: { ecrRepository: "core", ecsService: "acme-core", cpu: 512, memory: 1024 } },
  };
  withConfig({ target: "aws", aws, sandbox: { app: "acme-sandboxes" } }, ({ path }) => {
    assert.throws(() => loadConfigAt(path), /target "aws" requires an explicit "sandbox.backend"/);
  });
  withConfig({ target: "aws", aws, sandbox: { backend: "sprites", app: "acme-sandboxes" } }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.sandbox?.backend, "sprites");
  });
  withConfig({ target: "aws", aws, sandbox: { backend: "aws" } }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.sandbox?.backend, "aws");
  });
  withConfig({ target: "aws", aws, sandbox: { backend: "sprites", app: "acme-sandboxes" } }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.sandbox?.backend, "sprites");
  });
  withConfig({ target: "aws", aws, sandbox: { backend: "aws", app: "acme-sandboxes" } }, ({ path }) => {
    assert.throws(
      () => loadConfigAt(path),
      /"sandbox.backend": "aws" runs Lambda MicroVM sandboxes, which ignore "sandbox.app"/,
    );
  });
  withConfig(
    {
      target: "aws",
      aws,
      sandbox: { backend: "aws", image: `registry.fly.io/acme-sandboxes@sha256:${"a".repeat(64)}` },
    },
    ({ path }) => {
      assert.throws(
        () => loadConfigAt(path),
        /"sandbox.backend": "aws" runs Lambda MicroVM sandboxes, which ignore "sandbox.image"/,
      );
    },
  );
  withConfig({ target: "aws", aws }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.sandbox, undefined);
  });
});

test("loadConfigInDir reads qm.config.jsonc from the deployment dir (no walk-up)", () => {
  withConfig({}, ({ dir }) => {
    assert.equal(loadConfigInDir(dir).config.orgId, "acme");
  });
  const empty = mkdtempSync(join(tmpdir(), "qm-empty-"));
  try {
    assert.throws(() => loadConfigInDir(empty), /no qm.config.jsonc/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("config JSONC accepts comments and trailing commas like tsconfig.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-jsonc-"));
  const path = join(dir, CONFIG_FILENAME);
  try {
    writeFileSync(
      path,
      `{
      // JSONC comment
      "contract": 1,
      "orgId": "acme",
      "publicUrl": "http://localhost:8080",
      "target": "docker",
      "services": ["core",],
    }`,
    );
    assert.deepEqual(loadConfigAt(path).config.services, ["core"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigSandbox splices pins into a commented JSONC config without touching anything else", () => {
  const raw = `{
  // The deployment contract major this directory conforms to.
  "contract": 1,
  "orgId": "acme", // inline comment with a "quote
  "publicUrl": "http://localhost:8080",
  "target": "docker",
  "services": ["core"],
  /* block comment
     spanning lines */
  "sandbox": { "app": "acme-sandboxes" }
}
`;
  const image = "registry.fly.io/acme-sandboxes@sha256:" + "e".repeat(64);
  const base = "ghcr.io/base@sha256:" + "d".repeat(64);
  const updated = updateConfigSandbox(raw, { image, baseImage: base });
  assert.match(updated, /\/\/ The deployment contract major/, "line comments survive");
  assert.match(updated, /\/\* block comment/, "block comments survive");
  assert.match(updated, /inline comment with a "quote/, "comments after values survive");
  const dir = mkdtempSync(join(tmpdir(), "qm-cfg-"));
  const path = join(dir, CONFIG_FILENAME);
  try {
    writeFileSync(path, updated);
    const { config } = loadConfigAt(path);
    assert.equal(config.sandbox?.app, "acme-sandboxes");
    assert.equal(config.sandbox?.image, image);
    assert.equal(config.sandbox?.baseImage, base);

    const image2 = "registry.fly.io/acme-sandboxes@sha256:" + "f".repeat(64);
    writeFileSync(path, updateConfigSandbox(updated, { image: image2 }));
    const again = loadConfigAt(path).config;
    assert.equal(again.sandbox?.image, image2);
    assert.equal(again.sandbox?.baseImage, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateConfigSandbox adds a sandbox block when the config has none", () => {
  const image = "registry.fly.io/acme-sandboxes@sha256:" + "e".repeat(64);
  const updated = updateConfigSandbox(`{\n  "contract": 1,\n  "orgId": "acme"\n}\n`, { image });
  const parsed = JSON.parse(updated) as { orgId: string; sandbox: { image: string } };
  assert.equal(parsed.orgId, "acme");
  assert.equal(parsed.sandbox.image, image);
});

test("updateConfigSandbox fills an empty sandbox object", () => {
  const image = "registry.fly.io/a@sha256:" + "e".repeat(64);
  const parsed = JSON.parse(updateConfigSandbox(`{ "sandbox": {} }`, { image })) as { sandbox: { image: string } };
  assert.equal(parsed.sandbox.image, image);
});

test("updateConfigImageOverrides preserves JSONC while recording immutable service pins", () => {
  const digest = `registry.fly.io/acme-core@sha256:${"a".repeat(64)}`;
  const updated = updateConfigImageOverrides(
    `{
  // deployment
  "contract": 1,
  "imageOverrides": {}
}
`,
    { core: digest },
  );
  assert.match(updated, /\/\/ deployment/);
  assert.equal(
    (JSON.parse(updated.replace(/^\s*\/\/.*$/gm, "")) as { imageOverrides: { core: string } }).imageOverrides.core,
    digest,
  );
});

test("secretEnv (per-service) validates service keys, env-var names, and managed ports", () => {
  withConfig(
    { secretEnv: { core: { OPENAI_API_KEY: "OPENAI_API_KEY", DEPLOY_APPS_SESSION_SECRET: "PORTAL_SESSION_SECRET" } } },
    ({ path }) => {
      assert.deepEqual(loadConfigAt(path).config.secretEnv, {
        core: { OPENAI_API_KEY: "OPENAI_API_KEY", DEPLOY_APPS_SESSION_SECRET: "PORTAL_SESSION_SECRET" },
      });
    },
  );
  withConfig({ secretEnv: {} }, ({ path }) => assert.equal(loadConfigAt(path).config.secretEnv, undefined));
  withConfig({ secretEnv: { nope: { A: "A" } } }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /"secretEnv" has unknown service "nope"/),
  );
  withConfig({ secretEnv: { core: { "not a name": "A" } } }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /not a valid env var name/),
  );
  withConfig({ secretEnv: { core: { A: "not a name" } } }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /must name a secret-store entry/),
  );
  withConfig({ secretEnv: { core: { A: 1 } } }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /"secretEnv.core.A" must be a string/),
  );
  withConfig({ secretEnv: { core: { PORT: "SOME_SECRET" } } }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /"secretEnv.core.PORT" is managed by the deployment target/),
  );
});

test("securityScreen declares one external proxy and requires secret-store routing", () => {
  const securityScreen = {
    backend: "proxy",
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    rollout: "shadow",
  };
  withConfig(
    { securityScreen, secretEnv: { core: { SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN" } } },
    ({ path }) => assert.deepEqual(loadConfigAt(path).config.securityScreen, securityScreen),
  );
  withConfig({ securityScreen }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /securityScreen requires secretEnv\.core\.SECURITY_SCREEN_PROXY_TOKEN/),
  );
  withConfig({ secretEnv: { core: { SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN" } } }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /SECURITY_SCREEN_PROXY_TOKEN requires securityScreen/),
  );
  for (const invalid of [
    { ...securityScreen, backend: "sdk" },
    { ...securityScreen, provider: "Bad Provider" },
    { ...securityScreen, provider: "surface" },
    { ...securityScreen, provider: "origin" },
    { ...securityScreen, endpoint: "http://screen.example.test/classify" },
    { ...securityScreen, rollout: "gradual" },
    { ...securityScreen, extra: true },
  ]) {
    withConfig(
      { securityScreen: invalid, secretEnv: { core: { SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN" } } },
      ({ path }) => assert.throws(() => loadConfigAt(path), /securityScreen/),
    );
  }
});

test("securityScreen owns its derived environment and keeps its token on core", () => {
  const securityScreen = {
    backend: "proxy",
    provider: "example-screen",
    endpoint: "https://screen.example.test/classify",
    rollout: "enforce",
  };
  withConfig(
    {
      securityScreen,
      secretEnv: { core: { SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN" } },
      env: { core: { SECURITY_SCREEN_PROXY_ENDPOINT: "https://other.example.test/classify" } },
    },
    ({ path }) => assert.throws(() => loadConfigAt(path), /managed by securityScreen/),
  );
  withConfig(
    {
      securityScreen,
      secretEnv: { core: { SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN" } },
      env: { core: { SECURITY_SCREEN_PROXY_TOKEN: "plaintext-token" } },
    },
    ({ path }) =>
      assert.throws(() => loadConfigAt(path), /env\.core\.SECURITY_SCREEN_PROXY_TOKEN.*managed by securityScreen/),
  );
  withConfig(
    {
      securityScreen,
      secretEnv: {
        core: {
          SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN",
          SECURITY_SCREEN_PROXY_ENDPOINT: "EXAMPLE_SCREEN_ENDPOINT",
        },
      },
    },
    ({ path }) =>
      assert.throws(
        () => loadConfigAt(path),
        /secretEnv\.core\.SECURITY_SCREEN_PROXY_ENDPOINT.*managed by securityScreen/,
      ),
  );
  withConfig(
    {
      services: ["core", "slack"],
      securityScreen,
      secretEnv: {
        core: { SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN" },
        slack: { SECURITY_SCREEN_PROXY_ROLLOUT: "EXAMPLE_SCREEN_ROLLOUT" },
      },
    },
    ({ path }) =>
      assert.throws(
        () => loadConfigAt(path),
        /secretEnv\.slack\.SECURITY_SCREEN_PROXY_ROLLOUT.*managed by securityScreen/,
      ),
  );
  withConfig(
    {
      services: ["core", "slack"],
      securityScreen,
      secretEnv: {
        core: { SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN" },
        slack: { SECURITY_SCREEN_PROXY_TOKEN: "EXAMPLE_SCREEN_TOKEN" },
      },
    },
    ({ path }) => assert.throws(() => loadConfigAt(path), /SECURITY_SCREEN_PROXY_TOKEN may be routed only to core/),
  );
});

test("aws.services logGroup and stopTimeout adopt live task-def values and validate their shapes", () => {
  const aws = {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme",
    imageLabel: "release",
    deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
    secretsPrefix: "acme/",
    networking: { cloudMapNamespace: "acme.internal" },
  };
  const services = (core: Record<string, unknown>): Record<string, unknown> => ({
    core: { ecrRepository: "qm-core", ecsService: "acme-core", cpu: 2048, memory: 4096, ...core },
  });
  withConfig(
    { target: "aws", aws: { ...aws, services: services({ logGroup: "/ecs/legacy-core", stopTimeout: 120 }) } },
    ({ path }) => {
      const core = loadConfigAt(path).config.aws!.services.core!;
      assert.equal(core.logGroup, "/ecs/legacy-core");
      assert.equal(core.stopTimeout, 120);
    },
  );
  withConfig({ target: "aws", aws: { ...aws, services: services({ logGroup: "bad name" }) } }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /logGroup" must be a valid CloudWatch log group name/),
  );
  withConfig({ target: "aws", aws: { ...aws, services: services({ logGroup: "" }) } }, ({ path }) =>
    assert.throws(() => loadConfigAt(path), /must be a non-empty string/),
  );
  for (const stopTimeout of [1, 121, 30.5, "30"]) {
    withConfig({ target: "aws", aws: { ...aws, services: services({ stopTimeout }) } }, ({ path }) =>
      assert.throws(() => loadConfigAt(path), /stopTimeout" must be an integer between 2 and 120/),
    );
  }
});

test("modelProvider must name a vendor the configured harness can bill", () => {
  withConfig({ modelProvider: "openrouter", env: { core: { HARNESS: "pi" } } }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.modelProvider, "openrouter");
  });
  withConfig({ modelProvider: "openrouter", env: { core: { HARNESS: "codex" } } }, ({ path }) => {
    assert.throws(
      () => loadConfigAt(path),
      /model provider "openrouter" cannot serve a base model on env.core.HARNESS "codex"/,
    );
  });
  withConfig({ modelProvider: "anthropic", env: { core: { HARNESS: "codex" } } }, ({ path }) => {
    assert.throws(() => loadConfigAt(path), /cannot serve a base model/);
  });
  withConfig({ modelProvider: "openai", env: { core: { HARNESS: "codex" } } }, ({ path }) => {
    assert.equal(loadConfigAt(path).config.modelProvider, "openai");
  });
  withConfig({ modelProvider: "openrouter" }, ({ path }) => {
    assert.equal(
      loadConfigAt(path).config.modelProvider,
      "openrouter",
      "an unset harness is mock, which bills anything",
    );
  });
});

test("env.core.MODEL_PROVIDER is validated as the provider core will actually use", () => {
  withConfig(
    { modelProvider: "openai", env: { core: { HARNESS: "codex", MODEL_PROVIDER: "anthropic" } } },
    ({ path }) => {
      assert.throws(() => loadConfigAt(path), /model provider "anthropic" cannot serve a base model/);
    },
  );
  withConfig(
    { modelProvider: "anthropic", env: { core: { HARNESS: "codex", MODEL_PROVIDER: "openai" } } },
    ({ path }) => {
      assert.equal(loadConfigAt(path).config.modelProvider, "anthropic", "the override decides, the declaration stays");
    },
  );
  withConfig({ env: { core: { HARNESS: "pi", MODEL_PROVIDER: "bedrock" } } }, ({ path }) => {
    assert.throws(() => loadConfigAt(path), /env.core.MODEL_PROVIDER must be one of/);
  });
});

test("a mock deployment is named as one, and a real harness draws no warning", () => {
  withConfig({ env: { core: {} } }, ({ path }) => {
    assert.match(mockHarnessWarning(loadConfigAt(path).config)!, /unset, which means "mock".*calls no model provider/s);
  });
  withConfig({ env: { core: { HARNESS: "mock" } } }, ({ path }) => {
    assert.match(mockHarnessWarning(loadConfigAt(path).config)!, /set to "mock"/);
  });
  withConfig({ env: { core: { HARNESS: "pi" } } }, ({ path }) => {
    assert.equal(mockHarnessWarning(loadConfigAt(path).config), undefined);
  });
  withConfig({ target: "fly", appPrefix: "acme", env: { core: {} } }, ({ path }) => {
    assert.equal(mockHarnessWarning(loadConfigAt(path).config), undefined, "the fly template renders HARNESS=pi");
  });
});
