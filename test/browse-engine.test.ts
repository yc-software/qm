import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const runtime = new URL("../skills-seed/browse/scripts/playwright-runtime.mjs", import.meta.url).href;
const run = promisify(execFile);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "browse-runtime-test-"));
  await mkdir(join(dir, "bin"));
  await mkdir(join(dir, "cache"));
  await mkdir(join(dir, "cache", "runtime-other-process"));
  await writeFile(
    join(dir, "bin", "npm"),
    `#!/usr/bin/env node
const fs=require('node:fs');fs.appendFileSync(process.env.NPM_TEST_LOG,JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),mode:fs.statSync('.').mode&511,manifest:fs.statSync('package.json').mode&511,skip:process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD,umask:process.env.npm_config_umask})+'\\n');
if(process.env.NPM_TEST_FAIL){console.error('npm ERR! code EINTEGRITY');process.exit(1)}
fs.mkdirSync('node_modules/playwright-core',{recursive:true});fs.writeFileSync('node_modules/playwright-core/index.mjs','export const verified=true;');
`,
  );
  await chmod(join(dir, "bin", "npm"), 0o700);
  const env = {
    ...process.env,
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    QM_BROWSE_CACHE: join(dir, "cache"),
    NPM_TEST_LOG: join(dir, "calls"),
  };
  return { dir, env, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("runtime uses locked npm once per process and cleans only its private install", async () => {
  const f = await fixture();
  try {
    const { stdout } = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {ensurePlaywright} from ${JSON.stringify(runtime)};const paths=await Promise.all([ensurePlaywright(),ensurePlaywright()]);console.log(JSON.stringify({paths,verified:(await import(paths[0])).verified}));`,
      ],
      { env: f.env },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.paths[0], result.paths[1]);
    assert.equal(result.verified, true);
    const calls = (await readFile(join(f.dir, "calls"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      join(f.dir, "cache", "npm-cache"),
    ]);
    assert.equal(calls[0].mode, 0o700);
    assert.equal(calls[0].manifest, 0o600);
    assert.equal(calls[0].umask, "0077");
    assert.equal(calls[0].skip, "1");
    await assert.rejects(access(calls[0].cwd));
    await access(join(f.dir, "cache", "runtime-other-process"));
  } finally {
    await f.cleanup();
  }
});

test("runtime preserves npm integrity failure and removes failed private installs", async () => {
  const f = await fixture();
  try {
    const { stdout } = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {ensurePlaywright} from ${JSON.stringify(runtime)};for(let i=0;i<2;i++)try{await ensurePlaywright()}catch(error){console.log(error.message)}`,
      ],
      { env: { ...f.env, NPM_TEST_FAIL: "1" } },
    );
    assert.match(stdout, /npm ci failed: npm ERR! code EINTEGRITY/);
    assert.equal((await readFile(join(f.dir, "calls"), "utf8")).trim().split("\n").length, 1);
    assert.deepEqual(await readdir(join(f.dir, "cache")), ["runtime-other-process"]);
  } finally {
    await f.cleanup();
  }
});

test("runtime retains installation and cleanup errors together", async () => {
  const f = await fixture();
  try {
    const { stdout } = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';fs.rm=async()=>{throw Object.assign(new Error('cleanup denied'),{code:'EACCES'})};syncBuiltinESMExports();const {ensurePlaywright}=await import(${JSON.stringify(runtime)});try{await ensurePlaywright()}catch(error){console.log(JSON.stringify(error.errors.map(e=>({message:e.message,code:e.code}))))}`,
      ],
      { env: { ...f.env, NPM_TEST_FAIL: "1" } },
    );
    const errors = JSON.parse(stdout);
    assert.equal(errors.length, 2);
    assert.match(errors[0].message, /npm ci failed: npm ERR! code EINTEGRITY/);
    assert.equal(errors[1].code, "EACCES");
  } finally {
    await f.cleanup();
  }
});
