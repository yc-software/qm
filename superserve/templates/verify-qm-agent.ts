#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Sandbox } from "@superserve/sdk";
import { shq } from "../../src/util/shell.ts";
import { requireRelease, findTemplateByName, fmtMs, resolveConnection, templateNameForRelease } from "./common.ts";

const EXPECTED_TOOLS = [
  "sh",
  "bash",
  "git",
  "curl",
  "wget",
  "jq",
  "tar",
  "xz",
  "unzip",
  "timeout",
  "ssh",
  "python3",
  "pip",
  "node",
  "npm",
  "claude",
  "codex",
  "gh",
  "aws",
  "x-api",
];

const VERSION_COMMANDS: Record<string, string> = {
  node: "node --version",
  npm: "npm --version",
  python3: "python3 --version",
  "agent-venv python": "/opt/agent-venv/bin/python --version",
  "agent-venv pip": "/opt/agent-venv/bin/pip --version",
  "python (PATH)": "python --version",
  "pip (PATH)": "pip --version",
  claude: "claude --version",
  codex: "codex --version",
  gh: "gh --version",
  aws: "aws --version",
  git: "git --version",
};

const SANDBOX_TIMEOUT_SECONDS = 300;
const RELEASE_DEADLINE_MS = 15_000;
const KEEP_AUTO_DELETE_SECONDS = 3_600;
const SIGNALS = ["SIGINT", "SIGTERM"] as const;
const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

interface Args {
  template: string;
  keep: boolean;
  baseUrl?: string;
}

function parseCli(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv,
    options: {
      release: { type: "string" },
      template: { type: "string" },
      keep: { type: "boolean", default: false },
      "base-url": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      [
        "usage: node superserve/templates/verify-qm-agent.ts [--release <qm-release> | --template <name>] [--keep] [--base-url <url>]",
        "env:   SUPERSERVE_API_KEY (required), SUPERSERVE_BASE_URL (optional)",
      ].join("\n"),
    );
    process.exit(0);
  }
  return {
    template: values.template ?? templateNameForRelease(requireRelease(values.release)),
    keep: values.keep,
    ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
  };
}

async function run(sandbox: Sandbox, script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const r = await sandbox.commands.run(`timeout 120 sh -c ${shq(script)}`, { timeoutMs: 150_000 });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));
  const conn = resolveConnection(args.baseUrl);
  const failures: string[] = [];
  const fail = (msg: string): void => {
    failures.push(msg);
    console.log(`FAIL ${msg}`);
  };

  const template = await findTemplateByName(args.template, conn);
  if (!template) throw new Error(`template ${args.template} not found (build it with qm-agent.ts first)`);
  if (template.status !== "ready") throw new Error(`template ${args.template} is ${template.status}, not ready`);
  const sandboxName = `qm-agent-verify-${Date.now().toString(36)}`;
  console.log(
    `[verify] template=${template.name} id=${template.id} sandbox=${sandboxName}${conn.baseUrl ? ` api=${conn.baseUrl}` : ""}`,
  );

  const t0 = Date.now();
  const creating = Sandbox.create({
    ...conn,
    name: sandboxName,
    fromTemplate: { id: template.id, name: template.name },
    metadata: { qm_kind: "verify", qm_template: args.template },
    timeoutSeconds: SANDBOX_TIMEOUT_SECONDS,
    autoDeleteSeconds: args.keep ? KEEP_AUTO_DELETE_SECONDS : 0,
  });

  const releaseOnce = async (): Promise<void> => {
    const created = await creating.catch(() => undefined);
    if (!created) return;
    if (args.keep) {
      console.log(
        `[verify] keeping sandbox ${created.id} (--keep; auto-deletes ${KEEP_AUTO_DELETE_SECONDS}s after it pauses)`,
      );
      return;
    }
    try {
      await created.kill();
      console.log(`[verify] killed sandbox ${created.id}`);
    } catch (e: unknown) {
      fail(
        `could not kill sandbox ${created.id}: ${e instanceof Error ? e.message : String(e)}; ` +
          "it is deleted as soon as it pauses",
      );
    }
  };
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => (releasing ??= releaseOnce());
  const onSignal = (signal: NodeJS.Signals): void => {
    console.error(`[verify] ${signal} received; releasing sandbox ${sandboxName}`);
    void Promise.race([release(), sleep(RELEASE_DEADLINE_MS)]).then(() => process.exit(SIGNAL_EXIT_CODES[signal] ?? 1));
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);

  const sandbox = await creating;
  const tCreated = Date.now();

  try {
    const first = await sandbox.commands.run("true", { timeoutMs: 60_000 });
    const tFirst = Date.now();
    console.log(
      `[verify] sandbox=${sandbox.id} create=${fmtMs(tCreated - t0)} first-exec=${fmtMs(tFirst - tCreated)} ` +
        `cold-boot-to-first-exec=${fmtMs(tFirst - t0)} (exit=${first.exitCode})`,
    );
    if (first.exitCode !== 0) fail(`first exec exited ${first.exitCode}: ${first.stderr.trim()}`);

    console.log("--- environment ---");
    const env = await run(
      sandbox,
      'printf "HOME=%s\\nUSER=%s\\nwhoami=%s\\nuname=%s\\npwd=%s\\nPATH=%s\\nVIRTUAL_ENV=%s\\n" "${HOME:-}" "${USER:-}" "$(whoami)" "$(uname -a)" "$(pwd)" "$PATH" "${VIRTUAL_ENV:-}"',
    );
    process.stdout.write(env.stdout);
    if (env.exitCode !== 0) fail(`environment probe exited ${env.exitCode}: ${env.stderr.trim()}`);
    const home = /^HOME=(.*)$/m.exec(env.stdout)?.[1] ?? "";
    if (!home.startsWith("/")) fail(`$HOME is not set for the login user (got ${JSON.stringify(home)})`);
    const whoami = /^whoami=(.*)$/m.exec(env.stdout)?.[1] ?? "";
    if (whoami.trim() !== "root") {
      fail(`expected the template to run as root; got whoami=${JSON.stringify(whoami)}`);
    }
    const workspaceOk = await run(sandbox, 'test -d "/root/workspace" && test -w "/root/workspace" && echo writable');
    console.log(`/root/workspace exists and is writable: ${workspaceOk.stdout.trim() === "writable" ? "yes" : "no"}`);
    if (workspaceOk.stdout.trim() !== "writable") {
      fail("/root/workspace is missing or not writable");
    }

    console.log("--- tool inventory ---");
    const inv = await run(
      sandbox,
      `for t in ${EXPECTED_TOOLS.join(" ")}; do if p=$(command -v "$t" 2>/dev/null); then echo "ok $t $p"; else echo "missing $t"; fi; done`,
    );
    process.stdout.write(inv.stdout);
    for (const tool of EXPECTED_TOOLS) {
      if (!new RegExp(`^ok ${tool} `, "m").test(inv.stdout)) fail(`missing tool: ${tool}`);
    }

    console.log("--- versions ---");
    for (const [label, cmd] of Object.entries(VERSION_COMMANDS)) {
      const r = await run(sandbox, cmd);
      const out = (r.stdout.trim() || r.stderr.trim()).split("\n")[0] ?? "";
      console.log(`${r.exitCode === 0 ? "ok" : "err"} ${label}: ${out}`);
      if (r.exitCode !== 0) fail(`${label}: ${cmd} exited ${r.exitCode}`);
    }

    console.log("--- backend exec shape ---");
    const to = await run(sandbox, "timeout 2 sh -c 'sleep 5'; echo exit=$?");
    console.log(`timeout kills a long command: ${to.stdout.trim()} (expect exit=124)`);
    if (!to.stdout.includes("exit=124")) fail("timeout(1) did not terminate the command with exit 124");
    const venv = await run(sandbox, "command -v python && python -c 'import sys; print(sys.prefix)'");
    console.log(`venv on PATH: ${venv.stdout.trim().replace(/\n/g, " ")}`);
    if (!venv.stdout.includes("/opt/agent-venv")) fail("/opt/agent-venv is not the default python on PATH");
    const pip = await run(sandbox, "pip --version");
    console.log(`pip on PATH: ${pip.stdout.trim()}`);
    if (!pip.stdout.includes("/opt/agent-venv")) fail("pip on PATH is not the /opt/agent-venv pip");
  } finally {
    await release();
    for (const signal of SIGNALS) process.off(signal, onSignal);
  }

  if (failures.length) {
    console.log(`[verify] FAILED: ${failures.length} problem(s)`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`[verify] OK: ${EXPECTED_TOOLS.length} tools present`);
  }
}

main().catch((e: unknown) => {
  console.error(`[verify] ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
