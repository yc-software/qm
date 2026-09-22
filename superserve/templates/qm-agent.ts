#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BuildError, Template, type BuildStep, type TemplateInfo } from "@superserve/sdk";
import {
  REPO_ROOT,
  requireRelease,
  findTemplateByName,
  fmtMs,
  resolveConnection,
  templateNameForRelease,
} from "./common.ts";

const CLAUDE_CODE_VERSION = "2.1.210";
const CODEX_VERSION = "0.144.4";
const GH_VERSION = "2.93.0";
const GH_SHA256_AMD64 = "02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0";
const AWSCLI_VERSION = "2.34.54";
const AWSCLI_SHA256_X86_64 = "de278754dec97e0f6e9b4e8167d4bd1a27004c3e56e9c2da10002597f76ca35a";
const NODE_VERSION = "24.18.0";
const NODE_SHA256_X64 = "55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742";
const AGENT_VENV = "/opt/agent-venv";
const BASE_IMAGE = "ubuntu:24.04";

const DEFAULT_VCPU = 8;
const DEFAULT_MEMORY_MIB = 16384;
const DEFAULT_DISK_MIB = 32768;

const APT_PACKAGES = [
  "bash",
  "coreutils",
  "findutils",
  "grep",
  "sed",
  "gawk",
  "git",
  "curl",
  "wget",
  "jq",
  "unzip",
  "tar",
  "xz-utils",
  "openssh-client",
  "python3",
  "python3-venv",
  "python3-pip",
  "ca-certificates",
  "gnupg",
];

function sh(lines: string[]): string {
  return ["set -eu", ...lines].join("\n");
}

function buildSteps(): BuildStep[] {
  const xApi = readFileSync(join(REPO_ROOT, "fly", "tools", "x-api"), "utf8");
  if (xApi.includes("\nQM_X_API_EOF\n")) throw new Error("x-api contains the heredoc delimiter");
  return [
    { env: { key: "DEBIAN_FRONTEND", value: "noninteractive" } },
    {
      run: sh([
        "apt-get update",
        `apt-get install -y --no-install-recommends ${APT_PACKAGES.join(" ")}`,
        "rm -rf /var/lib/apt/lists/*",
      ]),
    },
    {
      run: sh([
        `curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz`,
        `echo "${NODE_SHA256_X64}  /tmp/node.tar.xz" | sha256sum -c -`,
        "tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner" +
          " --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md",
        "rm -f /tmp/node.tar.xz",
        "node --version",
        "npm --version",
      ]),
    },
    {
      run: sh([
        "npm install -g --allow-scripts=@anthropic-ai/claude-code" +
          ` @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION}`,
        "npm cache clean --force",
        "claude --version",
        "codex --version",
      ]),
    },
    {
      run: sh([
        `curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tgz`,
        `echo "${GH_SHA256_AMD64}  /tmp/gh.tgz" | sha256sum -c -`,
        "tar xzf /tmp/gh.tgz -C /tmp",
        `install "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh`,
        "rm -rf /tmp/gh*",
        "gh --version",
        "rm -rf /root/.local/state/gh",
      ]),
    },
    {
      run: sh([
        `curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip" -o /tmp/awscliv2.zip`,
        `echo "${AWSCLI_SHA256_X86_64}  /tmp/awscliv2.zip" | sha256sum -c -`,
        "unzip -q /tmp/awscliv2.zip -d /tmp",
        "/tmp/aws/install",
        "rm -rf /tmp/aws /tmp/awscliv2.zip",
        "aws --version",
      ]),
    },
    {
      run: sh([
        `python3 -m venv ${AGENT_VENV}`,
        `${AGENT_VENV}/bin/pip install --no-cache-dir --upgrade pip`,
        `${AGENT_VENV}/bin/python --version`,
      ]),
    },
    {
      run: sh([
        "for t in python python3 pip pip3; do",
        `  printf '#!/bin/sh\\nexec ${AGENT_VENV}/bin/%s "$@"\\n' "$t" > "/usr/local/bin/$t"`,
        '  chmod +x "/usr/local/bin/$t"',
        "done",
        `/usr/local/bin/python -c 'import sys; print(sys.prefix)' | grep -qx ${AGENT_VENV}`,
        "/usr/local/bin/pip --version",
      ]),
    },
    { env: { key: "VIRTUAL_ENV", value: AGENT_VENV } },
    { env: { key: "PATH", value: `${AGENT_VENV}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` } },
    {
      run: sh([
        "cat > /usr/local/bin/x-api <<'QM_X_API_EOF'",
        xApi.replace(/\n$/, ""),
        "QM_X_API_EOF",
        "chmod +x /usr/local/bin/x-api",
      ]),
    },
    { workdir: "/root/workspace" },
  ];
}

interface Args {
  release: string;
  wait: boolean;
  force: boolean;
  baseUrl?: string;
  vcpu: number;
  memoryMib: number;
  diskMib: number;
}

function parseCli(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv,
    options: {
      release: { type: "string" },
      wait: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "base-url": { type: "string" },
      vcpu: { type: "string" },
      "memory-mib": { type: "string" },
      "disk-mib": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      [
        "usage: node superserve/templates/qm-agent.ts --release <qm-release> [--wait] [--force]",
        "         [--base-url <url>] [--vcpu N] [--memory-mib N] [--disk-mib N]",
        "env:   SUPERSERVE_API_KEY (required), SUPERSERVE_BASE_URL (optional)",
      ].join("\n"),
    );
    process.exit(0);
  }
  const num = (flag: string, raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${flag} must be a positive integer`);
    return n;
  };
  return {
    release: requireRelease(values.release),
    wait: values.wait,
    force: values.force,
    ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
    vcpu: num("vcpu", values.vcpu, DEFAULT_VCPU),
    memoryMib: num("memory-mib", values["memory-mib"], DEFAULT_MEMORY_MIB),
    diskMib: num("disk-mib", values["disk-mib"], DEFAULT_DISK_MIB),
  };
}

function describe(info: TemplateInfo | Template): string {
  const size = info.sizeBytes ? ` size=${(info.sizeBytes / 1024 / 1024).toFixed(0)}MiB` : "";
  return `${info.name} id=${info.id} status=${info.status} shape=${info.vcpu}vcpu/${info.memoryMib}MiB/${info.diskMib}MiB${size}`;
}

async function findExisting(name: string, conn: ReturnType<typeof resolveConnection>): Promise<Template | undefined> {
  const info = await findTemplateByName(name, conn);
  return info ? Template.connect(info.id, conn) : undefined;
}

async function waitForBuild(template: Template): Promise<TemplateInfo> {
  const started = Date.now();
  const info = await template.waitUntilReady({
    onLog: (ev) => {
      const text = ev.text.replace(/\n$/, "");
      if (text) console.log(`[build:${ev.stream}] ${text}`);
    },
  });
  console.log(`[qm-agent] build finished in ${fmtMs(Date.now() - started)}`);
  return info;
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const conn = resolveConnection(args.baseUrl);
  const name = templateNameForRelease(args.release);
  console.log(`[qm-agent] template=${name} base=${BASE_IMAGE}${conn.baseUrl ? ` api=${conn.baseUrl}` : ""}`);

  const existing = await findExisting(name, conn);
  if (existing) {
    if (existing.status === "ready" && !args.force) {
      console.log(`[qm-agent] already ready: ${describe(existing)}`);
      return;
    }
    if (existing.status === "pending" || existing.status === "building") {
      if (!args.force) {
        console.log(`[qm-agent] build in progress: ${describe(existing)}`);
        if (args.wait) console.log(`[qm-agent] ready: ${describe(await waitForBuild(existing))}`);
        return;
      }
      if (existing.latestBuildId) await existing.cancelBuild(existing.latestBuildId).catch(() => undefined);
    }
    console.log(`[qm-agent] deleting existing template (${existing.status}${args.force ? ", --force" : ""})`);
    await existing.delete();
  }

  const template = await Template.create({
    ...conn,
    name,
    from: BASE_IMAGE,
    vcpu: args.vcpu,
    memoryMib: args.memoryMib,
    diskMib: args.diskMib,
    steps: buildSteps(),
  });
  console.log(`[qm-agent] build queued: ${describe(template)} build=${template.latestBuildId ?? "?"}`);
  if (!args.wait) {
    console.log(`[qm-agent] re-run with --wait to block on the build, or verify later with verify-qm-agent.ts`);
    return;
  }
  const info = await waitForBuild(template);
  console.log(`[qm-agent] ready: ${describe(info)}`);
}

main().catch((e: unknown) => {
  if (e instanceof BuildError) {
    console.error(`[qm-agent] build failed (${e.code}) build=${e.buildId}: ${e.message}`);
  } else {
    console.error(`[qm-agent] ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exitCode = 1;
});
