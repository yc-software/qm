import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createServer } from "../../src/api/server.ts";
import { serverDeps } from "../../src/wiring.ts";
import { signedHeaders } from "../../plugins/chassis/src/core-client.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../plugins/chassis/src/portal-identity.ts";
import { proxyToDeployment } from "../../plugins/portal/src/proxy.ts";
import { selectDefaultSandbox } from "../support/default-sandbox.ts";
import type { ModelReply, ModelRequest } from "./support/fake-gateway.ts";
import { journeyTestOptions, startJourneyApp, waitFor } from "./support/journey-app.ts";

const OWNER = "builder@example.com";
const SIGNING_SECRET = "journey-core-signing-secret-0123456789abcdef";
const WEB = "https://qm.example.test";
const LINK = `${WEB}/d/status-board/`;
const SECRET = `sk-live-${"7Qx9".repeat(6)}`;
const BROWSER = { accept: "text/html,application/xhtml+xml", "sec-fetch-dest": "document" };

const serverJs = (heading: string) =>
  [
    'const http = require("node:http");',
    "const token = process.env.STATUS_TOKEN;",
    "http.createServer((req, res) => {",
    '  res.writeHead(200, { "content-type": "text/html" });',
    `  res.end("<h1>${heading}</h1><p>token " + (token ? "configured (" + token.length + " chars)" : "missing") + "</p>");`,
    `}).listen(process.env.PORT, () => console.log("${heading} listening"));`,
  ].join("\n");

const write = (heading: string): ModelReply => ({
  tool: "files",
  input: { action: "write", path: "board/server.js", data: serverJs(heading) },
});

const toolResults = (req: ModelRequest): string[] =>
  req.messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content
          .filter((b: { type?: string }) => b.type === "tool_result")
          .map((b: { content?: unknown }) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)))
      : [],
  );

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function startStack(seen: string[], dataDir?: string) {
  const app = await startJourneyApp(
    { maxRequestBytes: 10 * 1024 * 1024, contextWindowTokens: 200_000, maxOutputTokens: 32_000 },
    {
      securityScreen: "observe",
      signingSecret: SIGNING_SECRET,
      apiBaseUrl: "http://core.internal",
      publicWebUrl: WEB,
      ...(dataDir ? { dataDir } : {}),
    },
  );
  const script: ModelReply[] = [];
  app.gateway.respond = (req) => {
    if (!req.tools?.some((t) => t.name === "apps")) return { text: "Status board" };
    return script.shift() ?? { text: toolResults(req).at(-1) ?? "done" };
  };
  const core = createServer(app.built.app, serverDeps(app.config, app.built));
  const coreBase = await listen(core);
  const portal = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", WEB);
    const [id = "", ...rest] = url.pathname.slice("/d/".length).split("/");
    proxyToDeployment(req, res, {
      coreBase,
      id,
      subPath: `/${rest.join("/")}`,
      search: url.search,
      principal: OWNER,
      signingSecret: SIGNING_SECRET,
      identitySecret: SIGNING_SECRET,
    });
  });
  const portalBase = await listen(portal);
  const open = async (link: string) => {
    const res = await fetch(`${portalBase}${new URL(link).pathname}`, { headers: BROWSER });
    const body = await res.text();
    seen.push(body);
    return { status: res.status, body };
  };
  return {
    app,
    open,
    serves: (link: string, heading: string) =>
      waitFor(async () => {
        const page = await open(link);
        return page.status === 200 && page.body.includes(heading) ? page.body : undefined;
      }, `${link} to serve ${heading}`),
    async coreGet(path: string) {
      const res = await fetch(`${coreBase}${path}`, {
        headers: {
          ...signedHeaders(SIGNING_SECRET, "GET", path),
          [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: OWNER, exp: Date.now() + 60_000 }, SIGNING_SECRET),
        },
      });
      const body = await res.text();
      seen.push(body);
      return { status: res.status, body };
    },
    async turn(threadRef: string, text: string, steps: ModelReply[]) {
      script.push(...steps);
      const result = await app.webTurn(OWNER, threadRef, text);
      assert.equal(result.status, "ok", JSON.stringify(result));
      seen.push(result.reply ?? "");
      return result.reply ?? "";
    },
    async stop(archive: boolean) {
      if (archive) for (const d of await app.built.app.listDeployments()) await app.built.app.archiveDeployment(d.id);
      await new Promise((r) => portal.close(r));
      await new Promise((r) => core.close(r));
      await app.stop();
    },
  };
}

test(
  "a published app keeps its link through edits, rollback and a core restart without leaking its secret",
  journeyTestOptions(240_000),
  async () => {
    const seen: string[] = [];
    const threadRef = `web:${OWNER}:status-${Date.now()}`;
    let stack = await startStack(seen);
    try {
      await selectDefaultSandbox(stack.app.built, OWNER, `personal:${OWNER}`);

      const published = await stack.turn(
        threadRef,
        `Publish a status board as status-board with STATUS_TOKEN=${SECRET} in its env.`,
        [
          write("Status v1"),
          {
            tool: "apps",
            input: {
              action: "publish",
              dir: "board",
              entrypoint: "node server.js",
              name: "status-board",
              env: { STATUS_TOKEN: SECRET },
            },
          },
        ],
      );
      assert.ok(published.includes(LINK), `the reply hands the user the app link: ${published}`);
      assert.match(await stack.serves(LINK, "Status v1"), /token configured \(32 chars\)/);

      const edited = await stack.turn(threadRef, "Change the heading to Status v2.", [
        write("Status v2"),
        {
          tool: "apps",
          input: { action: "publish", dir: "board", entrypoint: "node server.js", name: "status-board" },
        },
      ]);
      assert.ok(edited.includes(LINK), `republishing keeps the same link: ${edited}`);
      const v2 = await stack.serves(LINK, "Status v2");
      assert.match(v2, /token configured \(32 chars\)/, "the secret env carries over to the new build");
      assert.doesNotMatch(v2, /Status v1/);

      const refused = await stack.turn(threadRef, "Also publish the same folder as scratch-board.", [
        { tool: "apps", input: { action: "publish", dir: "board", name: "scratch-board" } },
      ]);
      assert.match(refused, /publish failed.*requires an entrypoint/, `a new app needs an entrypoint: ${refused}`);
      assert.equal((await stack.open(`${WEB}/d/scratch-board/`)).status, 404);

      const inherited = await stack.turn(threadRef, "Change the heading to Status v3.", [
        write("Status v3"),
        { tool: "apps", input: { action: "publish", dir: "board", name: "status-board" } },
      ]);
      assert.ok(inherited.includes(LINK), `a file update without an entrypoint reuses the app's: ${inherited}`);
      assert.match(await stack.serves(LINK, "Status v3"), /token configured \(32 chars\)/);

      const { deployment } = JSON.parse(
        (await stack.coreGet(`/v1/deployments/status-board?principalId=${OWNER}`)).body,
      ) as { deployment: { id: string; versions: Array<{ version: number }> } };
      assert.deepEqual(
        deployment.versions.map((v) => v.version),
        [1, 2, 3],
      );

      const rolledBack = await stack.turn(threadRef, "Roll status-board back to the first version.", [
        { tool: "apps", input: { action: "publish", name: "status-board", rollbackTo: 1 } },
      ]);
      assert.ok(rolledBack.includes(LINK), `rollback keeps the same link: ${rolledBack}`);
      assert.match(await stack.serves(LINK, "Status v1"), /token configured \(32 chars\)/);

      const logs = await stack.coreGet(`/v1/deployments/${deployment.id}/logs`);
      assert.equal(logs.status, 200);
      assert.match(logs.body, /Status v1 listening/);

      const dataDir = stack.app.config.dataDir;
      await stack.stop(false);
      stack = await startStack(seen, dataDir);
      assert.match(await stack.serves(LINK, "Status v1"), /token configured/, "the link survives a core restart");
      const second = await stack.turn(threadRef, "Publish the board folder as incident-board too.", [
        {
          tool: "apps",
          input: { action: "publish", dir: "board", entrypoint: "node server.js", name: "incident-board" },
        },
      ]);
      assert.ok(second.includes(`${WEB}/d/incident-board/`), `a new app publishes after a restart: ${second}`);
      assert.match(await stack.serves(`${WEB}/d/incident-board/`, "Status v3"), /token missing/);
      assert.match(await stack.serves(LINK, "Status v1"), /token configured/);

      const session = await stack.app.built.sessions.getByThread(threadRef);
      const entries = await stack.app.built.sessions.getEntries(session!.id);
      assert.ok(
        entries.some((e) => e.type === "user" && JSON.stringify(e.payload).includes(SECRET)),
        "the user did hand over the secret",
      );
      seen.push(
        ...entries.filter((e) => e.type !== "user").map((e) => JSON.stringify(e.payload)),
        ...stack.app.gateway.requests.flatMap(toolResults),
      );
      const files = await stack.app.built.app.listFilesForViewer(OWNER);
      for (const f of [...files.owned, ...files.shared]) {
        const opened = await stack.app.built.app.openFileForViewer(f.id, OWNER);
        const chunks: Buffer[] = [];
        for await (const c of opened!.stream) chunks.push(Buffer.from(c as Uint8Array));
        seen.push(f.name, Buffer.concat(chunks).toString("utf8"));
      }
      const leaks = seen.filter((s) => s.includes(SECRET)).map((s) => s.slice(0, 300));
      assert.deepEqual(leaks, [], "the secret shows up nowhere the user or the agent can read it back");
    } finally {
      await stack.stop(true);
    }
  },
);
