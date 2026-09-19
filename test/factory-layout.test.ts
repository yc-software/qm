import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const factoryRoot = join(repoRoot, "factory");

const WRAP_REL = ".claude/io-coding-agent-js.sh";
const BAS_REL = ".claude/workflows/work-ticket-build-and-ship.js";
const ORCH_REL = ".claude/workflows/work-ticket-orchestrator.js";
const UND_REL = ".claude/workflows/work-ticket-understand.js";

const SHELL_FILES = [
  WRAP_REL,
  "tools/factory/converge-vector.sh",
  "tools/factory/proof.sh",
  "tools/factory/publish.sh",
  "tools/factory/source.sh",
  "tools/factory/tools.sh",
  "tools/factory/verify.sh",
];

const MOVED_FILES = [
  WRAP_REL,
  ".claude/commands/review_plan.md",
  ".claude/skills/add-tests/SKILL.md",
  ".claude/workflows/prompts/contract-fidelity.md",
  BAS_REL,
  ORCH_REL,
  UND_REL,
  "tools/factory/converge-vector.sh",
  "tools/factory/proof.sh",
  "tools/factory/publish.sh",
  "tools/factory/source.sh",
  "tools/factory/tools.sh",
  "tools/factory/verify.sh",
];

const COPIED_WORKFLOWS = ["work-ticket-orchestrator.js", "work-ticket-understand.js", "work-ticket-build-and-ship.js"];

const BOOKFACE_HOST = /bookface\.ycombinator\.com/g;
const MONOREPO_PROJECT = /yc-software\/code/g;

const PATH_ONLY = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

function factoryFile(relative: string): string {
  const absolute = join(factoryRoot, relative);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
}

const WRAP = factoryFile(WRAP_REL);
const BAS = factoryFile(BAS_REL);
const ORCH = factoryFile(ORCH_REL);
const UND = factoryFile(UND_REL);

function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]!);
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

function sliceFunction(name: string): string {
  const sed = spawnSync("sed", ["-n", `/^${name}() {/,/^}/p`, join(factoryRoot, WRAP_REL)], {
    encoding: "utf8",
    env: PATH_ONLY,
  });
  assert.equal(sed.status, 0, `sed failed while slicing ${name} out of ${WRAP_REL}`);
  assert.ok(sed.stdout.startsWith(`${name}() {`), `${name} is not defined at column 0 in ${WRAP_REL}`);
  assert.ok(sed.stdout.trimEnd().endsWith("\n}"), `the slice of ${name} does not end at its closing brace`);
  return sed.stdout;
}

type Run = (script: string, env: Record<string, string>) => { status: number | null; stdout: string; stderr: string };

function withHarness(names: string[], body: (dir: string, run: Run) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "qm-factory-"));
  try {
    const lib = join(dir, "slices.sh");
    writeFileSync(lib, names.map(sliceFunction).join("\n"));
    const run: Run = (script, env) => {
      const result = spawnSync("bash", ["-c", `. ${JSON.stringify(lib)}\n${script}`], {
        cwd: dir,
        encoding: "utf8",
        env: { ...PATH_ONLY, ...env },
        timeout: 10_000,
      });
      assert.equal(
        result.error,
        undefined,
        `the slice of ${names.join(", ")} did not finish: ${result.error?.message}`,
      );
      return result as ReturnType<Run>;
    };
    body(dir, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the thirteen factory files exist under factory/ as regular files", () => {
  for (const relative of MOVED_FILES) {
    const absolute = join(factoryRoot, relative);
    assert.ok(existsSync(absolute), `factory/${relative} is missing`);
    assert.ok(statSync(absolute).isFile(), `factory/${relative} is not a regular file`);
  }
});

test("the wrapper and the seven tools/factory scripts stay executable", () => {
  for (const relative of SHELL_FILES) {
    const mode = statSync(join(factoryRoot, relative)).mode;
    assert.notEqual(mode & 0o100, 0, `factory/${relative} lost its owner-execute bit`);
  }
});

test("every moved shell script parses", () => {
  for (const relative of SHELL_FILES) {
    const parsed = spawnSync("bash", ["-n", join(factoryRoot, relative)], {
      encoding: "utf8",
      env: PATH_ONLY,
    });
    assert.equal(parsed.status, 0, `bash -n rejected factory/${relative}: ${parsed.stderr}`);
  }
});

// The factory ships in a public product, so nothing from the private monorepo it was carved out of may remain.
const MONOREPO_LITERALS: RegExp[] = [
  BOOKFACE_HOST,
  MONOREPO_PROJECT,
  /bookface|ycinternal/gi,
  /yc-software/g,
  /\bpcap\b/g,
  /Investment Ops/g,
  /ycdev|devbox|Conductor/g,
  /yc start|yc stacks/g,
  /rubocop|sorbet|\bRBI\b/g,
  /proof-fonts|APP_RAILS|KNOWN_APPS|detectTargetApps|startStackIfDown/g,
  /IO-<|IO-\[0-9/g,
  /39661509|39376855|32942080/g,
];

test("no file under factory/ carries a monorepo literal", () => {
  for (const absolute of walk(factoryRoot)) {
    const text = readFileSync(absolute, "utf8");
    for (const pattern of MONOREPO_LITERALS) {
      assert.equal(count(text, pattern), 0, `${absolute} still matches ${pattern}`);
    }
  }
});

test("the conflict concierge workflow was not moved", () => {
  assert.equal(
    existsSync(join(factoryRoot, ".claude/workflows/work-ticket-resolve-conflict.js")),
    false,
    "work-ticket-resolve-conflict.js is not part of this factory",
  );
});

test("factory/README.md is at most ten lines", () => {
  const readme = join(factoryRoot, "README.md");
  assert.ok(existsSync(readme), "factory/README.md is missing");
  assert.ok(
    readFileSync(readme, "utf8").trimEnd().split("\n").length <= 10,
    "factory/README.md is longer than ten lines",
  );
});

test("every prompt that can write tests interpolates the test-economy rules", () => {
  for (const label of ["feedback-revise", "implement", "add-tests"]) {
    const end = BAS.indexOf(`{ label: '${label}' }`);
    assert.notEqual(end, -1, `no agent call labelled ${label} in ${BAS_REL}`);
    const start = BAS.lastIndexOf("agent(`", end);
    assert.ok(start !== -1 && start < end, `the ${label} prompt is not an inline agent(\`…\`) literal`);
    const prompt = BAS.slice(start, end);
    assert.ok(
      !prompt.includes("{ label:"),
      `the ${label} prompt slice spans another agent call — the back-scan mis-attached`,
    );
    for (const rule of ["${TEST_QUALITY_RULES}", "${TEST_HOWTO}"]) {
      assert.ok(prompt.includes(rule), `the ${label} prompt does not interpolate ${rule}`);
    }
  }
});

const handshakeTokens = [
  ...captures(WRAP, /\.project == "([^"]*)"/g),
  ...captures(BAS, /\.project == "([^"]*)"/g),
  ...captures(BAS, /project:"([^"]*)"/g),
  ...captures(BAS, /project: '([^']*)'/g),
];

test("all eight handshake sites carry one deployment-neutral token", () => {
  assert.equal(
    captures(WRAP, /\.project == "([^"]*)"/g).length,
    3,
    "the wrapper no longer has exactly three jq handshake readers",
  );
  assert.equal(
    captures(BAS, /\.project == "([^"]*)"/g).length,
    1,
    "build-and-ship no longer has exactly one jq journal reader",
  );
  assert.equal(
    captures(BAS, /project:"([^"]*)"/g).length,
    3,
    "build-and-ship no longer has exactly three jq handshake writers",
  );
  assert.equal(
    captures(BAS, /project: '([^']*)'/g).length,
    1,
    "build-and-ship no longer has exactly one JS handshake writer",
  );
  assert.equal(handshakeTokens.length, 8, "the handshake is not eight sites");
  assert.equal(
    new Set(handshakeTokens).size,
    1,
    `the handshake desynchronised across ${JSON.stringify(handshakeTokens)}`,
  );
  const token = handshakeTokens[0]!;
  assert.notEqual(token, "yc-software/code", "the handshake still carries the monorepo literal");
  assert.notEqual(token, "", "the handshake token is empty, which would accept every result");
  assert.match(token, /^[A-Za-z0-9._-]+$/, `the handshake token ${JSON.stringify(token)} is not a literal constant`);
});

const TOKEN = handshakeTokens[0] ?? "";

test("no handshake value travels between the wrapper and the workflows", () => {
  for (const [relative, text] of [
    [WRAP_REL, WRAP],
    [BAS_REL, BAS],
    [ORCH_REL, ORCH],
    [UND_REL, UND],
  ] as const) {
    assert.equal(
      count(text, /publishProject/g),
      0,
      `factory/${relative} threads a handshake project through publishProject`,
    );
  }
  for (const [relative, text] of [
    [BAS_REL, BAS],
    [ORCH_REL, ORCH],
    [UND_REL, UND],
  ] as const) {
    assert.equal(
      count(text, /process\.env/g),
      0,
      `factory/${relative} reads process.env, which the workflow sandbox does not carry`,
    );
    assert.equal(
      count(text, /globalThis/g),
      0,
      `factory/${relative} reads globalThis, which the workflow sandbox does not carry`,
    );
  }
});

const BRANCH = "factory-branch-1";
const NONCE = "0123456789abcdef0123456789abcdef";
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const SESSION = 42;
const MR_IID = 7;
const TICKET = "QM-30";
const WORK_DIR = ".io-agent-qm30";
const REPO = "/workspace/synthetic-repo";
const CONTROL_PLANE = "/tmp/io-factory-control-plane.synthetic";

const CONVERGE_ARGS = {
  ticketId: TICKET,
  prompt: "ship the change",
  approach: "",
  workDir: WORK_DIR,
  orchestrated: true,
  notifySlack: false,
  slackThread: "",
  factoryControlPlaneDir: CONTROL_PLANE,
  factoryProtocol: 2,
  factorySessionId: SESSION,
  factoryBranch: BRANCH,
};

const JQ_WRITERS = captures(BAS, /'(\{project:"[^']*\})'/g);

function writerFor(program: string, project: string): string {
  const needle = `project:"${TOKEN}"`;
  assert.ok(program.includes(needle), "a build-and-ship jq writer no longer carries the handshake token");
  return program.replace(needle, `project:${JSON.stringify(project)}`);
}

function runWriter(program: string, args: string[]): string {
  const written = spawnSync("jq", ["-cn", ...args, program], {
    encoding: "utf8",
    env: PATH_ONLY,
  });
  assert.equal(written.status, 0, `a build-and-ship jq writer did not run: ${written.stderr}`);
  return written.stdout.trim();
}

function journalFor(project: string): string {
  return runWriter(writerFor(JQ_WRITERS[0] ?? "", project), [
    "--argjson",
    "protocol",
    "2",
    "--argjson",
    "session",
    String(SESSION),
    "--arg",
    "branch",
    BRANCH,
    "--arg",
    "nonce",
    NONCE,
    "--argjson",
    "args",
    JSON.stringify(CONVERGE_ARGS),
  ]);
}

function envelopeFor(project: string): string {
  return runWriter(writerFor(JQ_WRITERS[1] ?? "", project), [
    "--argjson",
    "protocol",
    "2",
    "--argjson",
    "session",
    String(SESSION),
    "--argjson",
    "mr",
    String(MR_IID),
    "--arg",
    "br",
    BRANCH,
    "--arg",
    "nonce",
    NONCE,
    "--arg",
    "tid",
    TICKET,
    "--arg",
    "head",
    HEAD,
    "--argjson",
    "slack",
    "{}",
    "--argjson",
    "ship_trail",
    "[]",
    "--argjson",
    "args",
    JSON.stringify(CONVERGE_ARGS),
  ]);
}

function resultFor(project: string): string {
  return JSON.stringify({
    project,
    protocol: 2,
    session_id: SESSION,
    mr_iid: MR_IID,
    branch: BRANCH,
    source_branch: BRANCH,
    nonce: NONCE,
    ticket_id: TICKET,
    slack: { last_phase_ts: "", last_phase_dm_ts: "", last_phase_name: "" },
    args: CONVERGE_ARGS,
  });
}

function writePublishStub(dir: string): string {
  const captured = JSON.stringify([
    {
      id: MR_IID,
      branch: BRANCH,
      sha: HEAD,
      description: `Synthetic MR body\n<!-- factory-session:2:${SESSION}:${NONCE} -->`,
    },
  ]);
  const stub = join(dir, "publish-stub.sh");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash\n[ "$1" = "lookup-captured" ] || exit 1\ncat <<'STUB'\nIO_PUBLISH_JSON='${captured}'; IO_PUBLISH_RC=0\nSTUB\n`,
  );
  chmodSync(stub, 0o700);
  return stub;
}

test("a loop-launched run derives its identity from IO_FACTORY_SESSION_ID when there is no ECS session", () => {
  withHarness(["derive_factory_run_identity"], (_dir, run) => {
    const probe =
      'TICKET_ID="$TICKET_ID"; if derive_factory_run_identity; then echo "ok $IO_FACTORY_SESSION_ID $IO_FACTORY_BRANCH loop=${IO_FACTORY_LOOP_LAUNCHED:-}"; else echo "refused"; fi';
    const minted = run(probe, {
      TICKET_ID: "QM-1",
      IO_FACTORY_LAUNCH_SESSION_ID: "42",
    });
    assert.equal(minted.stdout.trim(), "ok 42 qm-1-s42 loop=1");
    const ecs = run(probe, {
      TICKET_ID: "QM-1",
      CODING_AGENT_SESSION_URL: "https://internal.example/coding_agent_sessions/7",
    });
    assert.equal(ecs.stdout.trim(), "ok 7 qm-1-s7 loop=");
    for (const bad of ["", "abc", "0", "-3", "7 "]) {
      const refused = run(probe, {
        TICKET_ID: "QM-1",
        IO_FACTORY_LAUNCH_SESSION_ID: bad,
      });
      assert.equal(
        refused.stdout.trim(),
        "refused",
        `IO_FACTORY_LAUNCH_SESSION_ID=${JSON.stringify(bad)} was accepted`,
      );
    }
    const urlWins = run(probe, {
      TICKET_ID: "QM-1",
      IO_FACTORY_LAUNCH_SESSION_ID: "42",
      CODING_AGENT_SESSION_URL: "not-a-session",
    });
    assert.equal(urlWins.stdout.trim(), "refused", "a malformed ECS session URL must not fall back to the loop id");
  });
  // The wrapper blanks IO_FACTORY_SESSION_ID at module scope, so the launch value must be captured first.
  const capture = WRAP.indexOf('IO_FACTORY_LAUNCH_SESSION_ID="${IO_FACTORY_SESSION_ID:-}"');
  const blank = WRAP.indexOf('\nIO_FACTORY_SESSION_ID=""\n');
  assert.ok(
    capture > -1 && blank > -1 && capture < blank,
    "the launch session id is not captured before the wrapper blanks it",
  );
});

test("the three handshake readers accept the token they now select on", () => {
  withHarness(
    ["converge_args_from_result", "io_recover_converge_envelope_from_journal", "io_read_converge_envelope"],
    (dir, run) => {
      const args = run('converge_args_from_result "$RESULT"', {
        RESULT: resultFor(TOKEN),
        REPO,
        IO_FACTORY_CONTROL_PLANE_DIR: CONTROL_PLANE,
      });
      assert.equal(args.status, 0, `converge_args_from_result rejected a ${TOKEN} result: ${args.stderr}`);
      const rewritten = JSON.parse(args.stdout);
      assert.equal(rewritten.workDir, `${REPO}/${WORK_DIR}`);
      assert.equal(rewritten.sessionMrIid, MR_IID);
      assert.equal(rewritten.sessionMrBranch, BRANCH);
      assert.equal(rewritten.sessionMrNonce, NONCE);
      assert.equal(rewritten.factoryControlPlaneDir, CONTROL_PLANE);

      mkdirSync(join(dir, WORK_DIR));
      writeFileSync(join(dir, WORK_DIR, "mr-create-journal.json"), journalFor(TOKEN));
      const recovered = run("io_recover_converge_envelope_from_journal", {
        IO_FACTORY_SESSION_ID: String(SESSION),
        IO_FACTORY_BRANCH: BRANCH,
        IO_PUBLISH_SH: writePublishStub(dir),
      });
      assert.equal(
        recovered.status,
        0,
        `io_recover_converge_envelope_from_journal rejected a ${TOKEN} journal: ${recovered.stderr}`,
      );
      const envelopePath = join(dir, WORK_DIR, "converge-envelope.json");
      assert.ok(existsSync(envelopePath), "journal recovery wrote no converge-envelope.json");
      assert.equal(JSON.parse(readFileSync(envelopePath, "utf8")).project, TOKEN);

      const read = run("io_read_converge_envelope", {});
      assert.equal(read.status, 0, "io_read_converge_envelope rejected the envelope journal recovery just wrote");
      assert.equal(JSON.parse(read.stdout).mr_iid, MR_IID);
    },
  );
});

test("the wrapper accepts the envelope build-and-ship itself writes", () => {
  assert.equal(JQ_WRITERS.length, 3, "build-and-ship no longer has one journal writer and two envelope writers");
  assert.equal(
    JQ_WRITERS[1]!.replace(/\s+/g, " "),
    JQ_WRITERS[2]!.replace(/\s+/g, " "),
    "the shell-block and agent-instruction envelope writers drifted apart, so an agent-written envelope is not the one bash reads",
  );
  withHarness(["io_read_converge_envelope"], (dir, run) => {
    mkdirSync(join(dir, WORK_DIR));
    writeFileSync(join(dir, WORK_DIR, "converge-envelope.json"), envelopeFor(TOKEN));
    const read = run("io_read_converge_envelope", {});
    assert.equal(
      read.status,
      0,
      "io_read_converge_envelope rejected the envelope build-and-ship writes on the ship path",
    );
    const envelope = JSON.parse(read.stdout);
    assert.equal(envelope.project, TOKEN);
    assert.equal(envelope.mr_iid, MR_IID);
    assert.equal(envelope.args.initialHead, HEAD);
  });
});

for (const [label, poison] of [
  ["the monorepo literal", "yc-software/code"],
  ["an empty project", ""],
] as const) {
  test(`the three handshake readers reject ${label}`, () => {
    withHarness(
      ["converge_args_from_result", "io_recover_converge_envelope_from_journal", "io_read_converge_envelope"],
      (dir, run) => {
        const args = run('converge_args_from_result "$RESULT"', {
          RESULT: resultFor(poison),
          REPO,
          IO_FACTORY_CONTROL_PLANE_DIR: CONTROL_PLANE,
        });
        assert.notEqual(args.status, 0, `converge_args_from_result accepted ${label}`);
        assert.equal(args.stdout, "");

        mkdirSync(join(dir, WORK_DIR));
        writeFileSync(join(dir, WORK_DIR, "mr-create-journal.json"), journalFor(poison));
        const recovered = run("io_recover_converge_envelope_from_journal", {
          IO_FACTORY_SESSION_ID: String(SESSION),
          IO_FACTORY_BRANCH: BRANCH,
          IO_PUBLISH_SH: writePublishStub(dir),
        });
        assert.notEqual(recovered.status, 0, `io_recover_converge_envelope_from_journal accepted ${label}`);
        assert.equal(
          existsSync(join(dir, WORK_DIR, "converge-envelope.json")),
          false,
          `journal recovery wrote an envelope from ${label}`,
        );

        writeFileSync(join(dir, WORK_DIR, "converge-envelope.json"), envelopeFor(poison));
        const read = run("io_read_converge_envelope", {});
        assert.notEqual(read.status, 0, `io_read_converge_envelope accepted ${label}`);
        assert.equal(read.stdout, "");
      },
    );
  });
}

for (const taskId of [{ CODING_AGENT_TASK_ID: "12345" }, {}] as Record<string, string>[]) {
  const state = "CODING_AGENT_TASK_ID" in taskId ? "set" : "unset";
  test(`the two bookface webhook functions are inert with CODING_AGENT_TASK_ID ${state}`, () => {
    withHarness(["converge_claim_bugbot_nudge", "converge_link_session_mr"], (dir, run) => {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      for (const tool of ["curl", "openssl"]) {
        writeFileSync(join(bin, tool), `#!/bin/sh\n: > "$MARKER"\nexit 97\n`);
        chmodSync(join(bin, tool), 0o700);
      }
      const marker = join(dir, "posted");
      const preamble = `export PATH=${JSON.stringify(bin)}:"$PATH"\npost_signed_webhook() { : > "$MARKER"; return 97; }\n`;
      for (const call of [
        `converge_claim_bugbot_nudge ${MR_IID} ${HEAD}`,
        `converge_link_session_mr ${MR_IID} ${BRANCH}`,
      ]) {
        const result = run(`${preamble}${call}`, {
          MARKER: marker,
          ...taskId,
        });
        assert.equal(result.status, 0, `${call} did not return 0 with CODING_AGENT_TASK_ID ${state}`);
        assert.equal(existsSync(marker), false, `${call} reached the network with CODING_AGENT_TASK_ID ${state}`);
      }
    });
  });
}

test("the steering bridge reports itself disarmed and forks nothing", () => {
  withHarness(["start_steering_bridge"], (dir, run) => {
    const pipe = join(dir, "inbox");
    assert.equal(spawnSync("mkfifo", [pipe], { env: PATH_ONLY }).status, 0, "could not create the steering FIFO");
    const result = run(
      'start_steering_bridge\necho "rc=$?"\necho "pid=[${STEERING_BRIDGE_PID:-}]"\necho "jobs=[$(jobs -p | tr "\\n" " ")]"',
      {
        CODING_AGENT_SESSION_URL: "https://bookface.ycombinator.com/coding_agent_sessions/4242",
        INTERNAL_WEBHOOK_SECRET: "x",
        IO_INBOX_PIPE: pipe,
        IO_STEERING_INTERVAL: "1",
        IO_STEERING_DISARM_FILE: join(dir, "disarm"),
      },
    );
    assert.equal(result.stderr.trimEnd(), "[steering] disarmed (no session endpoint in this deployment)");
    assert.equal(result.stdout, "rc=0\npid=[]\njobs=[]\n", "the steering bridge armed a poller");
  });
});

test("no surviving call site needs the uncopied signed-webhook helper", () => {
  for (const absolute of walk(factoryRoot)) {
    assert.equal(
      count(readFileSync(absolute, "utf8"), /post_signed_webhook/g),
      0,
      `${absolute} calls post_signed_webhook, whose definition was not moved`,
    );
  }
});

test("pin_factory_control_plane copies exactly the three surviving workflows", () => {
  const pin = sliceFunction("pin_factory_control_plane").replace(/\\\n\s*/g, " ");
  const loops = [...pin.matchAll(/for workflow in (.+?); do\n([\s\S]*?)\n\s*done/g)];
  assert.equal(loops.length, 2, "pin_factory_control_plane no longer has exactly two copy loops");
  assert.deepEqual(loops[0]![1]!.trim().split(/\s+/), COPIED_WORKFLOWS, "the copied workflow list changed");
  assert.equal(count(WRAP, /work-ticket-resolve-conflict/g), 0, "the wrapper still names work-ticket-resolve-conflict");
});

test("every unguarded copy source is a file factory carries", () => {
  const pin = sliceFunction("pin_factory_control_plane").replace(/\\\n\s*/g, " ");
  const guarded = new Set(captures(pin, /if \[ -f "\$source_repo\/([^"$]+)" \]/g));
  const sources = new Set(captures(pin, /"\$source_repo\/([^"]+)"/g).filter((path) => !path.includes("$")));
  for (const loop of pin.matchAll(/for workflow in (.+?); do\n([\s\S]*?)\n\s*done/g)) {
    const prefix = loop[2]!.match(/"\$source_repo\/([^"]*)\$workflow"/);
    assert.ok(prefix, "a pin_factory_control_plane copy loop does not copy from $source_repo");
    for (const entry of loop[1]!.trim().split(/\s+/)) sources.add(prefix[1]! + entry);
  }
  const missing = [...sources].filter((path) => !guarded.has(path) && !MOVED_FILES.includes(path)).sort();
  assert.deepEqual(missing, [], "pin_factory_control_plane copies an unguarded path that factory does not carry");
});

const PINNED_BASENAMES = [
  "converge-vector.sh",
  ...COPIED_WORKFLOWS,
  "contract-fidelity.md",
  "review_plan.md",
  "SKILL.md",
  "verify.sh",
  "publish.sh",
  "source.sh",
  "proof.sh",
];

const SIGNED_WEBHOOK_REL = "cli/files/lib/signed-webhook.sh";

function pinAgainst(run: Run, dir: string, source: string): { plane: string; ship: string } {
  const pinned = run(
    'pin_factory_control_plane\necho "rc=$?"\necho "plane=${IO_FACTORY_CONTROL_PLANE_DIR:-}"\necho "ship=${IO_FACTORY_SHIP_CONTROL_PLANE_DIR:-}"',
    { TMPDIR: dir, IO_FACTORY_SOURCE_DIR: source },
  );
  const fields = new Map(
    pinned.stdout
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  assert.equal(fields.get("rc"), "0", `pin_factory_control_plane failed against ${source}: ${pinned.stderr}`);
  return { plane: fields.get("plane")!, ship: fields.get("ship")! };
}

test("pin_factory_control_plane snapshots factory itself", () => {
  withHarness(["pin_factory_control_plane"], (dir, run) => {
    const { plane, ship } = pinAgainst(run, dir, factoryRoot);
    assert.ok(plane && existsSync(plane), "pin_factory_control_plane left no control-plane directory behind");
    for (const basename of PINNED_BASENAMES) {
      assert.ok(existsSync(join(plane, basename)), `the pinned control plane is missing ${basename}`);
    }
    for (const basename of ["converge-vector.sh", "work-ticket-build-and-ship.js"]) {
      assert.ok(existsSync(join(ship, basename)), `the pinned ship control plane is missing ${basename}`);
    }
    assert.equal(
      existsSync(join(plane, SIGNED_WEBHOOK_REL)),
      false,
      "factory does not carry the signed-webhook helper, so the snapshot must not claim to",
    );
  });
});

test("pin_factory_control_plane still snapshots the signing helper for a source tree that carries it", () => {
  withHarness(["pin_factory_control_plane"], (dir, run) => {
    const source = join(dir, "source-with-helper");
    cpSync(factoryRoot, source, { recursive: true });
    const helper = join(source, SIGNED_WEBHOOK_REL);
    mkdirSync(dirname(helper), { recursive: true });
    const body = "#!/usr/bin/env bash\npost_signed_webhook() { printf 'from the source tree'; }\n";
    writeFileSync(helper, body);
    const { plane } = pinAgainst(run, dir, source);
    assert.equal(
      existsSync(join(plane, SIGNED_WEBHOOK_REL)) ? readFileSync(join(plane, SIGNED_WEBHOOK_REL), "utf8") : "",
      body,
      "guarding the signed-webhook copy dropped it for a source tree that does carry the helper",
    );
  });
});

test("the wrapper boots with IO_FACTORY_SOURCE_DIR pointed at factory and reaches its entry points", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-factory-boot-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home);
    const booted = spawnSync("bash", [join(factoryRoot, WRAP_REL)], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...PATH_ONLY,
        HOME: home,
        TMPDIR: dir,
        IO_REPO_DIR: dir,
        IO_FACTORY_SOURCE_DIR: factoryRoot,
        IO_WORKFLOW_MODE: "conflict",
        ANTHROPIC_API_KEY: "synthetic-never-used",
      },
      timeout: 60_000,
    });
    assert.equal(booted.error, undefined, `the wrapper did not finish: ${booted.error?.message}`);
    assert.equal(
      booted.stderr.trimEnd(),
      "[io-coding-agent-js] FAIL: IO_WORKFLOW_MODE=conflict is not supported by this factory",
      "the wrapper did not boot from factory into its mode dispatch cleanly",
    );
    assert.equal(booted.status, 2, "the IO_WORKFLOW_MODE=conflict fail-fast is gone or no longer exits 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TOOLS_SH = join(factoryRoot, "tools/factory/tools.sh");

function runTools(args: string[], env: Record<string, string> = {}, cwd = tmpdir()) {
  return spawnSync("bash", [TOOLS_SH, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...PATH_ONLY, HOME: cwd, ...env },
    timeout: 10_000,
  });
}

function stubTool(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

test("tools.sh compares node versions against the factory floor", () => {
  for (const [version, ok] of [
    ["v24.13.0", 1],
    ["v24.15.0", 0],
    ["v24.18.0", 0],
    ["v25.0.0", 0],
    ["24.14.9", 1],
    ["v23.99.99", 1],
  ] as const) {
    assert.equal(runTools(["node-ok", version]).status, ok, `node-ok ${version}`);
  }
  assert.equal(runTools(["gh-arch", "x86_64"]).stdout.trim(), "amd64");
  assert.equal(runTools(["gh-arch", "aarch64"]).stdout.trim(), "arm64");
  assert.equal(runTools(["gh-arch", "arm64"]).stdout.trim(), "arm64");
  assert.notEqual(runTools(["gh-arch", "riscv64"]).status, 0);
});

const HOST_TOOLS = [
  "awk",
  "bash",
  "cp",
  "dirname",
  "grep",
  "head",
  "install",
  "mkdir",
  "mktemp",
  "rm",
  "sha256sum",
  "tail",
  "tar",
];

function withToolsBin(stubs: Record<string, string>, body: (dir: string, bin: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "qm-factory-tools-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const name of HOST_TOOLS) {
      const found = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8", env: PATH_ONLY }).stdout.trim();
      if (found) symlinkSync(found, join(bin, name));
    }
    for (const [name, script] of Object.entries(stubs)) stubTool(bin, name, script);
    body(dir, bin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MUST_NOT_RUN = 'echo "$0 must not run" >&2; exit 99';

const RECORD_AND_PIN = `printf '%s\\n' "$*" >> "$HOME/npm-args"; : > "$HOME/pinned"`;
const RECORD_ONLY = `printf '%s\\n' "$*" >> "$HOME/npm-args"`;

const npmStub = (shipped: string, installArm: string = RECORD_AND_PIN) =>
  `case "$1 ${"$"}{2:-}" in
     --version*) [ -f "$HOME/pinned" ] && echo 11.16.0 || echo ${shipped};;
     "install -h") echo "[--allow-scripts <package-list>]";;
     install*) ${installArm};;
   esac`;

const NPM_11 = npmStub("11.16.0", MUST_NOT_RUN);

test("tools.sh ensure installs nothing when node, gh, and claude are already present", () => {
  withToolsBin(
    {
      node: "echo v24.18.0",
      gh: 'echo "gh version 2.93.0 (2026-01-01)"',
      claude: 'echo "2.1.210 (Claude Code)"',
      npm: NPM_11,
      curl: MUST_NOT_RUN,
    },
    (dir, bin) => {
      const result = runTools(["ensure"], { PATH: bin }, dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout, "");
    },
  );
});

test("tools.sh ensure fails closed on an old node and never reaches the installers", () => {
  withToolsBin({ node: "echo v24.13.0", npm: MUST_NOT_RUN, curl: MUST_NOT_RUN }, (dir, bin) => {
    const result = runTools(["ensure"], { PATH: bin }, dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FAIL: node v24\.13\.0 is below the 24\.15\.0 floor/);
    assert.doesNotMatch(result.stderr, /must not run/);
  });
});

test("tools.sh ensure installs claude through npm with the allow-scripts flag when only claude is missing", () => {
  withToolsBin(
    {
      node: "echo v24.18.0",
      gh: 'echo "gh version 2.93.0 (2026-01-01)"',
      curl: MUST_NOT_RUN,
      npm: npmStub(
        "11.16.0",
        `printf '%s\\n' "$*" > "$HOME/npm-args"; cp "$HOME/claude-stub" "$(dirname "$0")/claude"`,
      ),
    },
    (dir, bin) => {
      stubTool(dir, "claude-stub", 'echo "2.1.210 (Claude Code)"');
      const result = runTools(["ensure"], { PATH: bin }, dir);
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        readFileSync(join(dir, "npm-args"), "utf8"),
        /^install -g --allow-scripts=@anthropic-ai\/claude-code @anthropic-ai\/claude-code@2\.1\.210$/m,
      );
      assert.match(
        result.stderr,
        /^\[factory-tools\] installed: claude \(node v24\.18\.0, gh 2\.93\.0, claude 2\.1\.210\)$/m,
      );
    },
  );
});

test("tools.sh ensure fails closed when the gh tarball checksum does not match", () => {
  withToolsBin(
    {
      node: "echo v24.18.0",
      claude: 'echo "2.1.210 (Claude Code)"',
      npm: NPM_11,
      uname: "echo aarch64",
      curl: 'out=""; while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; echo "not a tarball" > "$out"',
    },
    (dir, bin) => {
      const result = runTools(["ensure"], { PATH: bin }, dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /FAIL: gh 2\.93\.0 checksum mismatch/);
      assert.doesNotMatch(result.stderr, /must not run/);
    },
  );
});

const PIN_LINE = /^\[factory-tools\] pinned npm 11\.16\.0\b/m;

test("tools.sh ensure pins npm 11.16.0 when the sandbox ships npm 12 and leaves it alone on a second run", () => {
  withToolsBin(
    {
      node: "echo v24.18.0",
      gh: 'echo "gh version 2.93.0 (2026-01-01)"',
      claude: 'echo "2.1.210 (Claude Code)"',
      npm: npmStub("12.0.2"),
      curl: MUST_NOT_RUN,
    },
    (dir, bin) => {
      const result = runTools(["ensure"], { PATH: bin }, dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(dir, "npm-args"), "utf8"), "install -g npm@11.16.0\n");
      assert.match(result.stderr, PIN_LINE);
      assert.equal(result.stderr.trimEnd().split("\n").length, 1, result.stderr);
      assert.equal(result.stdout, "");

      const again = runTools(["ensure"], { PATH: bin }, dir);
      assert.equal(again.status, 0, again.stderr);
      assert.equal(again.stderr, "", "a box already pinned to npm 11 must install nothing");
      assert.equal(readFileSync(join(dir, "npm-args"), "utf8"), "install -g npm@11.16.0\n");
    },
  );
});

test("tools.sh ensure pins every npm at or above 12.0.0 and no npm below it", () => {
  for (const [shipped, pins] of [
    ["12.0.0", true],
    ["13.0.0", true],
    ["11.10.0", false],
    ["11.0.0", false],
  ] as const) {
    withToolsBin(
      {
        node: "echo v24.18.0",
        gh: 'echo "gh version 2.93.0 (2026-01-01)"',
        claude: 'echo "2.1.210 (Claude Code)"',
        npm: npmStub(shipped),
        curl: MUST_NOT_RUN,
      },
      (dir, bin) => {
        const result = runTools(["ensure"], { PATH: bin }, dir);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "");
        if (pins) {
          assert.equal(readFileSync(join(dir, "npm-args"), "utf8"), "install -g npm@11.16.0\n", `npm ${shipped}`);
          assert.match(result.stderr, PIN_LINE);
        } else {
          assert.equal(existsSync(join(dir, "npm-args")), false, `npm ${shipped} must not be re-pinned`);
          assert.equal(result.stderr, "", `npm ${shipped}`);
        }
      },
    );
  }
});

test("tools.sh ensure pins npm before it installs claude", () => {
  withToolsBin(
    {
      node: "echo v24.18.0",
      gh: 'echo "gh version 2.93.0 (2026-01-01)"',
      curl: MUST_NOT_RUN,
      npm: npmStub(
        "12.0.2",
        `${RECORD_AND_PIN}; case "$*" in *claude-code*) cp "$HOME/claude-stub" "$(dirname "$0")/claude";; esac`,
      ),
    },
    (dir, bin) => {
      stubTool(dir, "claude-stub", 'echo "2.1.210 (Claude Code)"');
      const result = runTools(["ensure"], { PATH: bin }, dir);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(join(dir, "npm-args"), "utf8").trimEnd().split("\n"), [
        "install -g npm@11.16.0",
        "install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@2.1.210",
      ]);
      assert.match(result.stderr, PIN_LINE);
      assert.match(result.stderr, /^\[factory-tools\] installed: claude \(node v24\.18\.0, /m);
    },
  );
});

test("tools.sh ensure fails closed when the npm pin cannot be installed", () => {
  withToolsBin(
    {
      node: "echo v24.18.0",
      curl: MUST_NOT_RUN,
      npm: npmStub("12.0.2", `for i in {1..30}; do printf 'npm-line-%s\\n' "$i"; done; exit 1`),
    },
    (dir, bin) => {
      const result = runTools(["ensure"], { PATH: bin, TMPDIR: dir }, dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^npm-line-11$/m);
      assert.match(result.stderr, /^npm-line-30$/m);
      assert.doesNotMatch(result.stderr, /^npm-line-10$/m, "only the last 20 lines of npm output belong on stderr");
      assert.match(result.stderr, /^\[factory-tools\] FAIL: could not install npm@11\.16\.0\b/m);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /must not run/, "the gh installer must not run after a failed pin");
      assert.equal(existsSync(join(dir, "npm-args")), false);
      assert.deepEqual(
        readdirSync(dir).filter((entry) => entry.startsWith("factory-npm")),
        [],
        "the captured npm output was left behind",
      );
    },
  );
});

test("tools.sh ensure fails closed when the npm pin installs but does not take", () => {
  withToolsBin(
    {
      node: "echo v24.18.0",
      curl: MUST_NOT_RUN,
      npm: npmStub("12.0.2", RECORD_ONLY),
    },
    (dir, bin) => {
      const result = runTools(["ensure"], { PATH: bin }, dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /^\[factory-tools\] FAIL: npm still reports 12\.0\.2\b/m);
      assert.equal(result.stdout, "");
      assert.equal(
        readFileSync(join(dir, "npm-args"), "utf8"),
        "install -g npm@11.16.0\n",
        "claude must not be installed after the pin failed to take",
      );
    },
  );
});

test("tools.sh ensure still reports a missing npm as the reason claude cannot be installed", () => {
  withToolsBin(
    { node: "echo v24.18.0", gh: 'echo "gh version 2.93.0 (2026-01-01)"', curl: MUST_NOT_RUN },
    (dir, bin) => {
      const result = runTools(["ensure"], { PATH: bin }, dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /FAIL: claude is not installed and npm is missing/);
    },
  );
});

test("the wrapper runs the tool preflight before it touches the claude CLI", () => {
  const preflight = WRAP.indexOf("tools/factory/tools.sh");
  const auth = WRAP.indexOf("export ANTHROPIC_API_KEY=");
  assert.ok(preflight > 0, "the wrapper does not call tools.sh");
  assert.ok(preflight < auth, "tools.sh must run before the claude auth bridge");
  assert.ok(preflight > WRAP.indexOf('cd "$REPO"'), "the preflight must run after the repo checkout exists");
  assert.match(WRAP, /IO_FACTORY_TOOLS_SH:-\$\{IO_FACTORY_SOURCE_DIR:-/);
  assert.match(
    WRAP,
    /\[ "\$\{IS_SANDBOX:-\}" = "1" \] && ! bash "\$\{IO_FACTORY_TOOLS_SH/,
    "the preflight must run only inside a sandbox",
  );
});

function traceWrapperBoot(
  env: Record<string, string>,
  body: (booted: { status: number | null; stderr: string }, trace: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "qm-factory-order-"));
  try {
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    mkdirSync(home);
    mkdirSync(repo);
    const trace = join(dir, "trace");
    writeFileSync(trace, "");
    const tools = join(dir, "tools.sh");
    writeFileSync(tools, `#!/bin/bash\nprintf 'preflight\\n' >> "$TRACE"\nexit "${"$"}{STUB_ENSURE_STATUS:-0}"\n`);
    chmodSync(tools, 0o755);
    const booted = spawnSync("bash", [join(factoryRoot, WRAP_REL)], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...PATH_ONLY,
        HOME: home,
        TMPDIR: dir,
        TRACE: trace,
        IO_REPO_DIR: repo,
        IO_FACTORY_SOURCE_DIR: factoryRoot,
        IO_FACTORY_TOOLS_SH: tools,
        IO_REPO_SETUP_CMD: `printf 'setup\\n' >> "$TRACE"`,
        IO_WORKFLOW_MODE: "conflict",
        ANTHROPIC_API_KEY: "synthetic-never-used",
        ...env,
      },
      timeout: 60_000,
    });
    assert.equal(booted.error, undefined, `the wrapper did not finish: ${booted.error?.message}`);
    body(booted, trace);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the wrapper runs the sandbox tool preflight before the repo setup command installs dependencies", () => {
  traceWrapperBoot({ IS_SANDBOX: "1" }, (_booted, trace) => {
    assert.equal(readFileSync(trace, "utf8"), "preflight\nsetup\n");
  });
  traceWrapperBoot({}, (_booted, trace) => {
    assert.equal(readFileSync(trace, "utf8"), "setup\n", "the preflight must stay gated on IS_SANDBOX");
  });
  traceWrapperBoot({ IS_SANDBOX: "1", STUB_ENSURE_STATUS: "1" }, (booted, trace) => {
    assert.equal(booted.status, 1);
    assert.match(booted.stderr, /FAIL: the sandbox is missing a tool the factory needs/);
    assert.equal(readFileSync(trace, "utf8"), "preflight\n", "a failed preflight must block the repo setup command");
  });
});
