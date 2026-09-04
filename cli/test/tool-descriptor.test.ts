import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileApproval,
  interpolateSplitEnv,
  parseSkillFrontmatter,
  parseToolDescriptor,
} from "../src/sandbox-layer.ts";
import * as canonical from "../../src/deployment/deployment-layer.ts";
import { parseSeedSkillFrontmatter } from "../../src/skills/frontmatter.ts";

const P = (o: unknown): ReturnType<typeof parseToolDescriptor> => parseToolDescriptor(JSON.stringify(o), "t.json");
const credentialFile = (path: string) => ({ path, kind: "file" as const });
const credentialDirectory = (path: string) => ({ path, kind: "directory" as const });

test("id is the only hard-required field; the minimal descriptor parses", () => {
  assert.deepEqual(P({ id: "ex" }), { id: "ex" });
  assert.throws(() => P({}), /"id" is required/);
  assert.throws(() => P({ id: "" }), /"id" is required/);
  assert.throws(() => parseToolDescriptor("{not json}", "t.json"), /not valid JSON/);
  assert.throws(() => parseToolDescriptor("[]", "t.json"), /must be a JSON object/);
});

test("label / advertise / egress / install are shape-checked when present", () => {
  const d = P({
    id: "my-tool",
    label: "My Tool",
    advertise: "my-tool",
    egress: ["api.example.com"],
    install: { binary: "my-tool" },
  });
  assert.equal(d.label, "My Tool");
  assert.equal(d.advertise, "my-tool");
  assert.deepEqual(d.egress, ["api.example.com"]);
  assert.deepEqual(d.install, { binary: "my-tool" });
  assert.throws(() => P({ id: "x", egress: "api.example.com" }), /"egress" must be an array/);
  assert.throws(() => P({ id: "x", egress: [1] }), /"egress" must be an array/);
  assert.throws(() => P({ id: "x", install: { binary: 5 } }), /"install.binary" must be a string/);
  assert.throws(() => P({ id: "x", label: 5 }), /"label" must be a string/);
});

test("install.binary is restricted to the inert charset (it lands in generated Dockerfile RUN/COPY lines)", () => {
  assert.doesNotThrow(() => P({ id: "x", install: { binary: "my-tool2" } }));
  for (const bad of ["My Tool", "a;b", "../sh", "a$b", "a\nb", "-lead"]) {
    assert.throws(
      () => P({ id: "x", install: { binary: bad } }),
      /"install.binary" must match/,
      `expected reject: ${bad}`,
    );
  }
});

test("auth requires check + reauth; credentialPaths + splitEnv optional and shape-checked", () => {
  const d = P({
    id: "my-tool",
    auth: {
      check: "my-tool status",
      reauth: "my-tool auth login",
      credentialPaths: [credentialDirectory(".my-tool")],
      splitEnv: { MY_TOOL_ACTING_USER: "{actingSlackUserId}" },
    },
  });
  assert.equal(d.auth!.check, "my-tool status");
  assert.equal(d.auth!.reauth, "my-tool auth login");
  assert.deepEqual(d.auth!.credentialPaths, [credentialDirectory(".my-tool")]);
  assert.deepEqual(d.auth!.splitEnv, { MY_TOOL_ACTING_USER: "{actingSlackUserId}" });
  assert.throws(() => P({ id: "x", auth: { reauth: "y" } }), /"auth.check" is required/);
  assert.throws(() => P({ id: "x", auth: { check: "y" } }), /"auth.reauth" is required/);
  assert.throws(
    () => P({ id: "x", auth: { check: "a", reauth: "b", credentialPaths: "z" } }),
    /credentialPaths" must be an array/,
  );
  assert.throws(
    () => P({ id: "x", auth: { check: "a", reauth: "b", credentialPaths: [".x"] } }),
    /credentialPaths\[0\]" must be an object/,
  );
  assert.throws(
    () => P({ id: "x", auth: { check: "a", reauth: "b", credentialPaths: [{ path: ".x", kind: "other" }] } }),
    /kind file or directory/,
  );
  assert.throws(
    () => P({ id: "x", auth: { check: "a", reauth: "b", splitEnv: { K: 5 } } }),
    /splitEnv.K" must be a string/,
  );
  assert.throws(
    () => P({ id: "x", auth: { check: "a", reauth: "b", splitEnv: { K: "{unknown}" } } }),
    /may only use the \{actingSlackUserId\} placeholder/,
  );
});

test("id must match the shell/regex-inert charset (interpolated into probe scripts)", () => {
  assert.doesNotThrow(() => P({ id: "my-tool" }));
  assert.doesNotThrow(() => P({ id: "gh2" }));
  for (const bad of ["Bad", "a|b", "a b", "a'b", "-lead", "a/b"]) {
    assert.throws(() => P({ id: bad }), /must match \^\[a-z0-9\]/, `expected reject: ${bad}`);
  }
});

test("splitEnv keys must be uppercase env-var names", () => {
  assert.doesNotThrow(() =>
    P({ id: "t", auth: { check: "c", reauth: "r", splitEnv: { MY_TOOL_USER: "{actingSlackUserId}" } } }),
  );
  assert.throws(
    () => P({ id: "t", auth: { check: "c", reauth: "r", splitEnv: { "bad-key": "v" } } }),
    /must match \^\[A-Z\]/,
  );
  assert.throws(
    () => P({ id: "t", auth: { check: "c", reauth: "r", splitEnv: { lower: "v" } } }),
    /must match \^\[A-Z\]/,
  );
});

test("credentialPaths reject whitespace (device-flow capture word-splits the find roots)", () => {
  assert.throws(
    () => P({ id: "t", auth: { check: "c", reauth: "r", credentialPaths: [credentialFile(".my tool")] } }),
    /no traversal/,
  );
  assert.throws(
    () => P({ id: "t", auth: { check: "c", reauth: "r", credentialPaths: [credentialFile(".config/my\ttool")] } }),
    /no traversal/,
  );
});

test("credentialPaths must start with a dot segment (a non-hidden path would ephemeralize durable agent data)", () => {
  assert.doesNotThrow(() =>
    P({ id: "t", auth: { check: "c", reauth: "r", credentialPaths: [credentialFile(".acme/token")] } }),
  );
  for (const bad of ["workspace", "acme/token", "data/.hidden"]) {
    assert.throws(
      () => P({ id: "t", auth: { check: "c", reauth: "r", credentialPaths: [credentialFile(bad)] } }),
      /must start with a dotfile/,
      `expected reject: ${bad}`,
    );
  }
});

test("credentialPaths must be disjoint while exact file paths under one directory remain valid", () => {
  assert.throws(
    () =>
      P({
        id: "t",
        auth: {
          check: "c",
          reauth: "r",
          credentialPaths: [credentialDirectory(".acme"), credentialFile(".acme/sub/key")],
        },
      }),
    /overlap — declare disjoint paths/,
  );
  assert.doesNotThrow(() =>
    P({
      id: "t",
      auth: { check: "c", reauth: "r", credentialPaths: [credentialFile(".acme/token"), credentialFile(".acme/key")] },
    }),
  );
});

test("ReDoS guard: catastrophic-backtracking approval patterns are rejected; normal patterns pass", () => {
  assert.throws(
    () => P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+(?:(x|x)+)+$" }] }),
    /catastrophic backtracking/,
  );
  assert.throws(
    () => P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+(a+)+$" }] }),
    /catastrophic backtracking/,
  );
  assert.throws(
    () => P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+(?:ab|a?b)+$" }] }),
    /catastrophic backtracking/,
  );
  assert.throws(
    () => P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+" + "a+".repeat(8) + "$" }] }),
    /catastrophic backtracking/,
  );
  assert.throws(
    () => P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+a+(a+)$" }] }),
    /catastrophic backtracking/,
  );
  for (const adjacent of ["a+a+", "\\w+[a-z]+", "[ab]+a+", ".*a+"]) {
    assert.throws(
      () => P({ id: "acmecli", approvals: [{ pattern: `\\bacmecli\\b:${adjacent}$` }] }),
      /catastrophic backtracking/,
    );
  }
  assert.throws(
    () => P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+" + "(a|aa)".repeat(12) + "$" }] }),
    /catastrophic backtracking/,
  );
  assert.throws(
    () => P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+" + "(a|[a])".repeat(12) + "$" }] }),
    /catastrophic backtracking/,
  );
  assert.throws(
    () => P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+" + "(a*|b)".repeat(12) + "$" }] }),
    /catastrophic backtracking/,
  );
  assert.throws(() => P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b" + "a".repeat(300) }] }), /too long/);
  for (const adjacent of ["\\s+[a-z]+", "[0-9]+[a-z]+"]) {
    assert.doesNotThrow(() => P({ id: "acmecli", approvals: [{ pattern: `\\bacmecli\\b:${adjacent}$` }] }));
  }
  assert.doesNotThrow(() =>
    P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+" + "(a|b)".repeat(20) + "$" }] }),
  );
  assert.doesNotThrow(() =>
    P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+" + "(ab|ac)".repeat(20) + "$" }] }),
  );
  assert.doesNotThrow(() =>
    P({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+" + "(read|remove)".repeat(12) + "$" }] }),
  );
  assert.doesNotThrow(() => P({ id: "acmecli", approvals: [{ command: "deploy prod" }] }));
});

test("approvals: command|pattern (exactly one), decision enum, reason optional", () => {
  const d = P({
    id: "my-tool",
    approvals: [
      { command: "deploy", reason: "ships to production" },
      { command: "secrets set" },
      { command: "delete", decision: "deny" },
      { pattern: "\\bmy-tool\\b\\s+--force\\b" },
    ],
  });
  assert.equal(d.approvals!.length, 4);
  assert.deepEqual(d.approvals![0], { command: "deploy", reason: "ships to production" });
  assert.equal(d.approvals![2]!.decision, "deny");
  assert.throws(() => P({ id: "x", approvals: [{}] }), /needs a "command" or a "pattern"/);
  assert.throws(() => P({ id: "x", approvals: [{ command: "a", pattern: "b" }] }), /has both/);
  assert.throws(() => P({ id: "x", approvals: [{ command: "a", decision: "maybe" }] }), /decision must be/);
  assert.throws(() => P({ id: "x", approvals: [{ command: "a", decision: "allow" }] }), /decision must be/);
  assert.throws(() => P({ id: "x", approvals: {} }), /"approvals" must be an array/);
  assert.throws(() => P({ id: "gh", approvals: [{ pattern: "nightmare" }] }), /must refer to its own tool binary/);
  assert.throws(() => P({ id: "gh", approvals: [{ pattern: "\\bgh\\b|nightmare" }] }), /top-level alternative/);
  assert.doesNotThrow(() => P({ id: "gh", approvals: [{ pattern: "\\bgh\\b(?:\\s+repo|\\s+pr)" }] }));
});

test("compileApproval anchors a command to the binary and builds the regex; pattern is verbatim", () => {
  assert.deepEqual(compileApproval("my-tool", { command: "deploy" }), {
    pattern: "\\bmy-tool\\s+deploy(?:\\b|\\s|$)",
    decision: "require_approval",
  });
  assert.deepEqual(compileApproval("my-tool", { command: "secrets set" }), {
    pattern: "\\bmy-tool\\s+secrets\\s+set(?:\\b|\\s|$)",
    decision: "require_approval",
  });
  assert.deepEqual(compileApproval("my-tool", { command: "delete", decision: "deny" }), {
    pattern: "\\bmy-tool\\s+delete(?:\\b|\\s|$)",
    decision: "deny",
  });
  assert.deepEqual(compileApproval("my-tool", { pattern: "\\bmy-tool\\b\\s+--force\\b" }), {
    pattern: "\\bmy-tool\\b\\s+--force\\b",
    decision: "require_approval",
  });
  const { pattern } = compileApproval("my-tool", { command: "secrets set" });
  assert.ok(new RegExp(pattern).test("my-tool secrets set DB_URL=…"));
  assert.ok(!new RegExp(pattern).test("my-tool status"));
  assert.ok(!new RegExp(pattern).test("my-tool secrets setx"));
  const glob = compileApproval("tool", { command: "rm -rf *", decision: "deny" });
  assert.equal(glob.decision, "deny");
  assert.ok(new RegExp(glob.pattern).test("tool rm -rf *"));
});

test("install.binary is the approval target for command and raw-pattern rules", () => {
  const command = P({
    id: "acme",
    install: { binary: "acmectl" },
    approvals: [{ command: "delete", decision: "deny" }],
  });
  assert.deepEqual(command.approvals, [{ command: "delete", decision: "deny" }]);
  assert.doesNotThrow(() =>
    P({ id: "acme", install: { binary: "acmectl" }, approvals: [{ pattern: "\\bacmectl\\b\\s+delete" }] }),
  );
  assert.throws(
    () => P({ id: "acme", install: { binary: "acmectl" }, approvals: [{ pattern: "\\bacme\\b\\s+delete" }] }),
    /own tool binary/,
  );
});

test("interpolateSplitEnv is all-or-nothing on placeholders; literals pass through", () => {
  assert.deepEqual(interpolateSplitEnv({ A: "{actingSlackUserId}", B: "slack" }, { actingSlackUserId: "U123" }), {
    A: "U123",
    B: "slack",
  });
  assert.deepEqual(interpolateSplitEnv({ A: "{actingSlackUserId}", B: "slack" }, {}), {});
  assert.deepEqual(interpolateSplitEnv({ B: "slack" }, {}), { B: "slack" });
});

test("parseSkillFrontmatter requires name + description + body; requiredCapabilities optional", () => {
  const fm = parseSkillFrontmatter("---\nname: greet\ndescription: Greet a teammate by name.\n---\nbody", "SKILL.md");
  assert.equal(fm.name, "greet");
  assert.equal(fm.description, "Greet a teammate by name.");
  const caps = parseSkillFrontmatter(
    "---\nname: x\ndescription: y\nrequiredCapabilities: [a, b]\n---\nbody",
    "SKILL.md",
  );
  assert.deepEqual(caps.requiredCapabilities, ["a", "b"]);
  assert.throws(() => parseSkillFrontmatter("no frontmatter", "SKILL.md"), /missing YAML frontmatter/);
  assert.throws(() => parseSkillFrontmatter("---\ndescription: y\n---\nbody", "SKILL.md"), /missing "name"/);
  assert.throws(() => parseSkillFrontmatter("---\nname: x\n---\nbody", "SKILL.md"), /missing "description"/);
  assert.throws(() => parseSkillFrontmatter("---\nname: x\ndescription: y\n---\n  \n", "SKILL.md"), /requires a body/);
  for (const name of ["..", ".", "foo/bar", "foo\\bar", "foo bar", ".hidden", "foo."]) {
    assert.throws(
      () => parseSkillFrontmatter(`---\nname: ${name}\ndescription: y\n---\nbody`, "SKILL.md"),
      /skill name must/,
    );
  }
  assert.throws(
    () => parseSkillFrontmatter("---\nname: x\ndescription: y\nrequiredCapabilities: a, b\n---\nbody", "SKILL.md"),
    /must be a YAML list/,
  );
});

test("drift-lock: cli skill parser matches the core seed parser's output", () => {
  const cases = [
    "---\nname: a\ndescription: b\n---\nbody\n",
    "\uFEFF---\r\nname: a\r\ndescription: b\r\n---\r\nbody\r\n",
    "---\nname: a\ndescription: b\nrequiredCapabilities: [one, 'two']\n---\nbody\n",
    "---\nname: a\ndescription: b\nrequiredCapabilities:\n  - one\n  - two\n---\nbody\n",
    "---\nname: a\ndescription: >\n  folded description\n---\nbody\n",
    "---\nname: a\ndescription: b\nrequiredCapabilities: one, two\n---\nbody\n",
    "---\nname: a\ndescription: b\n---\n",
    "---\nname: a\ndescription: b\n---\n   \n",
    "---\ndescription: b\n---\nbody\n",
    "---\nname: a\n---\nbody\n",
    "---\nname: \ndescription: b\n---\nbody\n",
    "no frontmatter",
  ];
  for (const md of cases) {
    const cliResult = (() => {
      try {
        return parseSkillFrontmatter(md, "SKILL.md");
      } catch {
        return null;
      }
    })();
    const coreResult = (() => {
      try {
        return parseSeedSkillFrontmatter(md);
      } catch {
        return null;
      }
    })();
    assert.equal(cliResult !== null, coreResult !== null, `parsers disagree on: ${JSON.stringify(md)}`);
    if (cliResult && coreResult) {
      assert.deepEqual(cliResult, {
        name: coreResult.name,
        description: coreResult.description,
        ...(coreResult.requiredCapabilities.length ? { requiredCapabilities: coreResult.requiredCapabilities } : {}),
      });
    }
  }
});

test("drift-lock: cli sandbox-layer parser matches the canonical src/deployment schema", () => {
  const valid = [
    { id: "ex" },
    { id: "my-tool", label: "L", advertise: "a", egress: ["h"], install: { binary: "b" } },
    {
      id: "t",
      auth: {
        check: "c",
        reauth: "r",
        credentialPaths: [credentialFile(".p")],
        splitEnv: { K: "{actingSlackUserId}" },
      },
    },
    {
      id: "t",
      auth: {
        check: "c",
        reauth: "r",
        credentialPaths: [credentialDirectory(".aws"), credentialFile(".my-tool/creds")],
      },
    },
    {
      id: "t",
      auth: { check: "c", reauth: "r", credentialPaths: [credentialFile(".acme/token"), credentialFile(".acme/key")] },
    },
    { id: "t", approvals: [{ command: "deploy" }, { pattern: "\\bt\\b\\s+--force\\b", decision: "deny" }] },
    {
      id: "t",
      auth: {
        check: "c",
        reauth: "r",
        broker: {
          kind: "aws-role",
          roleArnEnv: "T_ROLE_ARN",
          region: "us-west-2",
          sessionActions: ["execute-api:Invoke"],
        },
      },
    },
    {
      id: "t",
      auth: {
        check: "c",
        reauth: "r",
        broker: {
          kind: "aws-role",
          roleArnEnv: "T_ROLE_ARN",
          regionEnv: "T_REGION",
          sessionActions: ["execute-api:Invoke", "s3:GetObject"],
        },
      },
    },
    {
      id: "t",
      install: { binary: "tool-bin" },
      approvals: [{ command: "deploy" }, { pattern: "\\btool-bin\\b\\s+--force\\b" }],
    },
  ];
  for (const v of valid) {
    assert.deepEqual(
      parseToolDescriptor(JSON.stringify(v), "t.json"),
      canonical.parseToolDescriptor(JSON.stringify(v), "t.json"),
      `valid descriptor parsed differently: ${JSON.stringify(v)}`,
    );
  }
  const invalid = [
    "{}",
    '{"id":""}',
    '{"id":"x","auth":{"check":"a"}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","broker":{"kind":"gcp","roleArnEnv":"R","region":"r","sessionActions":["a"]}}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","broker":{"kind":"aws-role","region":"r","sessionActions":["a"]}}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","broker":{"kind":"aws-role","roleArnEnv":"lower","region":"r","sessionActions":["a"]}}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","broker":{"kind":"aws-role","roleArnEnv":"R","sessionActions":["a"]}}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","broker":{"kind":"aws-role","roleArnEnv":"R","region":"r","sessionActions":[]}}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","broker":{"kind":"aws-role","roleArnEnv":"R","region":"r","sessionActions":[" "]}}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","broker":{"kind":"aws-role","roleArnEnv":"R","regionEnv":"bad-env","sessionActions":["a"]}}}',
    '{"id":"my-tool","auth":{"check":"a","reauth":"b","broker":{"kind":"aws-role","roleArnEnv":"R","region":"r","sessionActions":["a"]}}}',
    '{"id":"x","install":{"binary":"tool-bin"},"auth":{"check":"a","reauth":"b","broker":{"kind":"aws-role","roleArnEnv":"R","region":"r","sessionActions":["a"]}}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","splitEnv":{"K":"{unknown}"}}}',
    '{"id":"x","approvals":[{}]}',
    '{"id":"x","approvals":[{"command":"a","decision":"allow"}]}',
    '{"id":"gh","approvals":[{"pattern":"nightmare"}]}',
    "not json",
    '{"id":"x","auth":{"check":"a","reauth":"b","credentialPaths":[{"path":"a//b","kind":"file"}]}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","credentialPaths":[{"path":".ssh/id_rsa","kind":"file"}]}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","credentialPaths":[{"path":".config","kind":"directory"}]}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","credentialPaths":[{"path":".my-tool","kind":"directory"},{"path":".my-tool/creds","kind":"file"}]}}',
    '{"id":"Bad"}',
    '{"id":"a|b"}',
    '{"id":"x","auth":{"check":"a","reauth":"b","splitEnv":{"bad-key":"v"}}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","credentialPaths":[{"path":".my tool","kind":"file"}]}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","credentialPaths":[{"path":"workspace","kind":"directory"}]}}',
    '{"id":"x","auth":{"check":"a","reauth":"b","credentialPaths":[{"path":".acme","kind":"directory"},{"path":".acme/sub/key","kind":"file"}]}}',
    '{"id":"x","install":{"binary":"evil; rm -rf /"}}',
    JSON.stringify({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+(?:(x|x)+)+$" }] }),
    JSON.stringify({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+(a+)+$" }] }),
    JSON.stringify({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+(?:ab|a?b)+$" }] }),
    JSON.stringify({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+" + "a+".repeat(8) + "$" }] }),
    JSON.stringify({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+a+(a+)$" }] }),
    JSON.stringify({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b:\\w+[a-z]+$" }] }),
    JSON.stringify({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+" + "(a|aa)".repeat(12) + "$" }] }),
    JSON.stringify({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b\\s+" + "(a|a)".repeat(12) + "$" }] }),
    JSON.stringify({ id: "t", install: { binary: "tool-bin" }, approvals: [{ pattern: "\\bt\\b\\s+deploy" }] }),
    JSON.stringify({ id: "acmecli", approvals: [{ pattern: "\\bacmecli\\b" + "a".repeat(300) }] }),
  ];
  for (const raw of invalid) {
    const cliErr = (() => {
      try {
        parseToolDescriptor(raw, "t.json");
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    })();
    const canErr = (() => {
      try {
        canonical.parseToolDescriptor(raw, "t.json");
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    })();
    assert.ok(cliErr !== null && canErr !== null, `both should reject: ${raw}`);
    assert.equal(cliErr, canErr, `error message drift on: ${raw}`);
  }
  assert.deepEqual(compileApproval("t", { command: "a b" }), canonical.compileApproval("t", { command: "a b" }));
  assert.deepEqual(
    interpolateSplitEnv({ A: "{actingSlackUserId}" }, {}),
    canonical.interpolateSplitEnv({ A: "{actingSlackUserId}" }, {}),
  );
  assert.deepEqual(interpolateSplitEnv({ A: "{constructor}" }, {}), {});
  assert.deepEqual(canonical.interpolateSplitEnv({ A: "{constructor}" }, {}), {});
});
