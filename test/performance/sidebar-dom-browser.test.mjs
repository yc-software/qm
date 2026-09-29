import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClient } from "./sidebar-test-browser.mjs";
import test from "node:test";
import { chromium } from "playwright";
import { observe } from "./run.mjs";
import { model, nav } from "./sidebar-test-model.mjs";

for (const transport of ["navigation-post", "legacy-get"])
  test(`actual modeled ${transport} capture to DOM, with adverse rendered states`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "qm-sidebar-dom-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const m = model(transport),
      requests = [];
    let browser;
    let server;
    let receipt;
    const empty = {
      scopeId: "project:empty",
      kind: "personal",
      name: null,
      project: { id: "empty", name: "Dynamic empty project", ownerId: "actor", createdAt: 1, updatedAt: 1 },
      sessionCount: 0,
      lastActivityAt: 2100,
    };
    m.contexts.push(empty);
    const emptyIdentity = {
      scopeId: empty.scopeId,
      kind: empty.kind,
      name: null,
      project: { id: "empty", name: empty.project.name },
    };
    m.facts.commonActor.contexts.push(emptyIdentity);
    m.facts.dynamicActor.contexts.push({ ...emptyIdentity, fallbackActivity: 0 });
    m.facts.dynamicActor.scopePolicy.push({ scopeId: empty.scopeId, mode: "dynamic", writeEvidence: [] });
    const required =
      transport === "navigation-post"
        ? [{ path: "/api/session-navigation", method: "POST", captureNavigation: true, captureSidebar: true }]
        : ["/api/sessions", "/api/contexts"].map((path) => ({ path, captureSidebar: true }));
    try {
      server = createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
        requests.push({ path: req.url, method: req.method });
        let data;
        if (req.url === "/me") data = { user: "actor" };
        else if (req.url === "/api/sessions") data = { sessions: m.rows };
        else if (req.url === "/api/contexts") data = { contexts: m.contexts };
        else if (req.url === "/api/session-navigation") data = nav(m, input);
        if (data) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
          return;
        }
        res.setHeader("Content-Type", "text/html");
        res.end(
          `<html><body><div id="sidebar-body"></div><script>globalThis.window.renderClient=${renderClient.toString()};globalThis.window.load=async(input,limit=50)=>{await fetch('/me').then(r=>r.json());const contexts=await fetch('/api/contexts').then(r=>r.json());let data;if(${JSON.stringify(transport)}==='navigation-post'){data=await fetch('/api/session-navigation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}).then(r=>r.json());if(input.cursor){for(const key of ['recent','pinned','groups'])if(key!==input.section)data[key]=globalThis.window.applied[key];data[input.section].items=[...globalThis.window.applied[input.section].items,...data[input.section].items];}}else data=await fetch('/api/sessions').then(r=>r.json());globalThis.window.applied=structuredClone(data);renderClient(data,${JSON.stringify(transport)},contexts.contexts,input.surface,limit,[]);return true;};</script></body></html>`,
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const origin = `http://127.0.0.1:${server.address().port}`;
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(origin);
      const sidebar = { ...m.facts, surface: "web", retention: { identities: new Map(), bytes: 0 } };
      const observer = observe(page, origin, required, sidebar);
      observer.start();
      await page.evaluate(() => globalThis.window.load({ surface: "web", references: [] }));
      const proof = await observer.waitSidebar(page, { timeoutMs: 3000 });
      assert.equal(proof.dom.pinned.count, transport === "navigation-post" ? 50 : 55);
      const pristine = await page.locator("#sidebar-body").innerHTML();
      const failures = [];
      for (const [name, mutate] of [
        ["omitted row", () => globalThis.document.querySelector(".session-row").remove()],
        [
          "incorrect label",
          () => {
            globalThis.document.querySelector(".tl").textContent = "wrong";
          },
        ],
        [
          "misordered row",
          () => {
            const parent = globalThis.document.querySelector(".pinned-children");
            parent.append(parent.firstElementChild);
          },
        ],
        [
          "incorrect group count",
          () => {
            globalThis.document.querySelector(".recent-project-count").textContent = "999";
          },
        ],
        [
          "omitted More",
          () =>
            [...globalThis.document.querySelectorAll("button")]
              .find((e) => e.textContent === "Show more conversations")
              .remove(),
        ],
        [
          "incorrect More label",
          () => {
            [...globalThis.document.querySelectorAll("button")].find(
              (e) => e.textContent === "Show more conversations",
            ).textContent = "Wrong More";
          },
        ],
        [
          "blank zero count",
          () => {
            globalThis.document.querySelector(".recent-project-count").textContent = "";
          },
        ],
        [
          "misordered group",
          () => {
            const group = globalThis.document.querySelector("section.recent-project");
            group.parentElement.append(group);
          },
        ],
        [
          "hidden group members",
          () => {
            [...globalThis.document.querySelectorAll(".recent-project-children")].find((e) =>
              e.querySelector(".session-row"),
            ).hidden = true;
          },
        ],
      ]) {
        await page.evaluate(mutate);
        await assert.rejects(observer.waitSidebar(page, { timeoutMs: 120 }), /did not settle/, name);
        failures.push(name);
        await page.locator("#sidebar-body").evaluate((e, html) => {
          e.innerHTML = html;
        }, pristine);
      }
      if (transport === "navigation-post") {
        const cursor = await page.evaluate(() => globalThis.window.applied.recent.nextCursor);
        await page.evaluate(
          (cursor) => globalThis.window.load({ surface: "web", section: "recent", cursor }, 100),
          cursor,
        );
        const second = await observer.waitSidebar(page, { limit: 100, timeoutMs: 3000 });
        assert.equal(second.dom.recent.count, 100);
        assert.equal(second.sectionSources.recent.length, 2);
        const newer = await page.locator("#sidebar-body").innerHTML();
        await page.locator("#sidebar-body").evaluate((e, html) => {
          e.innerHTML = html;
        }, pristine);
        await assert.rejects(observer.waitSidebar(page, { limit: 100, timeoutMs: 120 }), /did not settle/);
        failures.push("stale first page");
        await page.locator("#sidebar-body").evaluate((e, html) => {
          e.innerHTML = html;
        }, newer);
      }
      sidebar.surface = "all";
      m.rows.push(
        m.row("new-recurring", {
          threadRef: "cron:channel:fire:000000000001",
          scopeId: "channel:new",
          lastActivityAt: 2300,
        }),
      );
      await page.evaluate(() => globalThis.window.load({ surface: "all", references: [] }));
      const allProof = await observer.waitSidebar(page, { timeoutMs: 3000 });
      assert.equal(allProof.surface, "all");
      assert.equal(await page.locator("section.recent-project").first().getAttribute("data-scope-id"), "channel:new");
      assert.equal(await page.locator('[data-session-id="new-recurring"]').count(), 1);
      const result = await observer.finish();
      assert.deepEqual(result.errors, []);
      assert.equal(result.identity, "actor");
      assert.ok(result.requests.filter((r) => r.sidebarProjection).every((r) => r.completed && r.responseBodySha256));
      receipt = {
        schemaVersion: 1,
        qualified: false,
        browserVersion: browser.version(),
        nodeVersion: process.version,
        origin,
        transport,
        proof,
        allProof,
        result,
        requests,
        refused: failures,
      };
    } finally {
      if (browser) await browser.close();
      if (server) await new Promise((resolve) => server.close(resolve));
      const cleanup = {
        browserDisconnected: browser ? !browser.isConnected() : true,
        serverListening: server?.listening ?? false,
      };
      assert.equal(cleanup.browserDisconnected, true);
      assert.equal(cleanup.serverListening, false);
      await writeFile(join(directory, `cleanup-${transport}.json`), JSON.stringify(cleanup, null, 2) + "\n");
      if (receipt)
        await writeFile(
          join(directory, `native-${transport}.json`),
          JSON.stringify({ ...receipt, cleanup }, null, 2) + "\n",
        );
    }
  });
