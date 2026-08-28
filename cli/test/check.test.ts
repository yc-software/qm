import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../src/commands/check.ts";
import type { QmConfig } from "../src/config.ts";
import { computedSecrets, renderEnvExample } from "../src/secrets.ts";

const PINNED_SANDBOX_IMAGE = `registry.fly.io/acme-sandboxes@sha256:${"b".repeat(64)}`;

const CONFIG: QmConfig = {
  contract: 1,
  orgId: "acme",
  publicUrl: "http://localhost:8080",
  target: "docker",
  services: ["core"],
  plugins: [],
  skills: [],
  env: {},
  imageOverrides: {},
  sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE },
};

function deployment(setup: (dir: string) => void, config: Partial<QmConfig> = {}): { dir: string; config: QmConfig } {
  const dir = mkdtempSync(join(tmpdir(), "qm-check-"));
  setup(dir);
  return { dir, config: { ...CONFIG, ...config } };
}

function writeTool(dir: string, id: string, descriptor: object, withExe = true): void {
  const td = join(dir, "sandbox", "tools", id);
  mkdirSync(td, { recursive: true });
  writeFileSync(join(td, "tool.json"), JSON.stringify(descriptor));
  if (withExe) {
    writeFileSync(join(td, id), "#!/usr/bin/env bash\necho hi\n");
    chmodSync(join(td, id), 0o755);
  }
}

function writeSkill(dir: string, id: string, frontmatter: string): void {
  mkdirSync(join(dir, "sandbox", "skills", id), { recursive: true });
  writeFileSync(join(dir, "sandbox", "skills", id, "SKILL.md"), `---\n${frontmatter}\n---\nbody\n`);
}

function check(d: { dir: string; config: QmConfig }): ReturnType<typeof runChecks> {
  return runChecks(d.config, d.dir, join(d.dir, "sandbox"), { report: false });
}

test("a valid sandbox layer passes and returns the parsed tools + skills", () => {
  const d = deployment((dir) => {
    writeTool(dir, "example-tool", {
      id: "example-tool",
      advertise: "example-tool",
      install: { binary: "example-tool" },
    });
    writeSkill(dir, "greet", "name: greet\ndescription: Greet a teammate.");
  });
  try {
    const { layer, plugins } = check(d);
    assert.equal(layer.tools.length, 1);
    assert.equal(layer.skills.length, 1);
    assert.deepEqual(plugins, []);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("every Fly deployment requires durable S3-compatible stores", () => {
  const base = {
    target: "fly" as const,
    region: "sjc",
    flyOrg: "personal",
    services: ["core", "portal"] as QmConfig["services"],
  };
  const ephemeral = deployment(() => {}, base);
  const durable = deployment(() => {}, {
    ...base,
    env: { core: { SNAPSHOT_STORE: "s3", TRANSFER_STORE: "s3", S3_BUCKET: "acme-data", S3_REGION: "auto" } },
  });
  try {
    assert.throws(() => check(ephemeral), /Fly deployment requires env\.core\.SNAPSHOT_STORE/);
    assert.doesNotThrow(() => check(durable));
  } finally {
    rmSync(ephemeral.dir, { recursive: true, force: true });
    rmSync(durable.dir, { recursive: true, force: true });
  }
});

test("a malformed tool.json fails the check", () => {
  const d = deployment((dir) => {
    mkdirSync(join(dir, "sandbox", "tools", "bad"), { recursive: true });
    writeFileSync(join(dir, "sandbox", "tools", "bad", "tool.json"), "{ not json }");
  });
  try {
    assert.throws(() => check(d), /check failed/);
    assert.throws(() => check(d), /not valid JSON/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("a SKILL.md missing required frontmatter fails the check", () => {
  const d = deployment((dir) => writeSkill(dir, "broken", "description: no name here"));
  try {
    assert.throws(() => check(d), /missing "name"/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("a tool with no executable and no Dockerfile fails (can't get its binary on PATH)", () => {
  const d = deployment((dir) =>
    writeTool(dir, "needs-bin", { id: "needs-bin", install: { binary: "needs-bin" } }, false),
  );
  try {
    assert.throws(() => check(d), /can't get its binary on PATH/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("a tool with no executable BUT a sandbox/Dockerfile passes (Dockerfile installs it)", () => {
  const d = deployment((dir) => {
    writeTool(dir, "apt-tool", { id: "apt-tool", install: { binary: "apt-tool" } }, false);
    writeFileSync(join(dir, "sandbox", "Dockerfile"), "FROM base\nRUN apt-get install -y apt-tool\n");
  });
  try {
    const { layer } = check(d);
    assert.equal(layer.tools.length, 1);
    assert.ok(layer.hasDockerfile);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("duplicate tool ids are flagged", () => {
  const d = deployment((dir) => {
    writeTool(dir, "folderA", { id: "same", install: { binary: "same" } });
    writeTool(dir, "folderB", { id: "same", install: { binary: "same" } });
  });
  try {
    assert.throws(() => check(d), /duplicate tool id "same"/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("a plugin that is both a source folder and an image is flagged", () => {
  const d = deployment((dir) => mkdirSync(join(dir, "plugins", "dup"), { recursive: true }), {
    plugins: [{ name: "dup", image: "ghcr.io/x:1" }],
  });
  writeFileSync(join(d.dir, "plugins", "dup", "Dockerfile"), "FROM scratch\n");
  try {
    assert.throws(() => check(d), /both a source folder .* and an image/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("a config plugin naming neither an image nor a source folder is flagged", () => {
  const d = deployment(() => {}, { plugins: [{ name: "ghost" }] });
  try {
    assert.throws(() => check(d), /names neither an image nor/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("a bare deployment (no sandbox/, no plugins) passes", () => {
  const d = deployment(() => {});
  try {
    const { layer, plugins } = check(d);
    assert.equal(layer.exists, false);
    assert.deepEqual(plugins, []);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("docker with sandbox.backend local passes without a Fly sandbox app", () => {
  const d = deployment(() => {}, { sandbox: { backend: "local", image: "qm-sandbox-local:latest" } });
  try {
    assert.doesNotThrow(() => check(d));
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("AWS requires exact ECS/ECR coordinates for discovered plugins", () => {
  const plugin = { name: "linear", image: "ghcr.io/acme/linear:1" };
  const aws = {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme",
    deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
    secretsPrefix: "acme/",
    imageLabel: "release",
    networking: { cloudMapNamespace: "acme.internal" },
    services: {
      core: { ecrRepository: "core", ecsService: "acme-core", cpu: 512, memory: 1024 },
      linear: {
        ecrRepository: "linear",
        ecsService: "acme-linear",
        cpu: 256,
        memory: 512,
        architecture: "amd64" as const,
      },
    },
  };
  const d = deployment(() => {}, { target: "aws", plugins: [plugin], aws });
  try {
    assert.doesNotThrow(() => check(d));
    delete d.config.aws!.services.linear!.architecture;
    assert.throws(() => check(d), /aws\.services\.linear\.architecture is required/);
    d.config.aws!.services.linear!.architecture = "amd64";
    delete d.config.aws!.services.linear;
    assert.throws(() => check(d), /aws\.services\.linear/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("optional plugin secrets remain in the computed contract without becoming required", () => {
  const optional: QmConfig = {
    ...CONFIG,
    plugins: [{ name: "linear", image: "ghcr.io/acme/linear:1", secrets: [{ name: "LINEAR_TOKEN", required: false }] }],
  };
  const secret = computedSecrets(optional).find((item) => item.name === "LINEAR_TOKEN");
  assert.equal(secret?.required, false);
  assert.ok(renderEnvExample(optional).includes("# LINEAR_TOKEN=  # optional"));
});

test("check rejects what the core's deployment-layer API would reject: binary skill assets", () => {
  const d = deployment((dir) => {
    writeSkill(dir, "greet", "name: greet\ndescription: g.");
    writeFileSync(
      join(dir, "sandbox", "skills", "greet", "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    );
  });
  try {
    assert.throws(() => check(d), /text skill assets/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("OS junk files inside a skill dir pass check (push skips them too)", () => {
  const d = deployment((dir) => {
    writeSkill(dir, "greet", "name: greet\ndescription: g.");
    writeFileSync(
      join(dir, "sandbox", "skills", "greet", ".DS_Store"),
      Buffer.from([0x00, 0x01, 0x42, 0x75, 0x64, 0x31]),
    );
    writeFileSync(join(dir, "sandbox", "skills", "greet", "._notes.md"), Buffer.from([0x00, 0x05, 0x16, 0x07]));
  });
  try {
    const { layer } = check(d);
    assert.deepEqual(layer.errors, []);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("secret-looking literals in plugin and sandbox env fail config.no-secret-values", () => {
  const viaPlugin = deployment(() => {}, {
    plugins: [{ name: "linear", image: "ghcr.io/x:1", env: { LINEAR_API_KEY: "lin_x" } }],
  });
  const viaSandbox = deployment(() => {}, {
    sandbox: { app: "acme-sandboxes", image: PINNED_SANDBOX_IMAGE, env: { GH_TOKEN: "ghp_x" } },
  });
  const viaKey = deployment(() => {}, { env: { core: { AWS_SECRET_ACCESS_KEY: "aws_x" } } });
  const viaCred = deployment(() => {}, {
    sandbox: {
      app: "acme-sandboxes",
      image: PINNED_SANDBOX_IMAGE,
      env: { PGPASSWORD: "pg_x", GOOGLE_CREDENTIALS: "{}" },
    },
  });
  const benign = deployment(() => {}, {
    sandbox: {
      app: "acme-sandboxes",
      image: PINNED_SANDBOX_IMAGE,
      env: { JWT_PUBLIC_KEY: "MFkw...", GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/gcp.json" },
    },
  });
  try {
    assert.throws(() => check(viaPlugin), /plugins\.linear\.LINEAR_API_KEY belongs in the target secret store/);
    assert.throws(() => check(viaSandbox), /sandbox\.GH_TOKEN belongs in the target secret store/);
    assert.throws(() => check(viaKey), /core\.AWS_SECRET_ACCESS_KEY belongs in the target secret store/);
    assert.throws(() => check(viaCred), /sandbox\.PGPASSWORD belongs in the target secret store/);
    assert.throws(() => check(viaCred), /sandbox\.GOOGLE_CREDENTIALS belongs in the target secret store/);
    check(benign);
  } finally {
    rmSync(viaPlugin.dir, { recursive: true, force: true });
    rmSync(viaSandbox.dir, { recursive: true, force: true });
    rmSync(viaKey.dir, { recursive: true, force: true });
    rmSync(viaCred.dir, { recursive: true, force: true });
    rmSync(benign.dir, { recursive: true, force: true });
  }
});

test("secret-looking AWS build arguments fail config.no-secret-values", () => {
  const d = deployment(() => {}, {
    target: "aws",
    aws: {
      accountId: "123456789012",
      region: "us-west-2",
      cluster: "acme",
      deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
      secretsPrefix: "acme/",
      imageLabel: "release",
      networking: { cloudMapNamespace: "acme.internal" },
      services: {
        core: {
          ecrRepository: "core",
          ecsService: "acme-core",
          cpu: 512,
          memory: 1024,
          buildArgs: { NPM_TOKEN: "secret" },
        },
      },
    },
  });
  try {
    assert.throws(() => check(d), /aws\.services\.core\.buildArgs\.NPM_TOKEN belongs in the target secret store/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("check rejects symlinked skill assets before any deploy rolls", () => {
  const d = deployment((dir) => {
    writeSkill(dir, "greet", "name: greet\ndescription: g.");
    symlinkSync(
      join(dir, "sandbox", "skills", "greet", "SKILL.md"),
      join(dir, "sandbox", "skills", "greet", "link.md"),
    );
  });
  try {
    assert.throws(() => check(d), /regular file/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("check rejects files directly under skills/ (the core 400s skills/<id>/<file> violations)", () => {
  const d = deployment((dir) => {
    writeSkill(dir, "greet", "name: greet\ndescription: g.");
    writeFileSync(join(dir, "sandbox", "skills", "README.md"), "stray\n");
  });
  try {
    assert.throws(() => check(d), /skills\/<id>\/<file>/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("check enforces the core API's 1 MB layer limit", () => {
  const d = deployment((dir) => {
    writeSkill(dir, "big", `name: big\ndescription: b.\n---\n${"x".repeat(1_100_000)}`);
  });
  try {
    assert.throws(() => check(d), /1 MB/);
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
});

test("egress accepts CIDR ranges, warns on /0, and still rejects URLs and paths", () => {
  const d = deployment((dir) => {
    writeTool(dir, "net-tool", {
      id: "net-tool",
      egress: ["api.example.com", "10.0.0.0/8", "2001:db8::/32", "0.0.0.0/0"],
    });
  });
  try {
    const { layer } = check(d);
    assert.ok(
      layer.warnings.some((warning) => warning.includes("0.0.0.0/0")),
      "broad /0 egress still warns",
    );
  } finally {
    rmSync(d.dir, { recursive: true, force: true });
  }
  const bad = deployment((dir) => {
    writeTool(dir, "url-tool", { id: "url-tool", egress: ["https://api.example.com", "example.com/path"] });
  });
  try {
    assert.throws(() => check(bad), /must name a host or a CIDR range/);
  } finally {
    rmSync(bad.dir, { recursive: true, force: true });
  }
});

test("a secretEnv alias colliding with another secret's delivery on the same workload fails config.secretEnv", () => {
  const collide = deployment(() => {}, {
    secretEnv: { core: { CORE_SIGNING_SECRET: "SOME_OTHER_NAME" } },
  });
  const folded = deployment(() => {}, {
    services: ["core", "slack"],
    secretEnv: { core: { SHARED_NAME: "STORE_A" }, slack: { SHARED_NAME: "STORE_B" } },
  });
  const benign = deployment(() => {}, {
    services: ["core", "slack"],
    secretEnv: { core: { EXTRA_API_KEY: "EXTRA_API_KEY" }, slack: { APPS_ALIAS: "EXTRA_API_KEY" } },
  });
  try {
    assert.throws(
      () => check(collide),
      /core would receive env CORE_SIGNING_SECRET from both CORE_SIGNING_SECRET and SOME_OTHER_NAME/,
    );
    assert.throws(() => check(folded), /core would receive env SHARED_NAME from both STORE_A and STORE_B/);
    check(benign);
  } finally {
    rmSync(collide.dir, { recursive: true, force: true });
    rmSync(folded.dir, { recursive: true, force: true });
    rmSync(benign.dir, { recursive: true, force: true });
  }
});

test("plaintext config env colliding with a secretEnv name (plain or alias) fails config.no-secret-values", () => {
  const plain = deployment(() => {}, {
    env: { core: { EXTRA_CDP_URL: "wss://plaintext.example" } },
    secretEnv: { core: { EXTRA_CDP_URL: "EXTRA_CDP_URL" } },
  });
  const aliased = deployment(() => {}, {
    env: { core: { APPS_SESSION_ALIAS: "plaintext" } },
    secretEnv: { core: { APPS_SESSION_ALIAS: "PORTAL_SESSION_SECRET" } },
  });
  try {
    assert.throws(() => check(plain), /core\.EXTRA_CDP_URL belongs in the target secret store/);
    assert.throws(() => check(aliased), /core\.APPS_SESSION_ALIAS belongs in the target secret store/);
  } finally {
    rmSync(plain.dir, { recursive: true, force: true });
    rmSync(aliased.dir, { recursive: true, force: true });
  }
});

test("a delivered secret name shadowing renderer-derived env fails config.secretEnv (aws target)", () => {
  const aws = {
    accountId: "123456789012",
    region: "us-west-2",
    cluster: "acme",
    imageLabel: "release",
    deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
    secretsPrefix: "acme/",
    networking: { cloudMapNamespace: "acme.internal" },
    services: { core: { ecrRepository: "qm-core", ecsService: "acme-core", cpu: 2048, memory: 4096 } },
  } as const;
  const base = { target: "aws" as const, aws, env: { core: { AWS_DEPLOY_IMAGE: "acme-sandbox" } } };
  const shadowed = deployment(() => {}, { ...base, secretEnv: { core: { S3_BUCKET: "SOME_SECRET_BUCKET_URL" } } });
  const overridden = deployment(() => {}, {
    ...base,
    env: { core: { AWS_DEPLOY_IMAGE: "acme-sandbox", S3_BUCKET: "adopted-bucket" } },
    secretEnv: { core: { S3_BUCKET: "SOME_SECRET_BUCKET_URL" } },
  });
  const benign = deployment(() => {}, { ...base, secretEnv: { core: { EXTRA_API_KEY: "EXTRA_API_KEY" } } });
  const dockerTarget = deployment(() => {}, { secretEnv: { core: { ORG_ID: "SOME_STORE_NAME" } } });
  try {
    assert.throws(
      () => check(shadowed),
      /core env S3_BUCKET is derived by the deployment target and cannot also be delivered as a secret/,
    );
    assert.throws(
      () => check(overridden),
      /core\.S3_BUCKET belongs in the target secret store|core env S3_BUCKET/,
      "a config-env override colliding with a delivered secret is still an error",
    );
    check(benign);
    check(dockerTarget);
  } finally {
    rmSync(shadowed.dir, { recursive: true, force: true });
    rmSync(overridden.dir, { recursive: true, force: true });
    rmSync(benign.dir, { recursive: true, force: true });
    rmSync(dockerTarget.dir, { recursive: true, force: true });
  }
});
