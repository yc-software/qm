import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext } from "../src/tools/primitives.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

function ctx(onEnsure: (dir: string) => void) {
  const materialized = new Set<string>();
  const runCommand = (command: string) => {
    const wants = /(?:^|[\s'"=(&|;])(?:\.\/)?skills\/([^/\s'"&|;)]+)/.exec(command)?.[1];
    const present = !wants || materialized.has(wants);
    return present
      ? { stdout: "ran", stderr: "", code: 0, timedOut: false }
      : { stdout: "", stderr: `ModuleNotFoundError: skills/${wants} assets missing`, code: 1, timedOut: false };
  };
  const sandbox = {
    readFile: async (_h: SandboxHandle, _p: string) => null,
    run: async (_h: SandboxHandle, command: string) => runCommand(command),
  } as unknown as Sandbox;
  const backgroundBroker = {
    start: async (_h: SandboxHandle, command: string) => {
      const r = runCommand(command);
      return {
        processId: "p1",
        output: r.stdout || r.stderr,
        cursor: 0,
        status: { state: "exited", exitCode: r.code },
        reattached: false,
      };
    },
  };
  return createToolContext({
    sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }) as SandboxHandle,
    ensureSkillTree: async (dir: string) => {
      materialized.add(dir);
      onEnsure(dir);
    },
    backgroundBroker: backgroundBroker as never,
    layers: [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });
}

test("reading skills/<name>/SKILL.md triggers lazy materialization of that skill", async () => {
  const seen: string[] = [];
  const tc = ctx((d) => seen.push(d));
  await tc.read("skills/popular-web-designs/SKILL.md");
  assert.deepEqual(seen, ["popular-web-designs"]);
});

test("a leading ./ on the SKILL.md path still triggers materialization", async () => {
  const seen: string[] = [];
  const tc = ctx((d) => seen.push(d));
  await tc.read("./skills/taste-skill/SKILL.md");
  assert.deepEqual(seen, ["taste-skill"]);
});

test("reading an asset inside a skill dir does NOT trigger materialization (only SKILL.md does)", async () => {
  const seen: string[] = [];
  const tc = ctx((d) => seen.push(d));
  await tc.read("skills/popular-web-designs/scripts/render.py");
  await tc.read("skills/foo/references/notes.md");
  await tc.read("outbox/report.md");
  assert.deepEqual(seen, [], "no lazy trigger for non-SKILL.md reads");
});

test("executing a skill's script on a cold box (no prior SKILL.md read) materializes its tree first", async () => {
  const seen: string[] = [];
  const tc = ctx((d) => seen.push(d));
  const r = await tc.execute("cd skills/google-workspace && python scripts/gmail.py");
  assert.deepEqual(seen, ["google-workspace"], "execute materialized the referenced skill tree");
  assert.equal(r.code, 0, "the command ran cleanly because the assets were laid before it ran");
});

test("executing a script by path under a skill dir also materializes that skill", async () => {
  const seen: string[] = [];
  const tc = ctx((d) => seen.push(d));
  const r = await tc.execute("python skills/email-voice-profile/scripts/fetch_sent.py");
  assert.deepEqual(seen, ["email-voice-profile"]);
  assert.equal(r.code, 0);
});

test("an execute that references no skill dir does NOT materialize anything", async () => {
  const seen: string[] = [];
  const tc = ctx((d) => seen.push(d));
  await tc.execute("echo hello && ls skills");
  assert.deepEqual(seen, [], "no skill dir referenced ⇒ no lazy trigger");
});

test("a background job that runs a skill's script materializes its tree first too", async () => {
  const seen: string[] = [];
  const tc = ctx((d) => seen.push(d));
  const r = await tc.backgroundStart("cd skills/google-workspace && python scripts/gmail.py");
  assert.deepEqual(seen, ["google-workspace"], "background materialized the referenced skill tree");
  assert.equal(r.status.state, "exited");
  assert.equal(r.output, "ran", "the job ran cleanly because the assets were laid before it started");
});
