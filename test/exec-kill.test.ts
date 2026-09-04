import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killableScript, killScript, pgidMarkerPath } from "../src/sandbox/exec-kill.ts";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";
import { installFakeSprites, type FakeSprites } from "./support/fake-sprites.ts";

test("killableScript: records its PGID to the per-exec marker first, runs under setsid, preserves rc", () => {
  const s = killableScript("do_work", "abc");
  assert.match(s, /^exec setsid sh -c /, "the command must become its own session/group leader");
  assert.ok(s.includes(pgidMarkerPath("abc")), "the marker path is the per-exec uid");
  assert.ok(s.includes("echo $$ >"), "the leader writes its own pid (== PGID under setsid)");
  assert.ok(s.includes("do_work"), "the inner command is preserved");
  assert.ok(s.includes("__pi_exec_rc=$?") && s.includes("exit $__pi_exec_rc"), "the inner exit code is preserved");
});

test("killScript: SIGKILLs the whole process group from the marker, retrying for the write race", () => {
  const s = killScript("abc");
  assert.ok(s.includes(`cat '${pgidMarkerPath("abc")}'`), "reads the recorded PGID");
  assert.ok(s.includes('kill -KILL -"$pgid"'), "negative pgid ⇒ kills the whole group");
  assert.match(s, /while \[ \$i -lt 5 \]/, "retries a few times to cover the marker-write race");
  assert.ok(s.includes("sleep 0.1"), "spaces retries over a few hundred ms");
});

let ff: FakeSprites;
before(() => {
  ff = installFakeSprites();
});
after(() => ff.cleanup());

function sprites(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "sprites-kill-ws-"));
  return createSpritesSandbox(createLocalWorkspaceStore(dir), {
    token: "test-token",
    client: ff.client,
    fetchImpl: ff.fetchImpl,
  });
}
const rw = [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" as const }];

test("run() with a signal wraps the command in the killable process group; without a signal it does not", async () => {
  const sb = sprites();
  const h = await sb.provision(rw);

  let mark = ff.execScripts().length;
  await sb.run(h, "true");
  assert.ok(!ff.execScripts()[mark]!.includes("setsid"), "no signal ⇒ the un-killable path is unchanged");

  mark = ff.execScripts().length;
  await sb.run(h, "true", { signal: new AbortController().signal });
  assert.ok(ff.execScripts()[mark]!.includes("exec setsid sh -c"), "a signal ⇒ the command runs killable");
});

test("run(): an already-aborted signal fires a separate SIGKILL exec at the recorded group", async () => {
  const sb = sprites();
  const h = await sb.provision(rw);

  const ctrl = new AbortController();
  ctrl.abort();
  await sb.run(h, "true", { signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 50));
  const killCalls = ff.execScripts().filter((script) => script.includes("kill -KILL"));
  assert.ok(killCalls.length >= 1, "an aborted signal fires a separate kill-the-group exec");
});
