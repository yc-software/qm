import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  spritesScriptSha256,
  type SpritesFixtureProfile,
} from "./workload-sprites.ts";
import type { WorkloadFixture } from "./workload.ts";

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
    const scripts = [...new Set(reference.map(spritesScriptSha256))];
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
      maxSprites: 3,
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
      await Promise.all(handles.map((handle) => sandbox.teardown(handle)));
      const wsUrl = new URL(`${origin.replace("http", "ws")}/v1/sprites/${handles[0]!.id}/exec`);
      for (const value of ["sh", "-c", SCRIPT_RUNNER]) wsUrl.searchParams.append("cmd", value);
      wsUrl.searchParams.set("path", "sh");
      wsUrl.searchParams.set("stdin", "true");
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
      assert.equal(globalThis.fetch, originalFetch);
      assert.equal(globalThis.WebSocket, originalWebSocket);
      assert.ok(!JSON.stringify(receipts).includes(token));
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
