import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("core deploy image includes git", () => {
  const dockerfile = readFileSync(join(repoRoot, "deploy/core/Dockerfile"), "utf8");

  assert.match(
    dockerfile,
    /\bapk\s+add\b[\s\S]*\bgit\b/,
    "core hosts deployment git repos over git http-backend, which needs git in the image",
  );
  assert.match(
    dockerfile,
    /npm audit --omit=dev --audit-level=moderate/,
    "the production dependency threshold is a build gate",
  );
  assert.doesNotMatch(dockerfile, /patch-pi-shrinkwrap/, "the dependency layer should be lockfile-only");
  assert.match(
    dockerfile,
    /COPY cli\/templates\/slack-manifest\.json \.\/cli\/templates\/slack-manifest\.json/,
    "admin Slack setup needs the canonical manifest at runtime",
  );
  for (const line of dockerfile.split("\n").filter((candidate) => candidate.startsWith("COPY "))) {
    const sources = line.trim().split(/\s+/).slice(1, -1);
    for (const source of sources) {
      assert.equal(existsSync(join(repoRoot, source)), true, `core Dockerfile COPY source does not exist: ${source}`);
    }
  }
});

test("core deploy image installs verified Grok artifacts and system privacy requirements", () => {
  const dockerfile = readFileSync(join(repoRoot, "deploy/core/Dockerfile"), "utf8");
  const requirements = readFileSync(join(repoRoot, "deploy/core/grok-requirements.toml"), "utf8");

  assert.match(dockerfile, /ARG GROK_VERSION=1\.0\.13/);
  assert.match(dockerfile, /GROK_SHA256=edf79521581bb5e6b95abef848491a6a742e860da3e237ebe86a280d30dce4c1/);
  assert.match(dockerfile, /GROK_SHA256=b926fc5308374396e260e7efbd6107231a8dae13c084ddaf0fe89b7ebb3edd25/);
  assert.match(dockerfile, /https:\/\/x\.ai\/cli\/grok-\$\{GROK_VERSION\}-linux-\$\{GROK_ARCH\}/);
  assert.match(dockerfile, /install -m 0755 \/tmp\/grok \/usr\/local\/bin\/grok/);
  assert.match(dockerfile, /ARG GROK_LICENSE_REV=bb7f39d5858cbf5e00de639367f59debbdcb0138/);
  assert.match(dockerfile, /\/usr\/share\/licenses\/grok-build\/LICENSE/);
  assert.match(dockerfile, /\/usr\/share\/licenses\/grok-build\/THIRD-PARTY-NOTICES/);
  assert.match(dockerfile, /116f7778b9802e569b7fa3a532b17bd80eb13c67837def01eed093d4ea472f28/);
  assert.match(dockerfile, /27279bca974ef4cd2b1695ab8bb43be1a0e0c95d9bed9e4f19be064221546ef3/);
  assert.match(dockerfile, /d7b66d698b8ae78c31eaaa344acfe47092023fad0966b3474eb9a032da322527/);
  assert.match(dockerfile, /e8785a6098a7ee780cd2db35745b8e53061cfb1b6da19147a308579466ea4e50/);
  assert.match(dockerfile, /grok-linux-\$\{GROK_NPM_ARCH\}-\$\{GROK_VERSION\}\.tgz/);
  assert.match(dockerfile, /arm64\) GROK_ARCH=aarch64;/);
  assert.match(dockerfile, /@xai-official\/grok-linux-/);
  assert.match(dockerfile, /COPY deploy\/core\/grok-requirements\.toml \/etc\/grok\/requirements\.toml/);
  assert.match(dockerfile, /chown root:root \/etc\/grok\/requirements\.toml/);
  assert.match(dockerfile, /chmod 0644 \/etc\/grok\/requirements\.toml/);
  assert.equal(
    requirements,
    "fail_closed = true\n\n[cli]\nauto_update = false\n\n[features]\nfeedback = false\nremote_fetch = false\ntelemetry = false\n\n[subagents]\nenabled = false\n\n[telemetry]\notel_enabled = false\ntrace_upload = false\n\n[ui]\nyolo = false\n",
  );
});

test("Grok protocol dependencies are runtime-pinned without an npm launcher", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(manifest.dependencies?.["@agentclientprotocol/sdk"], "1.4.0");
  assert.equal(manifest.dependencies?.["@modelcontextprotocol/sdk"], "1.29.0");
  assert.equal(manifest.devDependencies?.["@modelcontextprotocol/sdk"], undefined);
  assert.ok(!Object.keys(manifest.dependencies ?? {}).some((name) => name.startsWith("@xai-official/grok")));
});
