import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "ws";
import { SpritesClient } from "@fly/sprites";
import { createSpritesSandbox, SCRIPT_RUNNER } from "../../src/sandbox/sprites-sandbox.ts";
import { killableScript } from "../../src/sandbox/exec-kill.ts";
import { createLocalWorkspaceStore } from "../../src/workspace/workspace-store.ts";
import {
  createSpritesFixture,
  spritesFixturePath,
  spritesNativeEnvelope,
  spritesScriptSha256,
  type SpritesFixtureProfile,
} from "./workload-sprites.ts";
import type { WorkloadFixture } from "./workload.ts";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("native exec receipt parser preserves inner failure and rejects unsupported or corrupt envelopes", () => {
  const stdout = Buffer.from("é\n"),
    stderr = Buffer.from("failure\n");
  const result = {
    code: 0,
    stdout: Buffer.concat([Buffer.from(`7 ${stdout.length} ${stderr.length} 0.00 0.01 1.25\n`), stdout, stderr]),
    stderr: Buffer.alloc(0),
  };
  assert.deepEqual(spritesNativeEnvelope(result), {
    code: 7,
    stdoutBytes: stdout.length,
    stdoutSha256: sha256(stdout),
    stderrBytes: stderr.length,
    stderrSha256: sha256(stderr),
  });
  const different = Buffer.from(result.stdout);
  different[different.length - 2] = 120;
  assert.notEqual(spritesNativeEnvelope({ ...result, stdout: different })?.stderrSha256, sha256(stderr));
  for (const value of [
    { ...result, code: 1 },
    { ...result, stderr: Buffer.from("outer failure") },
    { ...result, stdout: result.stdout.subarray(0, -1) },
    { ...result, stdout: Buffer.concat([result.stdout, Buffer.from("extra")]) },
    ...[
      "fixture output",
      "0 0 0\n",
      "256 0 0 -1 -1 -1\n",
      "-1 0 0 -1 -1 -1\n",
      "0 -1 0 -1 -1 -1\n",
      "0 0 0 NaN -1 -1\n",
      "0 0 0 1e2 -1 -1\n",
      "0 9007199254740992 0 -1 -1 -1\n",
      "0 0 0 " + "0".repeat(256) + " -1 -1\n",
    ].map((value) => ({ ...result, stdout: Buffer.from(value) })),
    { ...result, stdout: Buffer.from([0xb0, ...Buffer.from(" 0 0 -1 -1 -1\n")]) },
  ])
    assert.equal(spritesNativeEnvelope(value), null);
  assert.deepEqual(
    spritesNativeEnvelope({ code: 0, stdout: Buffer.from("0 0 0 -1 -1 -1\n"), stderr: Buffer.alloc(0) }),
    { code: 0, stdoutBytes: 0, stdoutSha256: sha256(""), stderrBytes: 0, stderrSha256: sha256("") },
  );
});

test("script admission preserves commands while normalizing only bounded native ephemeral fields", () => {
  const first =
    "export AGENT_API_TOKEN='eyJfixture.body.signature'; /tmp/.exec-12345678-1234-1234-1234-123456789012; printf fixture";
  const second = first
    .replace("eyJfixture.body.signature", "eyJother.payload.signature")
    .replace("12345678-1234-1234-1234-123456789012", "87654321-1234-1234-1234-123456789012");
  assert.equal(spritesScriptSha256(first), spritesScriptSha256(second));
  assert.equal(
    spritesScriptSha256(killableScript(first, randomUUID())),
    spritesScriptSha256(killableScript(second, randomUUID())),
  );
  assert.notEqual(
    spritesScriptSha256(killableScript(first, randomUUID())),
    spritesScriptSha256(killableScript(`${second}; printf extra`, randomUUID())),
  );
  assert.notEqual(spritesScriptSha256(first), spritesScriptSha256(`${first}; printf extra`));
  assert.notEqual(
    spritesScriptSha256(first),
    spritesScriptSha256(first.replace("eyJfixture.body.signature", "injected'; printf extra; '")),
  );
  const turn = "rm -rf '/home/sprite/workspace/.agent-turn/123456789012345678901234/mfy1ttuo-123456789012345678901234'";
  const laterTurn = turn
    .replaceAll("123456789012345678901234", "fedcba9876543210fedcba98")
    .replace("mfy1ttuo", "mfy1tw99");
  assert.equal(spritesScriptSha256(turn), spritesScriptSha256(laterTurn));
  assert.notEqual(spritesScriptSha256(turn), spritesScriptSha256(`${turn}; printf extra`));
  assert.notEqual(spritesScriptSha256(turn), spritesScriptSha256(turn.replace("mfy1ttuo", "unreviewed-directory")));
  for (const path of [
    "/etc/passwd",
    "/home/sprite/../outside",
    "/home/sprite//bad",
    "/home/sprite/bad\0",
    "/home/sprite/a\\b",
  ])
    assert.throws(() => spritesFixturePath(path));
  assert.equal(
    spritesFixturePath("/home/sprite/workspace/performance/probe.txt"),
    "/home/sprite/workspace/performance/probe.txt",
  );
});

function referenceScripts(): string[] {
  const program = `
    import {mkdtempSync,rmSync} from 'node:fs';
    import {tmpdir} from 'node:os';
    import {join} from 'node:path';
    import {installFakeSprites} from './test/support/fake-sprites.ts';
    import {createSpritesSandbox} from './src/sandbox/sprites-sandbox.ts';
    import {createLocalWorkspaceStore} from './src/workspace/workspace-store.ts';
    const directory=mkdtempSync(join(tmpdir(),'sprites-reference-'));
    const fake=installFakeSprites();
    try {
      const sandbox=createSpritesSandbox(createLocalWorkspaceStore(directory),{token:'test-token',baseUrl:fake.baseUrl,namePrefix:'qm-perf-reference',egressProxyUrl:'https://fixture-proxy.invalid'});
      const handle=await sandbox.provision([{scopeId:'personal:fixture',mode:'rw'}],{egressToken:'synthetic-egress-token'});
      await sandbox.run(handle,"printf 'fixture-command\\n'",{signal:new AbortController().signal});
      await sandbox.run(handle,"printf 'nonzero-out\\n'; printf 'nonzero-err\\n' >&2; exit 7",{signal:new AbortController().signal});
      await sandbox.teardown(handle);
      console.log(JSON.stringify(fake.execScripts()));
    } finally {fake.cleanup();rmSync(directory,{recursive:true,force:true});}
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    })
      .trim()
      .split("\n")
      .at(-1)!,
  );
}

test(
  "native Sprites SDK provisions, transfers bytes and executes two guests over real HTTP and WebSocket",
  { skip: !process.env.QM_PERFORMANCE_SPRITES_IMAGE },
  async () => {
    const originalFetch = globalThis.fetch,
      originalWebSocket = globalThis.WebSocket;
    const reference = referenceScripts();
    const unsupported = [
      "printf unsupported-envelope",
      "printf '0 5 0 -1 -1 -1\\nshortEXTRA'",
      "printf '0 5 0 -1 -1 -1\\nshor'",
      "printf 'invalid 5 0 -1 -1 -1\\nshort'",
    ];
    const scripts = [...new Set([...reference, ...unsupported].map(spritesScriptSha256))];
    const campaignId = randomUUID();
    const fixture: WorkloadFixture = {
      schemaVersion: 1,
      fixtureId: "qm-perf-sprites-test",
      profileSha256: "synthetic-sprites-test",
      databaseName: "qm_perf_sprites_test",
      qualified: false,
    };
    const token = `qm-perf-sprites-${randomUUID()}`;
    const profile: SpritesFixtureProfile = {
      schemaVersion: 1,
      fixtureId: fixture.fixtureId,
      campaignId,
      host: "127.0.0.1",
      port: 0,
      tokenEnv: "QM_PERF_SPRITES_TEST_TOKEN",
      namePrefix: `qm-perf-${campaignId.slice(0, 8)}`,
      image: process.env.QM_PERFORMANCE_SPRITES_IMAGE!,
      maxSprites: 2,
      maxExecs: 2,
      maxBytes: 1024 * 1024,
      timeoutMs: 20000,
      memoryMb: 256,
      cpus: 0.5,
      chunkBytes: 47,
      delays: { controlMs: 0, filesMs: 0, execMs: 100, chunkMs: 0 },
      scripts: scripts.map((sha256, index) => ({ name: `native_${index}`, sha256 })),
    };
    const receipts: Array<Record<string, unknown>> = [];
    const responder = await createSpritesFixture(profile, fixture, (record) => receipts.push(record), {
      QM_PERF_SPRITES_TEST_TOKEN: token,
    });
    const directory = mkdtempSync(join(tmpdir(), "sprites-network-test-"));
    responder.server.listen(0, "127.0.0.1");
    await once(responder.server, "listening");
    const address = responder.server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const sandbox = createSpritesSandbox(createLocalWorkspaceStore(directory), {
      token,
      baseUrl: origin,
      namePrefix: profile.namePrefix,
      memoryMb: 256,
      egressProxyUrl: "https://fixture-proxy.invalid",
    });
    try {
      const denied = await fetch(`${origin}/__qm_performance`);
      assert.equal(denied.status, 403);
      const identity = await fetch(`${origin}/__qm_performance`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(identity.status, 200);
      const handles = await Promise.all(
        ["one", "two"].map((scope) =>
          sandbox.provision([{ scopeId: `personal:${scope}`, mode: "rw", mountPath: "" }], {
            egressToken: "synthetic-egress-token",
          }),
        ),
      );
      assert.notEqual(handles[0]!.id, handles[1]!.id);
      const overCap = await fetch(`${origin}/v1/sprites`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: `${profile.namePrefix}-excess` }),
      });
      assert.equal(overCap.status, 403);
      assert.equal(responder.totals.created, 2);
      const filesystem = new SpritesClient(token, { baseURL: origin }).sprite(handles[0]!.id).filesystem();
      const container = receipts.find(
        (receipt) => receipt.type === "guest-created" && receipt.name === handles[0]!.id,
      )?.containerId;
      assert.equal(typeof container, "string");
      const modePath = "/home/sprite/workspace/performance-mode.txt";
      for (const mode of [0o600, 0o644, 0o600]) {
        await filesystem.writeFile(modePath, "synthetic fixture bytes", { mode });
        assert.equal(
          execFileSync("docker", ["exec", container as string, "stat", "-c", "%a", modePath], {
            encoding: "utf8",
          }).trim(),
          mode.toString(8),
        );
      }
      const warm = await sandbox.provision([{ scopeId: "personal:one", mode: "rw", mountPath: "" }]);
      assert.equal(warm.id, handles[0]!.id);
      assert.equal(warm.coldStart, false);
      for (let index = 0; index < handles.length; index++) {
        const bytes = Buffer.from(`fixture-${index}-` + "content\n".repeat(1024));
        await sandbox.writeFileBytes(handles[index]!, "performance/probe.txt", bytes);
        assert.deepEqual(Buffer.from((await sandbox.readFileBytes(handles[index]!, "performance/probe.txt"))!), bytes);
      }
      const results = await Promise.all(
        handles.map((handle) =>
          sandbox.run(handle, "printf 'fixture-command\n'", { signal: new AbortController().signal }),
        ),
      );
      assert.ok(results.every((result) => result.code === 0 && result.stdout === "fixture-command\n"));
      assert.equal(responder.totals.peakExecs, 2);
      const nonzero = await sandbox.run(handles[0]!, "printf 'nonzero-out\n'; printf 'nonzero-err\n' >&2; exit 7", {
        signal: new AbortController().signal,
      });
      assert.equal(nonzero.code, 7);
      assert.equal(nonzero.stdout, "nonzero-out\n");
      assert.equal(nonzero.stderr, "nonzero-err\n");
      const failedInner = receipts.find((receipt) => (receipt.nativeEnvelope as { code?: number } | null)?.code === 7);
      assert.ok(failedInner);
      assert.equal(failedInner.pass, true);
      assert.equal((failedInner.outer as { code: number }).code, 0);
      assert.deepEqual(failedInner.nativeEnvelope, {
        code: 7,
        stdoutBytes: Buffer.byteLength(nonzero.stdout),
        stdoutSha256: sha256(nonzero.stdout),
        stderrBytes: Buffer.byteLength(nonzero.stderr),
        stderrSha256: sha256(nonzero.stderr),
      });
      await Promise.all(handles.map((handle) => sandbox.teardown(handle)));
      const wsUrl = new URL(`${origin.replace("http", "ws")}/v1/sprites/${handles[0]!.id}/exec`);
      for (const value of ["sh", "-c", SCRIPT_RUNNER]) wsUrl.searchParams.append("cmd", value);
      wsUrl.searchParams.set("path", "sh");
      wsUrl.searchParams.set("stdin", "true");
      for (const script of unsupported) {
        const raw = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
        await once(raw, "open");
        raw.send(Buffer.concat([Buffer.from([0]), Buffer.from(script)]));
        raw.send(Buffer.from([4]));
        await once(raw, "close");
        const receipt = receipts.find((row) => row.type === "exec" && row.scriptSha256 === spritesScriptSha256(script));
        assert.ok(receipt);
        assert.equal(receipt.pass, true);
        assert.equal(receipt.nativeEnvelope, null);
        assert.equal((receipt.outer as { code: number }).code, 0);
      }
      const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
      await once(ws, "open");
      ws.send(Buffer.concat([Buffer.from([0]), Buffer.from("printf unreviewed")]));
      ws.send(Buffer.from([4]));
      await once(ws, "close");
      assert.ok(
        receipts.some((receipt) => receipt.type === "exec" && receipt.shape === null && receipt.pass === false),
      );
      const wrongToken = new WebSocket(wsUrl, { headers: { authorization: "Bearer qm-perf-wrong-token" } });
      await assert.rejects(once(wrongToken, "open"), /403/);
      wrongToken.terminate();
      const badPath = await fetch(
        `${origin}/v1/sprites/${handles[0]!.id}/fs/read?path=%2Fetc%2Fpasswd&workingDir=%2F`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      assert.equal(badPath.status, 403);
      const badBody = await fetch(`${origin}/v1/sprites`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "null",
      });
      assert.equal(badBody.status, 403);
      const privateSuffix = "unadmitted-private-file-name";
      const unsupportedPath = await fetch(`${origin}/v1/sprites/${handles[0]!.id}/${privateSuffix}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(unsupportedPath.status, 403);
      assert.ok(
        receipts.some(
          (receipt) =>
            receipt.type === "http" &&
            receipt.operation === "unknown" &&
            receipt.name === handles[0]!.id &&
            receipt.targetSha256 === null,
        ),
      );
      const rejectedPath = receipts.find(
        (receipt) => receipt.type === "http" && receipt.operation === "fs/read" && receipt.status === 403,
      );
      assert.equal(rejectedPath?.targetSha256, null);
      assert.deepEqual(rejectedPath?.pathSha256, []);
      const writes = receipts.filter(
        (receipt) => receipt.type === "http" && receipt.operation === "fs/write" && receipt.status === 200,
      );
      assert.ok(writes.length > 0);
      for (const receipt of writes) {
        assert.equal(receipt.method, "PUT");
        assert.equal(typeof receipt.name, "string");
        assert.match(receipt.targetSha256 as string, /^[a-f0-9]{64}$/);
        assert.match(receipt.requestBodySha256 as string, /^[a-f0-9]{64}$/);
        assert.equal((receipt.pathSha256 as string[]).length, 1);
      }
      const fileWrite = writes.find((receipt) => (receipt.pathSha256 as string[])[0] === sha256(modePath));
      assert.ok(fileWrite);
      assert.equal(fileWrite.requestBodySha256, sha256("synthetic fixture bytes"));
      assert.equal(globalThis.fetch, originalFetch);
      assert.equal(globalThis.WebSocket, originalWebSocket);
      assert.ok(!JSON.stringify(receipts).includes(token));
      assert.ok(!JSON.stringify(receipts).includes(modePath));
      assert.ok(!JSON.stringify(receipts).includes("synthetic fixture bytes"));
      assert.ok(!JSON.stringify(receipts).includes(privateSuffix));
      const oversized = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
      await once(oversized, "open");
      for (let index = 0; index < 3; index++)
        oversized.send(Buffer.concat([Buffer.from([0]), Buffer.alloc(profile.maxBytes / 2, 120)]));
      await once(oversized, "close");
      assert.ok(
        receipts.some(
          (receipt) => receipt.type === "exec-frame-rejected" && Number(receipt.inputBytes) > profile.maxBytes,
        ),
      );
      const pending = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
      pending.on("error", () => {});
      await once(pending, "open");
      const before = responder.totals.execs;
      pending.send(
        Buffer.concat([Buffer.from([0]), Buffer.from(reference.find((script) => script.includes("fixture-command"))!)]),
      );
      pending.send(Buffer.from([4]));
      const deadline = Date.now() + 1000;
      while (responder.totals.execs === before && Date.now() < deadline) await sleep(5);
      assert.equal(responder.totals.execs, before + 1);
      await responder.close();
      assert.ok(
        receipts.some((receipt) => receipt.type === "exec" && receipt.shape !== null && receipt.pass === false),
      );
    } finally {
      try {
        await responder.close();
      } finally {
        if (process.env.QM_PERFORMANCE_SPRITES_TEST_EVIDENCE)
          writeFileSync(
            process.env.QM_PERFORMANCE_SPRITES_TEST_EVIDENCE,
            `${JSON.stringify({ profile, receipts, totals: responder.totals, qualified: false }, null, 2)}\n`,
            { mode: 0o600 },
          );
        rmSync(directory, { recursive: true, force: true });
      }
    }
    assert.equal(responder.totals.created, responder.totals.deleted);
    assert.equal(receipts.at(-1)?.remainingGuests, 0);
    for (const receipt of receipts.filter((receipt) => ["http", "exec"].includes(String(receipt.type)))) {
      assert.ok(Number.isSafeInteger(receipt.startedAt) && Number.isSafeInteger(receipt.finishedAt));
      assert.ok(
        Number(receipt.startedAt) <= Number(receipt.finishedAt) && Number(receipt.finishedAt) <= Number(receipt.at),
      );
      if (receipt.type === "exec" && receipt.outer) {
        const outer = receipt.outer as {
          stdoutBytes: number;
          stdoutSha256: string;
          stderrBytes: number;
          stderrSha256: string;
        };
        assert.ok(outer.stdoutBytes >= 0 && outer.stderrBytes >= 0);
        assert.match(outer.stdoutSha256, /^[a-f0-9]{64}$/);
        assert.match(outer.stderrSha256, /^[a-f0-9]{64}$/);
      }
    }
    await assert.rejects(
      createSpritesFixture({ ...profile, maxSprites: 65 }, fixture, () => {}, { QM_PERF_SPRITES_TEST_TOKEN: token }),
      /Invalid maxSprites/,
    );
    const ceiling = await createSpritesFixture({ ...profile, maxSprites: 64 }, fixture, () => {}, {
      QM_PERF_SPRITES_TEST_TOKEN: token,
    });
    await ceiling.close();
    let failReceipt = false;
    const failedCampaign = randomUUID();
    const failed = await createSpritesFixture(
      { ...profile, campaignId: failedCampaign, namePrefix: `qm-perf-${failedCampaign.slice(0, 8)}` },
      fixture,
      () => {
        if (failReceipt) throw new Error("Receipt sink unavailable");
      },
      { QM_PERF_SPRITES_TEST_TOKEN: token },
    );
    failed.server.listen(0, "127.0.0.1");
    await once(failed.server, "listening");
    const failedAddress = failed.server.address();
    assert.ok(failedAddress && typeof failedAddress !== "string");
    const failedOrigin = `http://127.0.0.1:${failedAddress.port}`;
    const failedClient = new SpritesClient(token, { baseURL: failedOrigin });
    try {
      for (const suffix of ["one", "two"])
        await failedClient.createSprite(`qm-perf-${failedCampaign.slice(0, 8)}-${suffix}`);
      failReceipt = true;
      await fetch(`${failedOrigin}/__qm_performance`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(
        (await fetch(`${failedOrigin}/__qm_performance`, { headers: { authorization: `Bearer ${token}` } })).status,
        403,
      );
    } finally {
      await assert.rejects(failed.close(), /receipt failure/i);
    }
    assert.equal(failed.totals.created, 2);
    assert.equal(failed.totals.deleted, 2);
    assert.equal(
      execFileSync("docker", ["ps", "-aq", "--filter", `label=qm.performance.campaign=${failedCampaign}`], {
        encoding: "utf8",
      }).trim(),
      "",
    );
  },
);
