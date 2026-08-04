import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultOrgPolicy,
  composePolicy,
  evaluateCommand,
  evaluateCommandWithLayer,
  parseCommandPolicy,
  scannableCommand,
} from "../src/policy/command-policy.ts";
import type { CommandPolicy, CommandRule } from "../src/types.ts";

test("org floor requires approval for recursive delete and denies fork bomb", () => {
  const p = defaultOrgPolicy();
  assert.equal(evaluateCommand("rm -rf build", p).decision, "require_approval");
  assert.equal(evaluateCommand("mkfs.ext4 /dev/sda", p).decision, "deny");
});

test("evaluateCommand surfaces the matched rule's identity (its pattern) as the grant key", () => {
  const p: CommandPolicy = {
    mode: "denylist",
    rules: [{ pattern: "\\bzz-tool\\b", decision: "require_approval", reason: "ZZ tool" }],
  };
  const r = evaluateCommand("run zz-tool now", p);
  assert.equal(r.decision, "require_approval");
  assert.equal(r.approvalKey, "\\bzz-tool\\b");
});

test("recursive delete is gated in every flag form and order", () => {
  const p = defaultOrgPolicy();
  const gated = [
    "rm -r build",
    "rm -rf build",
    "rm -fr build",
    "rm -f -r build",
    "rm -Rf build",
    "rm --recursive --force build",
    "rm --force --recursive build",
    "rm -v -rf build",
  ];
  for (const c of gated) {
    assert.equal(evaluateCommand(c, p).decision, "require_approval", `expected gate: ${c}`);
  }
  assert.equal(evaluateCommand("rm file.txt", p).decision, "allow");
  assert.equal(evaluateCommand("rm -f file.txt", p).decision, "allow");
});

test("fork bomb is denied", () => {
  const p = defaultOrgPolicy();
  assert.equal(evaluateCommand(":(){ :|:& };:", p).decision, "deny");
  assert.equal(evaluateCommand(":() { :|:& };:", p).decision, "deny");
});

test("benign command is allowed in denylist mode", () => {
  assert.equal(evaluateCommand("echo hello", defaultOrgPolicy()).decision, "allow");
});

test("scope rules can tighten but org floor wins (evaluated first)", () => {
  const scope: CommandPolicy = {
    mode: "denylist",
    rules: [{ pattern: "rm -rf", decision: "allow" }],
  };
  const composed = composePolicy(defaultOrgPolicy(), scope);
  assert.equal(evaluateCommand("rm -rf build", composed).decision, "require_approval");
});

test("first-match-wins in rule order: an operator allow carve-out before a broader require_approval still allows", () => {
  const policy: CommandPolicy = {
    mode: "denylist",
    rules: [
      { pattern: "git push origin staging", decision: "allow" },
      { pattern: "git push", decision: "require_approval", reason: "review pushes" },
    ],
  };
  assert.equal(evaluateCommand("git push origin staging", policy).decision, "allow");
  assert.equal(evaluateCommand("git push origin main", policy).decision, "require_approval");
});

test("bare-word unquoting widens allow carve-outs too: a quoted command now matches and short-circuits a later require_approval rule", () => {
  const policy: CommandPolicy = {
    mode: "denylist",
    rules: [
      { pattern: "\\bgit\\s+push\\s+origin\\s+staging\\b", decision: "allow" },
      { pattern: "\\bgit\\s+push\\b", decision: "require_approval", reason: "review pushes" },
    ],
  };
  assert.equal(evaluateCommand("git push origin 'staging'", policy).decision, "allow");
  assert.equal(evaluateCommand('git push origin "staging"', policy).decision, "allow");
  assert.equal(evaluateCommand("git push origin 'staging extra'", policy).decision, "require_approval");
});

test("force push requires approval in long AND short flag forms (org floor)", () => {
  const p = defaultOrgPolicy();
  assert.equal(evaluateCommand("git push --force origin main", p).decision, "require_approval");
  assert.equal(evaluateCommand("git push -f origin feature", p).decision, "require_approval");
  assert.equal(evaluateCommand("git push --force-with-lease", p).decision, "require_approval");
  assert.equal(evaluateCommand("git push origin main", p).decision, "allow");
  assert.equal(evaluateCommand("git push -u origin feature", p).decision, "allow");
});

test("deployment rules replace tool-specific hard-coded command denials", () => {
  const policy = defaultOrgPolicy();
  const layer: CommandRule[] = [
    {
      pattern: "\\bacmecli\\b[^;|&]*\\blogin\\b",
      decision: "deny",
      reason: "this deployment authenticates acmecli ambiently",
    },
  ];
  assert.equal(evaluateCommand("acmecli login", policy).decision, "allow", "generic core has no vendor policy");
  const denied = [
    "acmecli login",
    "acmecli login --use-device-code",
    "echo ready && acmecli 'login'",
    "echo ready | acmecli login",
    'echo "$(acmecli login)"',
    "sudo acmecli login",
    "sudo -u root acmecli login",
    "env DEBUG=1 acmecli login",
    "FOO=1 acmecli login",
    "FOO= acmecli login",
    "time acmecli login",
    "nice acmecli login",
    "timeout 5 acmecli login",
    "if acmecli login; then echo impossible; fi",
    "/usr/local/bin/acmecli login",
    "  acmecli login",
    "echo `acmecli login`",
    'echo "`acmecli login`"',
    "acmecli \\\n login",
    "command -- acmecli login",
    "exec -- acmecli login",
    "exec -l acmecli login",
    "env -- acmecli login",
    "/usr/bin/env acmecli login",
    "/usr/bin/nice acmecli login",
    "nice -n5 acmecli login",
    "timeout --signal TERM 5 acmecli login",
    "bash -c 'acmecli login'",
    "sh -c 'acmecli login'",
    "eval 'acmecli login'",
    "acme''cli login",
    "coproc acmecli login",
    "xargs acmecli login",
    "acmecli --env production login",
    "acmecli --verbose login",
    "acmecli --refresh-cache login",
    "2>/dev/null acmecli login",
    ">out acmecli login",
    "nohup acmecli login",
    "env -S 'acmecli login'",
    "env --split-string='acmecli login'",
    "command acmecli login -v",
    "command -- acmecli login -V",
    "$'acmecli' login",
    ["bash <<EOF >login.log", "acmecli login", "EOF"].join("\n"),
    ["cat <<EOF | bash >login.log", "acmecli login", "EOF"].join("\n"),
    "2>&1 acmecli login",
    "env -S'acmecli login'",
    "bash -O extglob -c 'acmecli login'",
    "bash --rcfile /dev/null -c 'acmecli login'",
    "$'acme\\x63li' login",
  ];
  for (const c of denied) {
    const r = evaluateCommandWithLayer(c, policy, layer);
    assert.equal(r.decision, "deny", `expected deny: ${c}`);
    assert.match(r.reason ?? "", /authenticates acmecli ambiently/);
  }
  for (const c of [
    "gh auth login",
    "gcloud auth login --no-launch-browser",
    "acmecli status",
    "echo 'acmecli login'",
  ]) {
    assert.notEqual(evaluateCommandWithLayer(c, policy, layer).decision, "deny", `must not deny: ${c}`);
  }
});

test("a dangerous-looking pattern inside data (heredoc body, quoted literal) is NOT gated", () => {
  const p = defaultOrgPolicy();
  const writeHeredoc = [
    "cat > test/x.ts <<EOF",
    'const c = "!run git push --force origin main";',
    "rm -rf node_modules // in a comment",
    "EOF",
  ].join("\n");
  assert.equal(evaluateCommand(writeHeredoc, p).decision, "allow");
  assert.equal(evaluateCommand("echo 'rm -rf /'", p).decision, "allow");
  assert.equal(evaluateCommand('git commit -m "drop table users"', p).decision, "allow");
});

test("a real dangerous command is still gated even when the turn also writes a heredoc", () => {
  const p = defaultOrgPolicy();
  const cmd = ["cat > note.txt <<EOF", "harmless body", "EOF", "git push --force origin main"].join("\n");
  const r = evaluateCommand(cmd, p);
  assert.equal(r.decision, "require_approval");
  assert.equal(r.reason, "force push");
});

test("command substitution that runs a dangerous command is still gated, even inside quotes", () => {
  const p = defaultOrgPolicy();
  assert.equal(evaluateCommand('echo "$(rm -rf /tmp/x)"', p).decision, "require_approval");
});

test("a heredoc body fed to a shell stays gated (executed, not a file write)", () => {
  const p = defaultOrgPolicy();
  assert.equal(evaluateCommand("bash <<EOF\nrm -rf /\nEOF", p).decision, "require_approval");
  assert.equal(evaluateCommand("cat <<EOF | bash\nrm -rf /\nEOF", p).decision, "require_approval");
  assert.equal(evaluateCommand("cat > /tmp/s.sh <<EOF\nrm -rf /\nEOF", p).decision, "allow");
});

test("evaluateCommand surfaces the exact substring that tripped the rule", () => {
  const p = defaultOrgPolicy();
  const r = evaluateCommand("git push --force origin main", p);
  assert.equal(r.decision, "require_approval");
  assert.ok(r.matched?.includes("--force"), `expected matched to include the trigger, got ${r.matched}`);
});

test("scannableCommand strips inert data but preserves executable command substitution", () => {
  assert.ok(
    !/git push --force/.test(scannableCommand(["cat > x <<EOF", "git push --force", "EOF"].join("\n"))),
    "heredoc body stripped",
  );
  assert.ok(!/rm -rf/.test(scannableCommand("echo 'rm -rf /'")), "single-quoted literal stripped");
  assert.ok(
    !/drop table/i.test(scannableCommand('git commit -m "drop table users"')),
    "double-quoted literal stripped",
  );
  assert.ok(
    /rm -rf/.test(scannableCommand('echo "$(rm -rf /)"')),
    "command substitution inside double quotes preserved",
  );
});

test("scannableCommand unquotes bare words so quoting cannot evade word-boundary rules", () => {
  assert.equal(scannableCommand("acmecli 'tool' query_database"), "acmecli tool query_database");
  assert.equal(scannableCommand('acmecli "tool" query_database'), "acmecli tool query_database");
  assert.equal(scannableCommand("git commit -m 'fix stuff'"), "git commit -m ''", "multi-word strings stay stripped");
  assert.equal(scannableCommand("echo 'a;b'"), "echo ''", "shell metachars stay stripped");
  const rule: CommandPolicy = {
    mode: "denylist",
    rules: [{ pattern: "\\bacmecli\\b[^;|&]*\\btool\\s+\\S+", decision: "require_approval" }],
  };
  assert.equal(evaluateCommand("acmecli 'tool' analytics", rule).decision, "require_approval");
  assert.equal(
    evaluateCommand("acmecli me && othercli tool list", rule).decision,
    "allow",
    "the bridge stops at command separators",
  );
});

test("layer rules cannot be bypassed with shell escapes or empty quote concatenation", () => {
  const policy: CommandPolicy = { mode: "denylist", rules: [] };
  const layer: CommandRule[] = [{ pattern: "\\bacmecli\\s+tool\\s+query_database\\b", decision: "require_approval" }];
  for (const command of [
    "acmecli tool query_database",
    "acme\\cli tool query_database",
    "acmecli to\\ol query_database",
    "acme''cli tool query_database",
  ]) {
    assert.equal(evaluateCommandWithLayer(command, policy, layer).decision, "require_approval", command);
  }
  assert.equal(evaluateCommandWithLayer("echo 'acme\\cli tool query_database'", policy, layer).decision, "allow");
  assert.equal(
    evaluateCommandWithLayer("printf '%s' 'acme''cli tool query_database'", policy, layer).decision,
    "allow",
  );
});

test("shell-evaluated payloads and ANSI-C words cannot bypass command rules", () => {
  const org = defaultOrgPolicy();
  for (const command of [
    "bash -c 'rm -rf /tmp/x'",
    "eval 'git push --force origin main'",
    "sudo bash -lc 'rm -rf /tmp/x'",
    `echo "$(bash -c 'rm -rf /tmp/x')"`,
  ]) {
    assert.equal(evaluateCommand(command, org).decision, "require_approval", command);
  }
  assert.equal(evaluateCommand("bash -c 'echo \"rm -rf /tmp/x\"'", org).decision, "allow");
  assert.equal(evaluateCommand("printf '%s' 'bash -c rm -rf /tmp/x'", org).decision, "allow");

  const policy: CommandPolicy = { mode: "denylist", rules: [] };
  const layer: CommandRule[] = [{ pattern: "\\bacmecli\\s+tool\\s+query_database\\b", decision: "require_approval" }];
  for (const command of [
    "bash -c 'acmecli tool query_database'",
    "eval 'acmecli tool query_database'",
    "acmecli $'tool' query_database",
    "acmecli $'to\\x6fl' query_database",
  ]) {
    assert.equal(evaluateCommandWithLayer(command, policy, layer).decision, "require_approval", command);
  }
});

test("literal stdin executed by a shell and simple command variables stay inside the gate", () => {
  const org = defaultOrgPolicy();
  for (const command of [
    `printf 'rm -rf /tmp/x\\n' | bash`,
    `printf 'rm %s\\n' '-rf /tmp/x' | bash -`,
    `echo 'rm -rf /tmp/x' | env bash /dev/stdin`,
    `printf '%s\\n' 'rm -rf /tmp/x' | sudo sh /proc/self/fd/0`,
    `command printf 'rm -rf /tmp/x\\n' | bash`,
    `env printf 'rm -rf /tmp/x\\n' | sh`,
    `builtin printf 'rm -rf /tmp/x\\n' | bash`,
    `env -S "printf 'rm -rf /tmp/x\\n'" | bash`,
    `printf 'rm -rf /tmp/x\\n' | env -S "bash /dev/stdin"`,
    `echo -e 'rm\\x20-rf /tmp/x\\n' | bash`,
    `printf 'rm -rf /tmp/x\\n' | stdbuf -oL bash`,
    `bash <<< 'rm -rf /tmp/x'`,
    `bash<<<'rm -rf /tmp/x'`,
    `env sh <<< 'rm -rf /tmp/x'`,
    `r=rm; "$r" -rf /tmp/x`,
    `r=rm; command $r -rf /tmp/x`,
    `r=rm; env $r -rf /tmp/x`,
  ]) {
    assert.equal(evaluateCommand(command, org).decision, "require_approval", command);
  }
  assert.equal(evaluateCommand(`printf 'rm -rf /tmp/x\\n' | cat`, org).decision, "allow");
  assert.equal(evaluateCommand(`printf '%s' 'rm -rf /tmp/x' | bash -c 'cat >/tmp/x'`, org).decision, "allow");
  assert.equal(evaluateCommand(`printf 'rm -rf /tmp/x\\n' || bash`, org).decision, "allow");
  assert.equal(evaluateCommand(`printf 'rm -rf /tmp/x\\n' && bash`, org).decision, "allow");

  const policy: CommandPolicy = { mode: "denylist", rules: [] };
  const layer: CommandRule[] = [{ pattern: "\\bacmecli\\s+tool\\s+query_database\\b", decision: "require_approval" }];
  assert.equal(
    evaluateCommandWithLayer(`printf '%s\\n' 'acmecli tool query_database' | bash`, policy, layer).decision,
    "require_approval",
  );
});

test("allowlist mode denies anything not explicitly allowed", () => {
  const p: CommandPolicy = {
    mode: "allowlist",
    rules: [{ pattern: "^ls\\b", decision: "allow" }],
  };
  assert.equal(evaluateCommand("ls -la", p).decision, "allow");
  assert.equal(evaluateCommand("cat secrets", p).decision, "deny");
});

test("a lower scope cannot downgrade an org allowlist to a denylist", () => {
  const orgAllowlist: CommandPolicy = {
    mode: "allowlist",
    rules: [{ pattern: "^ls\\b", decision: "allow" }],
  };
  const scope: CommandPolicy = { mode: "denylist", rules: [] };
  const composed = composePolicy(orgAllowlist, scope);
  assert.equal(composed.mode, "allowlist");
  assert.equal(evaluateCommand("cat secrets", composed).decision, "deny");
});

test("a lower scope can tighten an org denylist to an allowlist", () => {
  const scope: CommandPolicy = {
    mode: "allowlist",
    rules: [{ pattern: "^ls\\b", decision: "allow" }],
  };
  const composed = composePolicy(defaultOrgPolicy(), scope);
  assert.equal(composed.mode, "allowlist");
  assert.equal(evaluateCommand("cat secrets", composed).decision, "deny");
});

test("an invalid stored rule is skipped (any decision) — one stale pattern never locks a scope", () => {
  const p: CommandPolicy = {
    mode: "denylist",
    rules: [
      { pattern: "(", decision: "deny", reason: "broken" },
      { pattern: "\\bcurl\\b", decision: "deny", reason: "still enforced" },
    ],
  };
  assert.equal(evaluateCommand("echo hello", p).decision, "allow", "unrelated commands keep working");
  assert.equal(evaluateCommand("curl http://x", p).decision, "deny", "valid sibling rules still bind");

  const approval: CommandPolicy = {
    mode: "denylist",
    rules: [{ pattern: "(", decision: "require_approval" }],
  };
  assert.equal(evaluateCommand("echo hello", approval).decision, "allow");
});

test("evaluateCommandWithLayer: layer rules apply only where the scope policy is silent", () => {
  const layer: CommandRule[] = [
    { pattern: "\\bkubectl\\b", decision: "require_approval", reason: "layer: kubectl" },
    { pattern: "\\bhelm\\b", decision: "deny", reason: "layer: helm" },
  ];
  const dflt: CommandPolicy = { mode: "denylist", rules: [] };
  assert.equal(evaluateCommandWithLayer("kubectl get pods", dflt, layer).decision, "require_approval");
  assert.equal(evaluateCommandWithLayer("helm install x", dflt, layer).decision, "deny");
  assert.equal(evaluateCommandWithLayer("echo hi", dflt, layer).decision, "allow");
});

test("evaluateCommandWithLayer: a scope decision is final; the layer never widens it", () => {
  const layer: CommandRule[] = [{ pattern: "\\bkubectl\\b", decision: "require_approval" }];
  const allowlist: CommandPolicy = { mode: "allowlist", rules: [{ pattern: "^ls\\b", decision: "allow" }] };
  assert.equal(evaluateCommandWithLayer("kubectl get pods", allowlist, layer).decision, "deny");

  const scope: CommandPolicy = {
    mode: "denylist",
    rules: [{ pattern: "\\bdeploy\\b", decision: "require_approval", reason: "scope: deploy" }],
  };
  const denyLayer: CommandRule[] = [{ pattern: "\\bdeploy\\b", decision: "deny", reason: "layer: deploy" }];
  const r = evaluateCommandWithLayer("deploy prod", scope, denyLayer);
  assert.equal(r.decision, "require_approval");
  assert.equal(r.reason, "scope: deploy");

  const carve: CommandPolicy = { mode: "denylist", rules: [{ pattern: "kubectl get", decision: "allow" }] };
  assert.equal(evaluateCommandWithLayer("kubectl get pods", carve, layer).decision, "allow");
});

test("evaluateCommandWithLayer with no layer rules matches evaluateCommand", () => {
  const p = defaultOrgPolicy();
  assert.deepEqual(
    evaluateCommandWithLayer("git push --force origin main", p, []),
    evaluateCommand("git push --force origin main", p),
  );
});

test("parseCommandPolicy accepts a valid policy and normalizes it", () => {
  const parsed = parseCommandPolicy({
    mode: "denylist",
    rules: [{ pattern: "^curl\\b", decision: "require_approval", reason: "network" }],
  });
  assert.ok("policy" in parsed);
  assert.equal(parsed.policy.mode, "denylist");
  assert.equal(parsed.policy.rules.length, 1);
});

test("parseCommandPolicy rejects malformed input", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /must be an object/],
    [{ mode: "blocklist", rules: [] }, /mode must be/],
    [{ mode: "denylist" }, /rules must be an array/],
    [{ mode: "denylist", rules: [{ pattern: "", decision: "deny" }] }, /pattern must be a non-empty string/],
    [{ mode: "denylist", rules: [{ pattern: "(", decision: "deny" }] }, /not a valid regex/],
    [{ mode: "denylist", rules: [{ pattern: "x", decision: "block" }] }, /decision must be/],
    [{ mode: "denylist", rules: [{ pattern: "x", decision: "deny", reason: 5 }] }, /reason must be a string/],
  ];
  for (const [input, msg] of cases) {
    const parsed = parseCommandPolicy(input);
    assert.ok("error" in parsed, `expected error for ${JSON.stringify(input)}`);
    assert.match(parsed.error, msg);
  }
});

test("parseCommandPolicy rejects regexes with catastrophic repetition", () => {
  for (const pattern of ["(a+)+$", "(a|aa)+$", "(.*)*$"]) {
    const parsed = parseCommandPolicy({ mode: "denylist", rules: [{ pattern, decision: "deny" }] });
    assert.ok("error" in parsed, pattern);
  }
});
test("a heredoc fed to a non-interpreter command (cat, gh) is data, not gated", () => {
  const policy = defaultOrgPolicy();
  const prBody = [
    `gh pr create --title x --body "$(cat <<'EOF'`,
    "Extract SQL payloads safely; previously DROP TABLE users in payloads broke parsing.",
    "EOF",
    ')"',
  ].join("\n");
  assert.equal(evaluateCommand(prBody, policy).decision, "allow");
  const piped = ["cat <<'EOF' | gh pr create --body-file -", "fixes DROP TABLE handling", "EOF"].join("\n");
  assert.equal(evaluateCommand(piped, policy).decision, "allow");
});

test("a heredoc fed to a SQL client or interpreter stays gated", () => {
  const policy = defaultOrgPolicy();
  const sql = ["psql mydb <<EOF", "drop table users;", "EOF"].join("\n");
  assert.equal(evaluateCommand(sql, policy).decision, "require_approval");
});

test("an unquoted heredoc's command substitutions still execute and stay gated", () => {
  const policy = defaultOrgPolicy();
  const sneaky = ["cat <<EOF | gh pr create --body-file -", "hello $(rm -rf /tmp/x)", "EOF"].join("\n");
  assert.equal(evaluateCommand(sneaky, policy).decision, "require_approval");
});
