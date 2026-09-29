import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chromium } from "playwright";
import {
  backgroundLifecycle,
  configureLifecyclePage,
  foregroundLifecycle,
  launchLifecycleBrowser,
  lifecycleSnapshot,
} from "./browser-lifecycle.mjs";

const html = `<!doctype html><meta charset="utf-8"><title>Owned lifecycle probe</title>
<style>input{position:absolute;left:40px;top:40px;width:220px;height:50px}output{position:absolute;top:120px}</style>
<input id="probe"><output id="state">initial</output><script>
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&window.blockMs!==undefined){
    const ms=window.blockMs;delete window.blockMs;document.querySelector('#state').textContent='loaded';
    requestAnimationFrame(()=>setTimeout(()=>{
      console.log('OWNED_BLOCK_START');const end=performance.now()+ms;while(performance.now()<end){}
      document.querySelector('#state').textContent='ready';
    },0));
  }
});
document.querySelector('#probe').addEventListener('input',()=>document.querySelector('#state').textContent='typed');
</script>`;

test(
  "owned default-context browser reports genuine tab return with renderer stalls, native input and paint",
  { timeout: 45000 },
  async (t) => {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(html);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let owned, emulated, cleanup;
    const results = [];
    try {
      owned = await launchLifecycleBrowser();
      t.diagnostic(JSON.stringify({ launch: owned.launch }));
      assert.equal(owned.context, owned.browser.contexts()[0]);
      assert.equal(owned.browser.contexts().length, 1);
      assert.equal(
        owned.launch.args.some((arg) =>
          /disable-background-timer|disable-renderer-background|disable-backgrounding-occluded|enable-automation/.test(
            arg,
          ),
        ),
        false,
      );
      await owned.context.setStorageState({
        cookies: [{ name: "owned-test", value: "yes", url: origin }],
        origins: [{ origin, localStorage: [{ name: "owned-test", value: "yes" }] }],
      });
      await owned.context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
      );
      const page = await owned.context.newPage(),
        cover = await owned.context.newPage();
      assert.ok((await lifecycleSnapshot(page)).instance);
      for (const current of [page, cover]) {
        current.setDefaultTimeout(5000);
        const session = await configureLifecyclePage(current, {
          viewport: { width: 1000, height: 800 },
          locale: "en-US",
          timezoneId: "UTC",
        });
        await session.send("Network.enable");
        await session.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: 10000000,
          uploadThroughput: 10000000,
        });
        await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        await current.goto(origin + (current === page ? "/return" : "/cover"));
      }
      assert.deepEqual(
        await page.evaluate(() => ({
          width: globalThis.innerWidth,
          height: globalThis.innerHeight,
          locale: Intl.NumberFormat().resolvedOptions().locale,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          storage: localStorage.getItem("owned-test"),
          cookie: globalThis.document.cookie,
        })),
        { width: 1000, height: 800, locale: "en-US", timezone: "UTC", storage: "yes", cookie: "owned-test=yes" },
      );
      await page.evaluate(() => navigator.serviceWorker.register("/worker.js"));
      assert.equal(requests.includes("/worker.js"), false);
      assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null);
      assert.deepEqual(
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((x) => x.scope)),
        [],
      );
      await page.bringToFront();
      await page.mouse.click(100, 65);
      for (const blockMs of [0, 1200]) {
        const background = await backgroundLifecycle(page, cover);
        await page.evaluate((ms) => {
          globalThis.blockMs = ms;
          globalThis.document.querySelector("#probe").value = "";
        }, blockMs);
        const block = page.waitForEvent("console", { predicate: (message) => message.text() === "OWNED_BLOCK_START" });
        const result = await foregroundLifecycle(page, background, async (current) => {
          await block;
          const startedMs = performance.now();
          let clickMs, keyboardMs;
          await Promise.all([
            current.mouse.click(100, 65).then(() => {
              clickMs = performance.now() - startedMs;
            }),
            current.keyboard.type("z").then(() => {
              keyboardMs = performance.now() - startedMs;
            }),
          ]);
          assert.equal(await current.locator("#probe").inputValue(), "z");
          assert.equal(await current.locator("#state").textContent(), "typed");
          return { clickMs, keyboardMs };
        });
        if (blockMs) {
          assert.ok(result.durationMs >= 1200);
          assert.ok(
            result.after.longTasks.some((entry) => entry.startTime >= result.hidden.now && entry.duration >= 1180),
          );
        }
        results.push({ blockMs, ...result });
        t.diagnostic(JSON.stringify({ blockMs, durationMs: result.durationMs, interaction: result.interaction }));
        await assert.rejects(
          foregroundLifecycle(page, background, async () => {}),
          /already used/,
        );
      }
      const background = await backgroundLifecycle(page, cover);
      await page.evaluate(() => {
        globalThis.document.querySelector("#probe").value = "";
        setTimeout(() => {
          console.log("OWNED_HIDDEN_BLOCK_START");
          const until = performance.now() + 1200;
          while (performance.now() < until) Math.sqrt(performance.now());
        }, 100);
      });
      await page.waitForEvent("console", { predicate: (message) => message.text() === "OWNED_HIDDEN_BLOCK_START" });
      const calledMs = performance.now();
      const hiddenBlock = await foregroundLifecycle(page, background, async (current) => {
        await current.mouse.click(100, 65);
        await current.keyboard.type("z");
        assert.equal(await current.locator("#probe").inputValue(), "z");
      });
      assert.ok(hiddenBlock.startedMs - calledMs < 100);
      assert.ok(hiddenBlock.durationMs >= 1100);
      t.diagnostic(JSON.stringify({ preExistingHiddenBlock: true, calledMs, ...hiddenBlock }));
      const staleBackground = await backgroundLifecycle(page, cover);
      await page.bringToFront();
      await page.waitForFunction(
        () => globalThis.document.visibilityState === "visible" && globalThis.document.hasFocus(),
      );
      const beforeStale = await lifecycleSnapshot(page);
      let staleInteraction = false;
      await assert.rejects(
        foregroundLifecycle(page, staleBackground, async (current) => {
          staleInteraction = true;
          await current.mouse.click(100, 65);
          await current.keyboard.type("k");
        }),
        /visible.*hidden/s,
      );
      assert.equal(staleInteraction, false);
      t.diagnostic(JSON.stringify({ firstUseStaleReceiptRejected: true, beforeStale }));
      const beforeReload = await backgroundLifecycle(page, cover);
      await page.reload();
      const documentAfter = await lifecycleSnapshot(page);
      assert.notEqual(documentAfter.instance, beforeReload.hidden.instance);
      await assert.rejects(
        foregroundLifecycle(page, beforeReload, async () => {}),
        /document changed/,
      );
      emulated = await chromium.connectOverCDP(owned.launch.endpoint);
      const unowned = await owned.browser.newContext();
      try {
        const unownedPage = await unowned.newPage();
        await assert.rejects(lifecycleSnapshot(unownedPage), /owned default context/);
      } finally {
        await unowned.close();
      }
      await page.bringToFront();
      await assert.rejects(backgroundLifecycle(page, cover, 200), /Timeout/);
      assert.equal((await lifecycleSnapshot(page)).visibility, "visible");
      t.diagnostic(
        JSON.stringify({
          qualified: false,
          syntheticOnly: true,
          launch: owned.launch,
          browserVersion: owned.browser.version(),
          results,
          defaultEmulatedPathRejected: true,
          serviceWorkerRegistrationBlocked: true,
          configAndAuthRestored: true,
        }),
      );
    } finally {
      try {
        if (emulated) await emulated.close();
        if (owned) cleanup = await owned.close();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
    assert.ok(cleanup.processGroupAbsent && cleanup.profileRemoved);
    await assert.rejects(access(cleanup.profile), { code: "ENOENT" });
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(owned.launch.reaperPid, 0);
      } catch (error) {
        assert.equal(error.code, "ESRCH");
        break;
      }
      await delay(25);
    }
    assert.throws(() => process.kill(owned.launch.reaperPid, 0), { code: "ESRCH" });
    t.diagnostic(JSON.stringify({ cleanup, serverClosed: !server.listening }));
  },
);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") return true;
    assert.equal(error.code, "ESRCH");
    return false;
  }
}

test("startup refusals leave no profile", { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qm-lifecycle-refusal-"));
  try {
    for (const executablePath of [join(directory, "missing"), "\0"]) {
      const source = `
        import assert from "node:assert/strict";
        import { launchLifecycleBrowser } from ${JSON.stringify(new URL("./browser-lifecycle.mjs", import.meta.url).href)};
        await assert.rejects(launchLifecycleBrowser({executablePath:${JSON.stringify(executablePath)},startupTimeoutMs:1000}),error=>{
          console.log(JSON.stringify({message:error.message,cleanup:error.cleanup}));return true;
        });`;
      const owner = spawn(process.execPath, ["--input-type=module", "-e", source], {
        env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        stderr = "";
      owner.stdout.on("data", (chunk) => {
        output += chunk;
      });
      owner.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise((resolve, reject) => {
        owner.once("error", reject);
        owner.once("exit", resolve);
      });
      assert.equal(code, 0, stderr);
      assert.deepEqual(await readdir(directory), []);
      t.diagnostic(output.trim());
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "guardian owns resources across startup, ready owner death and a transient denied existence probe",
  { timeout: 45000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "qm-lifecycle-owner-test-"));
    const preload = join(directory, "observe.cjs");
    await writeFile(
      preload,
      `
    const cp=require('node:child_process'),fs=require('node:fs');
    const record=value=>fs.appendFileSync(process.env.QM_TEST_RECEIPT,JSON.stringify(value)+'\\n');
    let profilePath, deniedProbe=false;
    const kill=process.kill;
    process.kill=function(pid,signal){
      if(profilePath&&process.env.QM_TEST_STAGE==='probe'&&pid<0&&signal===0&&!deniedProbe){
        deniedProbe=true;
        record({stage:'probe',profile:profilePath,reaperPid:process.pid,targetPid:pid,signal,modeledError:'EPERM'});
        throw Object.assign(new Error('Modeled transient existence probe refusal'),{code:'EPERM'});
      }
      try{return kill.call(this,pid,signal);}
      catch(error){if(profilePath&&error.code!=='ESRCH')record({stage:'guardian-kill-error',profile:profilePath,reaperPid:process.pid,targetPid:pid,signal,code:error.code});throw error;}
    };
    const stderrWrite=process.stderr.write;
    process.stderr.write=function(chunk,...args){
      if(profilePath)record({stage:'guardian-stderr',profile:profilePath,reaperPid:process.pid,text:String(chunk).slice(-16384)});
      return stderrWrite.call(this,chunk,...args);
    };
    process.on('exit',code=>{if(profilePath)record({stage:'guardian-exit',profile:profilePath,reaperPid:process.pid,code});});
    process.on('uncaughtExceptionMonitor',error=>{if(profilePath)record({stage:'guardian-uncaught',profile:profilePath,reaperPid:process.pid,code:error.code,message:error.message,stack:error.stack});});
    process.on('disconnect',()=>{if(profilePath)record({stage:'guardian-disconnect',profile:profilePath,reaperPid:process.pid});});
    const allocate=fs.mkdtempSync;
    fs.mkdtempSync=function(prefix,...args){
      const profile=allocate(prefix,...args);
      if(prefix.endsWith('qm-lifecycle-')){
        profilePath=profile;
        record({stage:'allocation',profile,reaperPid:process.pid});
        if(process.env.QM_TEST_STAGE==='allocation')process.kill(Number(process.env.QM_TEST_OWNER),'SIGKILL');
      }
      return profile;
    };
    const remove=fs.rmSync;
    fs.rmSync=function(profile,options){
      try {
        const result=remove(profile,options);
        if(String(profile).includes('qm-lifecycle-'))record({stage:'removed',profile,reaperPid:process.pid});
        return result;
      } catch(error) {
        record({stage:'cleanup-error',profile,reaperPid:process.pid,code:error.code,message:error.message});
        throw error;
      }
    };
    const spawn=cp.spawn;
    cp.spawn=function(executable,args,options){
      const child=spawn(executable,args,options);
      const flag=args?.find(x=>x.startsWith('--user-data-dir='));
      if(flag&&child.pid){
        record({stage:'spawn',pid:child.pid,profile:flag.slice('--user-data-dir='.length),reaperPid:process.pid});
        if(process.env.QM_TEST_STAGE==='spawn')process.kill(Number(process.env.QM_TEST_OWNER),'SIGKILL');
      }
      return child;
    };
    require('node:module').syncBuiltinESMExports();
  `,
    );
    let failed = false;
    try {
      for (const stage of ["allocation", "spawn", "ready", "probe"]) {
        const receipt = join(directory, stage + ".jsonl");
        const source = `
        import {appendFileSync} from 'node:fs';
        process.env.QM_TEST_OWNER=String(process.pid);
        const {launchLifecycleBrowser}=await import(${JSON.stringify(new URL("./browser-lifecycle.mjs", import.meta.url).href)});
        const owned=await launchLifecycleBrowser();
        appendFileSync(process.env.QM_TEST_RECEIPT,JSON.stringify({stage:'ready',...owned.launch})+'\\n');
        process.kill(process.pid,'SIGKILL');`;
        const owner = spawn(process.execPath, ["--input-type=module", "-e", source], {
          env: {
            ...process.env,
            NODE_OPTIONS: `--require=${preload}`,
            TMPDIR: directory,
            TMP: directory,
            TEMP: directory,
            QM_TEST_STAGE: stage,
            QM_TEST_RECEIPT: receipt,
          },
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        owner.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        let rows = [];
        try {
          const exit = await new Promise((resolve, reject) => {
            owner.once("error", reject);
            owner.once("exit", (code, signal) => resolve({ code, signal }));
          });
          assert.deepEqual(exit, { code: null, signal: "SIGKILL" }, stderr);
          for (let i = 0; i < 200; i++) {
            rows = (await readFile(receipt, "utf8")).trim().split("\n").map(JSON.parse);
            if (rows.every((row) => !alive(row.reaperPid) && (!row.pid || !alive(-row.pid)))) break;
            await delay(50);
          }
          const profiles = [];
          for (const profile of new Set(rows.map((row) => row.profile))) {
            try {
              profiles.push({ profile, entries: await readdir(profile, { recursive: true }) });
            } catch (error) {
              profiles.push({ profile, error: error.code });
            }
          }
          const boundary = { stage, exit, rows, profiles };
          await writeFile(join(directory, stage + "-boundary.json"), JSON.stringify(boundary, null, 2));
          t.diagnostic(JSON.stringify(boundary));
          assert.ok(rows.some((row) => row.stage === stage));
          for (const row of rows) {
            assert.equal(alive(row.reaperPid), false);
            if (row.pid) assert.equal(alive(-row.pid), false);
            await assert.rejects(access(row.profile), { code: "ENOENT" });
          }
          t.diagnostic(JSON.stringify({ stage, exit, rows, processGroupsAbsent: true, profilesRemoved: true }));
        } catch (error) {
          failed = true;
          await writeFile(
            join(directory, stage + "-failure.json"),
            JSON.stringify({ rows, stderr, message: error.message }, null, 2),
          );
          t.diagnostic(`Owner failure receipts retained at ${directory}`);
          throw error;
        } finally {
          if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
          for (const row of rows) {
            if (row.pid && alive(-row.pid)) process.kill(-row.pid, "SIGKILL");
            if (alive(row.reaperPid)) process.kill(row.reaperPid, "SIGTERM");
          }
        }
      }
      assert.equal(
        (await readdir(directory)).some((name) => name.startsWith("qm-lifecycle-")),
        false,
      );
    } finally {
      if (!failed) await rm(directory, { recursive: true, force: true });
    }
  },
);
