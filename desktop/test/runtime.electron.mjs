import assert from "node:assert/strict";
import { app, nativeImage } from "electron";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qm-runtime-test-"));
  const binary = path.join(directory, "desk.mjs");
  process.env.QM_DESK_BIN = binary;
  process.env.QM_DESK_CURSOR = "0";
  const screenshot = nativeImage
    .createFromBuffer(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 })
    .toPNG()
    .toString("base64");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { createInterface } from 'node:readline';
createInterface({input: process.stdin}).on('line', line => {
 const {id,cmd} = JSON.parse(line);
 const observation = {app:'Fixture',window:'Fixture window',frame:{w:100,h:100},elements:1,tree:'[1] Button',diffed:false,removed:[],...(cmd.screenshot ? {screenshot:{png_base64:${JSON.stringify(screenshot)}}}: {})};
 const reply = cmd.type === 'apps' ? {type:'apps',apps:[{name:'Fixture',bundle_id:'test.fixture',pid:1,active:true}]} : cmd.type === 'observe' ? {type:'observation',...observation} : {type:'acted',completed:1, failure:null};
 process.stdout.write(JSON.stringify({id,reply})+'\\n');
});
`,
  );
  await chmod(binary, 0o700);
  await app.whenReady();
  app.on("window-all-closed", () => {});
  const { callComputer, registerComputerRuntime, stopComputer } = await import("../runtime.mjs");
  registerComputerRuntime((reply) => reply);
  const call = (code, owner = "first", extra = {}) => callComputer({ code, ...extra }, owner, Date.now() + 10_000);
  try {
    let result = await call("var answer = 41; answer + 1");
    assert.match(result.content, /computer API/);
    assert.match(result.content, /=> 42/);
    result = await call("answer + 2");
    assert.match(result.content, /=> 43/);
    assert.doesNotMatch(result.content, /computer API/);
    await assert.rejects(call("1", "second"), /Another desktop turn/);
    result = await call(
      "var fixture = await computer.getApp('Fixture'); await fixture.click(1); await fixture.getAXState()",
    );
    assert.match(result.content, /Fixture window/);
    assert.equal(result.content.split("Fixture window").length - 1, 1);
    result = await call("await fixture.getScreenshot()");
    assert.equal(result.images?.[0]?.mimeType, "image/jpeg");
    assert.ok(result.images[0].data.length > 0);
    assert.equal(result.content.includes(result.images[0].data), false);
    result = await call("await fixture.getAXStateAndScreenshot({disableDiffing:true}); void 0");
    assert.match(result.content, /Fixture window/);
    assert.equal(result.images.length, 1);
    result = await call("for (let i=0;i<5;i++) await fixture.getScreenshot()");
    assert.equal(result.images.length, 4);
    assert.match(result.content, /screenshot dropped/);
    result = await call("typeof answer", "first", { reset: true });
    assert.match(result.content, /undefined/);
    assert.match(result.content, /computer API/);
    const pending = call("await new Promise(() => {})");
    setTimeout(() => stopComputer("first"), 50);
    await assert.rejects(pending);
    await assert.rejects(call("1"), /ended/);
    result = await call("typeof fixture", "second");
    assert.match(result.content, /undefined/);
    await assert.rejects(callComputer({ code: "while (true) {}" }, "second", Date.now() + 100), /timed out/);
    result = await call("6 * 7", "second");
    assert.match(result.content, /=> 42/);
    const running = call("await new Promise(() => {})", "second");
    const queued = call("1", "third");
    const stopped = Promise.all([assert.rejects(running), assert.rejects(queued, /ended/)]);
    setTimeout(() => stopComputer(), 50);
    await stopped;
    result = await call("6 * 7", "fourth");
    assert.match(result.content, /=> 42/);
    console.log(
      "PASS: persistent JavaScript, native bridge, screenshots, reset, exclusive turns, cancellation, timeout recovery",
    );
  } finally {
    stopComputer();
    await rm(directory, { recursive: true, force: true });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
