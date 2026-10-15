import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "browse-service-test-"));
  await copyFile(
    new URL("../skills-seed/browse/scripts/browser-service.mjs", import.meta.url),
    join(dir, "browser-service.mjs"),
  );
  const files: Record<string, string> = {
    "state.mjs": `import {EventEmitter} from "node:events";export const calls=[]; export const failures=new Set(); export function call(name) { calls.push(name); if(failures.has(name)) throw new Error(name); }
      export const browser=Object.assign(new EventEmitter(),{bind:async(title,options)=>{call('bind'); if(options.host!=='127.0.0.1') throw Error('not local'); return {endpoint:'ws://local/secret'}},unbind:async()=>call('unbind'),close:async()=>call('close')});`,
    "runtime.mjs": `import {browser,call} from './state.mjs'; export const chromium={connectOverCDP:async(endpoint,options)=>{call('connect');if(endpoint!=='ws://proxy/secret'||options.noDefaults)throw Error('wrong connection');return browser}};`,
    "playwright-runtime.mjs": `import {call} from './state.mjs';import {fileURLToPath}from'node:url';export async function ensurePlaywright(){call('runtime');return fileURLToPath(new URL('./runtime.mjs',import.meta.url))}`,
    "browser-proxy.mjs": `import {call,failures}from'./state.mjs';export async function startBrowserProxy(){call('proxy');return {endpoint:'ws://proxy/secret',getError:()=>failures.has('transport')?new Error('Browser WebSocket transport failed: HTTP 403'):undefined,close:async()=>call('proxyDispose')}}`,
    "browser-history.mjs": `import {call}from'./state.mjs';export async function installBrowserHistory(){call('history');return async()=>call('historyDispose')}`,
    "browser-compat.mjs": `import {call}from'./state.mjs';export async function installBrowserCompatibility(){call('compat');return {consoleSource:'Console.messageAdded',consoleArguments:false,dispose:async()=>call('compatDispose')}}`,
    "browser-input.mjs": `import {call}from'./state.mjs';export async function installBrowserInput(){call('input');return async()=>call('inputDispose')}`,
    "browser-files.mjs": `import {call}from'./state.mjs';export async function installBrowserFiles(browser,options){call('files');if(options.browserId!=='browser-id'||typeof options.api!=='function')throw Error('missing provider');return async()=>call('filesDispose')}`,
    "browser-upload.mjs": `import {call}from'./state.mjs';export async function installBrowserUploads(){call('uploads');return async()=>call('uploadsDispose')}`,
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  const state = await import(pathToFileURL(join(dir, "state.mjs")).href);
  const { startBrowserService } = await import(pathToFileURL(join(dir, "browser-service.mjs")).href);
  return {
    ...state,
    start: () =>
      startBrowserService("https://provider/", { provider: true, browserId: "browser-id", api: async () => ({}) }),
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

test("browser service installs provider adapters before binding and closes exactly once", async () => {
  const f = await fixture();
  try {
    const service = await f.start();
    assert.deepEqual(f.calls, [
      "runtime",
      "proxy",
      "connect",
      "history",
      "compat",
      "input",
      "files",
      "uploads",
      "bind",
    ]);
    assert.deepEqual(service.capabilities, { consoleSource: "Console.messageAdded", consoleArguments: false });
    await Promise.all([service.close(), service.close()]);
    assert.deepEqual(f.calls.slice(9), [
      "unbind",
      "close",
      "uploadsDispose",
      "filesDispose",
      "inputDispose",
      "compatDispose",
      "historyDispose",
      "proxyDispose",
    ]);
  } finally {
    await f.remove();
  }
});

test("browser service closes all resources even when unbind and a disposer fail", async () => {
  const f = await fixture();
  try {
    const service = await f.start();
    f.failures.add("unbind");
    f.failures.add("filesDispose");
    await assert.rejects(
      service.close(),
      (error: AggregateError) => error instanceof AggregateError && error.errors.length === 2,
    );
    assert.deepEqual(f.calls.slice(9), [
      "unbind",
      "close",
      "uploadsDispose",
      "filesDispose",
      "inputDispose",
      "compatDispose",
      "historyDispose",
      "proxyDispose",
    ]);
  } finally {
    await f.remove();
  }
});

test("browser service disposes completed adapters after setup failure", async () => {
  const f = await fixture();
  try {
    f.failures.add("uploads");
    await assert.rejects(f.start(), /uploads/);
    assert.deepEqual(f.calls, [
      "runtime",
      "proxy",
      "connect",
      "history",
      "compat",
      "input",
      "files",
      "uploads",
      "unbind",
      "close",
      "filesDispose",
      "inputDispose",
      "compatDispose",
      "historyDispose",
      "proxyDispose",
    ]);
  } finally {
    await f.remove();
  }
});

test("browser service disposes its proxy after CDP connection failure", async () => {
  const f = await fixture();
  try {
    f.failures.add("connect");
    await assert.rejects(f.start(), /connect/);
    assert.deepEqual(f.calls, ["runtime", "proxy", "connect", "proxyDispose"]);
  } finally {
    await f.remove();
  }
});

test("browser service preserves sanitized proxy failure instead of generic closure", async () => {
  const f = await fixture();
  try {
    f.failures.add("connect");
    f.failures.add("transport");
    await assert.rejects(f.start(), (error: Error) => {
      assert.equal(error.message, "Browser WebSocket transport failed: HTTP 403");
      return true;
    });
  } finally {
    await f.remove();
  }
});

test("browser service exposes post-start transport failure to disconnect listeners", async () => {
  const f = await fixture();
  let service: any;
  try {
    service = await f.start();
    assert.equal(service.getError(), undefined);
    const disconnected = new Promise<Error | undefined>((resolve) => service.on("disconnected", resolve));
    f.failures.add("transport");
    f.browser.emit("disconnected");
    assert.equal((await disconnected)?.message, "Browser WebSocket transport failed: HTTP 403");
    assert.equal(service.getError(new Error("Target closed")).message, "Browser WebSocket transport failed: HTTP 403");
  } finally {
    await service?.close();
    await f.remove();
  }
});
