import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAdminGrants } from "../src/admin/admin-service.ts";
import { MIN_SIGNING_SECRET_LENGTH } from "../src/auth/source-auth.ts";
import { isLoopsUser } from "../plugins/web-ui/server/index.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../scripts/dev/proof-stack.sh");
const BASE = "http://localhost:9303";
const PORTAL_SESSION_SECRET_FLOOR = 32;

const READY_ONCE_ALL_THREE_STARTED = [
  'while [ "$(wc -l <"$NODE_LOG")" -lt 3 ] && [ "$SECONDS" -lt 20 ]; do sleep 0.05; done',
  "exit 0",
];

type Run = { pid: string; entry: string; env: Record<string, string> };

type Stack = {
  root: string;
  script: string;
  env: NodeJS.ProcessEnv;
  runs: () => Run[];
  curlCalls: () => string[][];
  dockerRan: () => boolean;
  cleanup: () => void;
};

function writeStub(dir: string, name: string, lines: string[]): void {
  const path = join(dir, name);
  writeFileSync(path, ["#!/usr/bin/env bash", ...lines, ""].join("\n"));
  chmodSync(path, 0o755);
}

function parseEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

function stubStack(options: { node?: string[]; curl?: string[]; listeners?: string } = {}): Stack {
  const root = mkdtempSync(join(tmpdir(), "proof-stack-root-"));
  const bin = mkdtempSync(join(tmpdir(), "proof-stack-bin-"));
  const childEnvDir = join(bin, "child-env");
  const nodeLog = join(bin, "node.log");
  const curlLog = join(bin, "curl.log");
  const dockerLog = join(bin, "docker.log");
  const listeners = join(bin, "listeners");
  const logs = join(bin, "logs");
  mkdirSync(childEnvDir);
  mkdirSync(join(root, "scripts/dev"), { recursive: true });
  mkdirSync(join(root, "plugins/web-ui/dist-web"), { recursive: true });
  writeFileSync(join(root, "plugins/web-ui/dist-web/index.html"), "");
  copyFileSync(SCRIPT, join(root, "scripts/dev/proof-stack.sh"));
  writeFileSync(nodeLog, "");
  writeFileSync(curlLog, "");
  writeFileSync(listeners, options.listeners ?? "");
  writeStub(bin, "node", [
    `env >"$CHILD_ENV_DIR/$$.tmp"`,
    `mv "$CHILD_ENV_DIR/$$.tmp" "$CHILD_ENV_DIR/$$.env"`,
    `printf '%s\\t%s\\n' "$$" "$*" >>"$NODE_LOG"`,
    ...(options.node ?? ["exec sleep 300"]),
  ]);
  writeStub(bin, "curl", [
    `{ printf '%s\\n' "$@"; echo '==='; } >>"$CURL_LOG"`,
    ...(options.curl ?? READY_ONCE_ALL_THREE_STARTED),
  ]);
  writeStub(bin, "ss", [
    'query="$*"',
    'port="${query##*:}"',
    "while read -r listening pid; do",
    '  [ "$listening" = "$port" ] && echo "LISTEN 0 511 *:$port *:* users:((\\"node\\",pid=$pid,fd=21))"',
    'done <"$LISTENERS"',
    "exit 0",
  ]);
  writeStub(bin, "setsid", ['exec "$@"']);
  writeStub(bin, "docker", ['echo "$*" >>"$DOCKER_LOG"', "exit 1"]);
  const runs = (): Run[] =>
    readFileSync(nodeLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pid, entry] = line.split("\t");
        return { pid: pid!, entry: entry!, env: parseEnvFile(join(childEnvDir, `${pid}.env`)) };
      });
  return {
    root,
    script: join(root, "scripts/dev/proof-stack.sh"),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ANTHROPIC_API_KEY: "test-model-key",
      NODE_LOG: nodeLog,
      CHILD_ENV_DIR: childEnvDir,
      CURL_LOG: curlLog,
      DOCKER_LOG: dockerLog,
      LISTENERS: listeners,
      PROOF_STACK_LOGS: logs,
    },
    runs,
    curlCalls: () => {
      const calls: string[][] = [];
      let current: string[] = [];
      for (const line of readFileSync(curlLog, "utf8").split("\n")) {
        if (line === "===") {
          calls.push(current);
          current = [];
        } else current.push(line);
      }
      return calls;
    },
    dockerRan: () => existsSync(dockerLog),
    cleanup: () => {
      const pids = runs().map((run) => run.pid);
      if (pids.length) spawnSync("kill", ["-9", ...pids]);
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    },
  };
}

function runUp(stack: Stack, env: NodeJS.ProcessEnv = stack.env): SpawnSyncReturns<string> {
  return spawnSync("bash", [stack.script, "up"], {
    encoding: "utf8",
    env,
    timeout: 45_000,
    killSignal: "SIGKILL",
  });
}

test("proof-stack.sh parses as bash", () => {
  const checked = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});

test("url prints only the portal base URL and any other subcommand refuses", () => {
  const url = spawnSync("bash", [SCRIPT, "url"], { encoding: "utf8" });
  assert.equal(url.status, 0, url.stderr);
  assert.equal(url.stdout, `${BASE}\n`);
  assert.equal(url.stderr, "");
  for (const argv of [[SCRIPT], [SCRIPT, "down"]]) {
    const refused = spawnSync("bash", argv, { encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /usage: proof-stack\.sh up\|url/);
  }
});

test("up boots core, the web UI, and the portal with no docker, then seeds one demo loop", () => {
  const stack = stubStack();
  try {
    const result = runUp(stack);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const runs = stack.runs();
    const core = runs.find((run) => run.entry === "src/index.ts");
    const web = runs.find((run) => run.entry === "plugins/web-ui/server/index.ts");
    const portal = runs.find((run) => run.entry === "plugins/portal/src/index.ts");
    assert.ok(core && web && portal, `started: ${runs.map((run) => run.entry).join(", ")}`);
    assert.equal(runs.length, 3);
    assert.equal(stack.dockerRan(), false);

    assert.equal(portal.env.PORT, new URL(BASE).port);
    assert.equal(portal.env.PORTAL_PUBLIC_URL, BASE);
    assert.equal(web.env.PORT, new URL(portal.env.WEB_UI_UPSTREAM!).port);
    assert.equal(core.env.PORT, new URL(portal.env.CORE_API_URL!).port);
    assert.equal(core.env.PORT, new URL(web.env.CORE_API_URL!).port);

    const principal = portal.env.PORTAL_DEV_PRINCIPAL!;
    assert.ok(isLoopsUser(principal, web.env.LOOPS_USERS));
    assert.ok(
      parseAdminGrants(core.env.ADMIN_GRANTS, core.env.ORG_ID!)?.some(
        (grant) => grant.principalId === principal && grant.role === "org_admin",
      ),
    );

    assert.equal(new Set(runs.map((run) => run.env.CORE_SIGNING_SECRET)).size, 1);
    assert.ok(core.env.CORE_SIGNING_SECRET!.length >= MIN_SIGNING_SECRET_LENGTH);
    assert.ok(portal.env.PORTAL_SESSION_SECRET!.length >= PORTAL_SESSION_SECRET_FLOOR);
    assert.notEqual(portal.env.PORTAL_SESSION_SECRET, portal.env.CORE_SIGNING_SECRET);

    const calls = stack.curlCalls();
    assert.ok(calls[0]!.includes(`${BASE}/api/loops`), `readiness probe: ${calls[0]!.join(" ")}`);
    const seed = calls.find((call) => call.includes("POST"));
    assert.ok(seed, "the demo loop was seeded");
    assert.ok(seed.includes(`${BASE}/api/loops`));
    assert.ok(seed.includes(`Origin: ${BASE}`));
    assert.ok(seed.includes("Sec-Fetch-Site: same-origin"));
    const body = JSON.parse(seed[seed.indexOf("-d") + 1]!);
    assert.ok(body.name.trim() && body.playbook.trim() && body.successCondition.trim());
    assert.deepEqual(body.shipActions, [{ action: "open_pr", gate: "auto" }]);
  } finally {
    stack.cleanup();
  }
});

test("up frees the ports it needs and leaves every other process alone", async () => {
  const holder = spawn("sleep", ["120"], { stdio: "ignore" });
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], { stdio: "ignore" });
  const stack = stubStack({ listeners: `9302 ${holder.pid}\n` });
  try {
    const result = runUp(stack);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const [, signal] = await once(holder, "exit", { signal: AbortSignal.timeout(10_000) });
    assert.equal(signal, "SIGTERM");
    assert.equal(bystander.exitCode, null);
    assert.equal(bystander.signalCode, null);
  } finally {
    holder.kill("SIGKILL");
    bystander.kill("SIGKILL");
    stack.cleanup();
  }
});

test("up refuses before starting anything when the web build or the model key is missing", () => {
  for (const broken of ["dist-web", "model-key"] as const) {
    const stack = stubStack();
    const env = { ...stack.env };
    try {
      if (broken === "dist-web") rmSync(join(stack.root, "plugins/web-ui/dist-web"), { recursive: true });
      else delete env.ANTHROPIC_API_KEY;
      const result = runUp(stack, env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, broken === "dist-web" ? /dist-web/ : /ANTHROPIC_API_KEY/);
      assert.deepEqual(stack.runs(), []);
      assert.deepEqual(stack.curlCalls(), []);
    } finally {
      stack.cleanup();
    }
  }
});

test("up fails with the child log when a stack process exits before the portal answers", () => {
  const marker = "proof-stack-boot-failure";
  const stack = stubStack({ node: [`echo ${marker}`, "exit 1"], curl: ["exit 7"] });
  try {
    const result = runUp(stack);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exited/);
    assert.match(result.stderr, new RegExp(marker));
  } finally {
    stack.cleanup();
  }
});
