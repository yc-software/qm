import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

const url = process.env.DATABASE_URL;
test("in-flight HTTP request during actual SIGTERM shutdown", { skip: !url, timeout: 40_000 }, async () => {
  const child = spawn(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "-e",
      `
    import { mock } from 'node:test';
    import * as wiring from './src/wiring.ts';
    import * as configModule from './src/config.ts';
    import * as api from './src/api/server.ts';
    import { testConfig } from './test/support/test-config.ts';
    const request = Promise.withResolvers();
    const tail = Promise.withResolvers();
    process.on('message', value => { if(value==='request') request.resolve(); if(value==='tail') tail.resolve(); });
    const config=testConfig({databaseUrl:process.env.DATABASE_URL,runStore:'postgres',harness:'mock',backgroundWorkEnabled:false});
    mock.module('./src/config.ts',{namedExports:{...configModule,loadConfig:()=>config}});
    mock.module('./src/api/server.ts',{namedExports:{...api,createServer:(app,deps)=>{
      const server=api.createInsecureTestServer(app,deps);
      server.once('listening',()=>process.send({port:server.address().port}));
      return server;
    }}});
    mock.module('./src/wiring.ts',{namedExports:{...wiring,buildApp:(...args)=>{
      const built=wiring.buildApp(...args);
      const getRun=built.app.getRun;
      built.app.getRun=async(...args)=>{process.send({entered:true});await request.promise;return getRun(...args);};
      const close=built.tasks.close?.bind(built.tasks);
      built.tasks.close=async()=>{process.send({tail:true});await tail.promise;await close?.();};
      return built;
    }}});
    await import('./src/index.ts');
  `,
    ],
    { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  const events: any[] = [];
  let output = "";
  child.on("message", (value) => events.push(value));
  child.stdout!.on("data", (value) => {
    output += value;
  });
  child.stderr!.on("data", (value) => {
    output += value;
  });
  const exit = once(child, "exit");
  const wait = async (key: string) => {
    for (let i = 0; i < 2000; i++) {
      const event = events.find((value) => value[key]);
      if (event) return event;
      if (child.exitCode !== null || child.signalCode !== null) throw Error(output);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw Error("waiting for " + key + " " + output);
  };
  try {
    const { port } = await wait("port");
    const response = fetch("http://127.0.0.1:" + port + "/v1/runs/missing");
    await wait("entered");
    child.kill("SIGTERM");
    await wait("tail");
    child.send("request");
    const r = await response;
    console.log(JSON.stringify({ status: r.status, body: await r.text() }));
    await wait("tail");
    child.send("tail");
    await exit;
    console.log(output);
    assert.match(output, /\[server\] 503 GET \/v1\/runs\/missing/);
    assert.match(output, /Postgres store is closed/);
    assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "1");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit;
  }
});
