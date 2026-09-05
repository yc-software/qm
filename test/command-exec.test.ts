import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnCommandExec } from "../src/sandbox/command-exec.ts";
import { spawnDockerExec } from "../src/sandbox/docker-exec.ts";

test("command runner sends literal stdin and closes it", async () => {
  const input = '{"value":"$(echo nope) `echo nope` \\n"}';
  const result = await spawnCommandExec(process.execPath)(["-e", "process.stdin.pipe(process.stdout)"], 5000, input);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, input);
  assert.equal(spawnDockerExec, spawnCommandExec);
});

test("command runner closes stdin when no input is supplied", async () => {
  const result = await spawnCommandExec(process.execPath)(
    ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log('done'))"],
    5000,
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "done");
});

test("command runner reports missing binaries and timeout", async () => {
  assert.equal((await spawnCommandExec("/no-such-qm-binary")([])).code, -1);
  assert.equal((await spawnCommandExec(process.execPath)(["-e", "setInterval(()=>{},1000)"], 50)).code, -1);
});
