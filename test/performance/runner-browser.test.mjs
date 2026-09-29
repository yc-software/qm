import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./run.mjs";
import { sha256, verifyRun } from "./verify.mjs";
import { model, nav } from "./sidebar-test-model.mjs";
import { renderClient } from "./sidebar-test-browser.mjs";

for (const transport of ["legacy-get", "navigation-post"])
  test(
    `actual diagnostic runner joins dynamic ${transport} cold and warm DOM evidence`,
    { timeout: 20000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "qm-dynamic-runner-"));
      const m = model(transport),
        profile = m.facts.profile;
      let state = { value: { v: 2, active: false }, updatedAt: 0 };
      const server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
        const send = (value) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(value));
        };
        if (req.url === "/me") return send({ user: "actor" });
        if (req.url.startsWith("/api/ui-state")) {
          if (req.method === "PUT") state = { value: input.value, updatedAt: input.updatedAt };
          return send({ ...state, ok: true });
        }
        if (req.url === "/api/sessions") return send({ sessions: m.rows });
        if (req.url === "/api/contexts") return send({ contexts: m.contexts });
        if (req.url === "/api/session-navigation") return send(nav(m, input));
        if (req.url === "/api/session-navigation/page")
          return send({
            items: [],
            total: 0,
            nextCursor: null,
            contexts: [],
            statusTotals: nav(m).statusTotals,
            actionable: { parentSessionId: "web-000", depths: [], parentSubagents: { running: 0, waiting: 0 } },
          });
        if (req.url === "/favicon.ico") {
          res.writeHead(204);
          return res.end();
        }
        res.setHeader("content-type", "text/html");
        res.end(`<!doctype html><div class="custom-chat">Visible modeled transcript<textarea></textarea></div><div id="sidebar-body"></div><script>
      const render=${renderClient.toString()},transport=${JSON.stringify(transport)};
      (async()=>{await fetch('/me').then(r=>r.json());const contexts=await fetch('/api/contexts').then(r=>r.json());
      const data=transport==='legacy-get'?await fetch('/api/sessions').then(r=>r.json()):await fetch('/api/session-navigation',{method:'POST',body:JSON.stringify({surface:'web',references:[]})}).then(r=>r.json());
      render(data,transport,contexts.contexts,'web');
      if(transport==='navigation-post')await fetch('/api/session-navigation/page',{method:'POST',body:JSON.stringify({parentSessionId:'web-000',children:true,actionable:true})}).then(r=>r.json());})();</script>`);
      });
      const oldExitCode = process.exitCode;
      try {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const fixture = {
          fixtureId: "modeled-dynamic-runner",
          profileSha256: sha256("[]"),
          cases: {
            short: { principalId: "actor", sessionId: "web-000", expectedVisibleText: "Visible modeled transcript" },
          },
          viewReadinessBySource: ["legacy-get", "navigation-post"].map((selected) => {
            const { facts } = model(selected);
            return {
              profile: facts.profile,
              views: {},
              sidebarPagination: null,
              viewReadinessEvidence: {},
              browser: {
                rootSidebarCases: {},
                sidebarReadiness: {
                  schemaVersion: 1,
                  ...facts.profile,
                  actors: { actor: { ...facts.commonActor, surface: "web" } },
                },
              },
            };
          }),
        };
        const fixtureRaw = Buffer.from(JSON.stringify(fixture));
        await writeFile(join(directory, "fixture.json"), fixtureRaw);
        await writeFile(join(directory, "profiles.json"), "[]");
        await writeFile(
          join(directory, "dynamic.json"),
          JSON.stringify({
            schemaVersion: 1,
            qualified: false,
            commonFixture: {
              path: join(directory, "fixture.json"),
              bytes: fixtureRaw.length,
              sha256: sha256(fixtureRaw),
            },
            profile,
            condition: "normal",
            sourceProfile: transport === "legacy-get" ? "baseline-observer" : "candidate",
            campaignId: "modeled",
            epochAt: 1,
            actors: { actor: m.facts.dynamicActor },
            evidence: Object.fromEntries(
              ["histories", "nativeConfig", "observations", "preparation", "slots", "snapshot"].map((role) => [
                role,
                { path: join(directory, role), bytes: 1, sha256: "c".repeat(64) },
              ]),
            ),
            missing: ["browser.sidebarReadiness.dynamic: response and native reconciliation required"],
          }),
        );
        await writeFile(
          join(directory, "config.json"),
          JSON.stringify({
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            isolated: true,
            mode: "diagnostic",
            loadCondition: "normal",
            samples: 1,
            sourceRevision: profile.sourceRevision,
            sidebarProfile: profile,
            fixturePath: "fixture.json",
            profilePath: "profiles.json",
            dynamicSidebarPath: "dynamic.json",
            outDir: "result",
            localAuthPrincipal: "actor",
            filter: "^web.chat.short$",
            timeoutMs: 3000,
            browser: {
              viewport: { width: 1000, height: 800 },
              cpuThrottleRate: 1,
              network: { latencyMs: 0, downloadBytesPerSecond: 10000000, uploadBytesPerSecond: 10000000 },
            },
          }),
        );
        await run(join(directory, "config.json"));
        const summary = JSON.parse(await readFile(join(directory, "result/summary.json"), "utf8"));
        const samples = (await readFile(join(directory, "result/samples.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map(JSON.parse);
        await writeFile(
          join(directory, `runner-browser-${transport}.json`),
          JSON.stringify({ qualified: false, summary, samples }, null, 2) + "\n",
        );
        assert.equal(samples.length, 2);
        assert.deepEqual(
          samples.map((s) => ({ cellId: s.cellId, status: s.status, error: s.error, errors: s.errors })),
          samples.map((s) => ({ cellId: s.cellId, status: "pass", error: undefined, errors: [] })),
        );
        assert.deepEqual(summary.structuralReasons, []);
        assert.equal(summary.qualified, false);
        assert.ok(
          summary.qualificationReasons.includes(
            "Dynamic sidebar identities require admitted native history reconciliation",
          ),
        );
        const warm = samples.find((s) => s.cellId.includes(":warm:"));
        assert.ok(warm.preparation.sidebar);
        const recordedRun = JSON.parse(await readFile(join(directory, "result/run.json"), "utf8"));
        for (const mutate of [
          (value) => delete value.preparation,
          (value) => {
            delete value.preparation;
            value.cache = "cold";
          },
          (value) => (value.sidebar = structuredClone(value.preparation.sidebar)),
          (value) => (value.preparation.identity = "foreign"),
          (value) => value.preparation.errors.push({ type: "pageerror", message: "Modeled error" }),
          (value) => (value.preparation.finishedAt = value.startedAt + 1),
          (value) => delete value.preparation.finishedAt,
          (value) => (value.sidebar.version = value.preparation.sidebar.version),
        ]) {
          const changed = structuredClone(warm);
          mutate(changed);
          assert.ok(
            verifyRun(
              recordedRun,
              samples.map((sample) => (sample === warm ? changed : sample)),
              fixture,
            ).structuralReasons.length,
          );
        }
      } finally {
        process.exitCode = oldExitCode;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
