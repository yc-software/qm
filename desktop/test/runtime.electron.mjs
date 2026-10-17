import assert from "node:assert/strict";
import { app, nativeImage } from "electron";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qm-runtime-test-"));
  const binary = path.join(directory, "desk.mjs");
  const acts = path.join(directory, "acts.jsonl");
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
import { appendFileSync } from 'node:fs';
createInterface({input: process.stdin}).on('line', line => {
 const {id,cmd} = JSON.parse(line);
 if (cmd.type === 'act') appendFileSync(${JSON.stringify(acts)}, JSON.stringify(cmd.actions)+'\\n');
 const observation = {app:'Fixture',window:'Fixture window',frame:{x:10,y:20,w:100,h:100},elements:1,tree:'[1] Button',diffed:false,removed:[],...(cmd.diff ? {tree:'~ [1] Button',diffed:true,removed:[3,4,5,9]} : {}),...(cmd.screenshot ? {screenshot:{png_base64:${JSON.stringify(screenshot)},frame:{x:0,y:20,w:200,h:100}}}: {})};
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
    assert.match(result.content, /app\.paste\(text/);
    assert.match(result.content, /=> 42/);
    result = await call("answer + 2");
    assert.match(result.content, /=> 43/);
    assert.doesNotMatch(result.content, /computer API/);
    await assert.rejects(call("1", "second"), /Another desktop turn/);
    result = await call(
      "var fixture = await computer.getApp('Fixture'); await fixture.click(1); await fixture.getAXState()",
    );
    assert.match(result.content, /Fixture window/);
    assert.equal(result.content.split("Fixture window").length - 1, 2);
    assert.match(result.content, /changes since last state \(\+ added, ~ changed\)/);
    assert.match(result.content, /removed: 3-5, 9/);
    await call(
      "await fixture.typeText('a\\tb\\n'); await fixture.paste('# Hi\\n\\n- one', {format: 'markdown'}); await fixture.paste(42)",
    );
    const sent = (await readFile(acts, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(sent.slice(-3), [
      [{ type: "type_text", text: "a\tb\n" }],
      [{ type: "paste", text: "# Hi\n\n- one", format: "markdown" }],
      [{ type: "paste", text: "42", format: "text" }],
    ]);
    result = await call("await fixture.getScreenshot()");
    assert.equal(result.images?.[0]?.mimeType, "image/jpeg");
    assert.ok(result.images[0].data.length > 0);
    assert.equal(result.content.includes(result.images[0].data), false);
    result = await call("await fixture.getAXStateAndScreenshot({disableDiffing:true}); void 0");
    assert.match(result.content, /Fixture window/);
    assert.equal(result.images.length, 1);
    await call("await fixture.click([1, 0])");
    const clicked = (await readFile(acts, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .at(-1)[0].target.point;
    assert.deepEqual([Math.round(clicked.x), Math.round(clicked.y)], [190, 0]);
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
      "PASS: persistent JavaScript, native bridge, typing and paste requests, screenshots, reset, exclusive turns, cancellation, timeout recovery",
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
