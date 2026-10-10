import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeTimeoutMarker, withGroupTimeout } from "../src/sandbox/exec-timeout.ts";

const run = (command: string, timeoutSec: number, graceSec = 1) => {
  const { script, nonce } = withGroupTimeout(command, timeoutSec, graceSec);
  const r = spawnSync("sh", ["-c", script], { encoding: "utf8", timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, ...takeTimeoutMarker(r.stderr, nonce) };
};
const alive = (pidFile: string): boolean =>
  existsSync(pidFile) && spawnSync("kill", ["-0", readFileSync(pidFile, "utf8").trim()]).status === 0;
const settle = () => spawnSync("sleep", ["1.5"]);

test("a command that finishes in time is not marked, and keeps its own exit code", () => {
  const r = run("echo hi; echo err >&2; exit 124", 5);
  assert.deepEqual(r, { code: 124, stdout: "hi\n", stderr: "err\n", timedOut: false });
});

test("output can't forge the timeout marker: it needs this exec's random nonce", () => {
  const forged = "\\n__QM_EXEC_TIMED_OUT_deadbeef__\\n";
  const r = run(`printf 'real${forged}' >&2`, 5);
  assert.equal(r.timedOut, false);
  assert.equal(r.stderr, `real${forged.replaceAll("\\n", "\n")}`);
});

test("a timeout is reported by marker and kills a plain background child", () => {
  const d = mkdtempSync(join(tmpdir(), "to-"));
  const r = run(`sleep 300 & echo $! > ${d}/c; echo started; wait`, 1);
  assert.equal(r.timedOut, true);
  assert.equal(r.stdout, "started\n");
  settle();
  assert.equal(alive(`${d}/c`), false);
});

test("a child that ignores TERM is KILLed after the grace period, even after its parent exits", () => {
  const d = mkdtempSync(join(tmpdir(), "to-"));
  const r = run(`sh -c 'trap "" TERM; echo $$ > ${d}/c; while :; do sleep 0.2; done' & wait`, 1, 1);
  assert.equal(r.timedOut, true);
  settle();
  assert.equal(alive(`${d}/c`), false);
});

test("a TERM-ignoring command itself is KILLed and still marked", () => {
  const r = run(`trap "" TERM; while :; do sleep 0.2; done`, 1, 1);
  assert.equal(r.timedOut, true);
  assert.notEqual(r.code, 0);
});

test("a child that moved to its own session with setsid is still found and killed", () => {
  const d = mkdtempSync(join(tmpdir(), "to-"));
  const r = run(`setsid sh -c 'echo $$ > ${d}/c; trap "" TERM; sleep 300' & sleep 60`, 1, 1);
  assert.equal(r.timedOut, true);
  settle();
  assert.equal(alive(`${d}/c`), false);
});

test("the command stays in the caller's process group, so a group kill from outside still reaches it", () => {
  const d = mkdtempSync(join(tmpdir(), "to-"));
  const { script } = withGroupTimeout(`echo $$ > ${d}/c; sleep 300`, 60);
  const outer = spawnSync(
    "sh",
    ["-c", `setsid sh -c ${JSON.stringify(script)} & sleep 0.5; kill -KILL -- -$!; sleep 0.3`],
    {
      encoding: "utf8",
    },
  );
  assert.equal(outer.status, 0);
  assert.equal(alive(`${d}/c`), false);
});

test("a snapshot entry whose pid now belongs to a different process is not signalled", () => {
  const { script } = withGroupTimeout("true", 5);
  const helpers = script.split("\n").slice(0, 1).join("\n");
  const d = mkdtempSync(join(tmpdir(), "to-"));
  const r = spawnSync(
    "sh",
    [
      "-c",
      `${helpers}
sleep 300 & v=$!
echo "$v 1" > ${d}/m
__m=${d}/m
while read __t __st0; do [ "$__st0" = - ] || [ "$(__st \${__t#-})" = "$__st0" ] || continue; kill -KILL "$__t"; done < "$__m"
kill -0 $v && echo spared; echo "$v $(__st $v)" > ${d}/m
while read __t __st0; do [ "$__st0" = - ] || [ "$(__st \${__t#-})" = "$__st0" ] || continue; kill -KILL "$__t"; done < "$__m"
sleep 0.2; kill -0 $v 2>/dev/null || echo killed`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(r.stdout, "spared\nkilled\n");
});
