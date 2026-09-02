import "../support/auto-fake-sprites.ts";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { buildApp } from "../../src/wiring.ts";
import { createInsecureTestServer } from "../../src/api/server.ts";
import { parseMemoryProviderConfig } from "../../src/memory/provider-config.ts";
import { testConfig } from "../support/test-config.ts";
import { startExtractionStub } from "./support/memorable-extraction-stub.ts";

const NO_KEY = !process.env.ANTHROPIC_API_KEY;
const DB = process.env.MEMORABLE_E2E_DB_URL;
const CLI = process.env.MEMORABLE_E2E_BIN;
function skipReason(): string | false {
  if (NO_KEY) return "set ANTHROPIC_API_KEY";
  if (!DB) return "set MEMORABLE_E2E_DB_URL";
  if (!CLI) return "set MEMORABLE_E2E_BIN (e.g. `node /path/to/memorable-cli/dist/cli.js`)";
  return false;
}
const SKIP = skipReason();

describe("memorable provider e2e (live Pi + real memorable CLI + Postgres)", { skip: SKIP }, () => {
  const scope = "personal:U1";
  let stub: Awaited<ReturnType<typeof startExtractionStub>>;
  let server: Server;
  let base: string;
  let pool: pg.Pool;
  let cliEnv: NodeJS.ProcessEnv;

  before(async () => {
    stub = await startExtractionStub();
    pool = new pg.Pool({ connectionString: DB });
    await pool.query("DROP TABLE IF EXISTS memorable_procedures, memorable_mode, memorable_stats");
    cliEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL: DB,
      MEMORABLE_API_URL: stub.url,
      MEMORABLE_API_KEY: "mk_e2e_not_a_real_key_0000",
      MEMORABLE_HOME: mkdtempSync(join(tmpdir(), "memorable-home-")),
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    // Consent is the CLI's own act, per scope, exactly as an operator would do it.
    const [cmd, ...args] = CLI!.split(" ");
    execFileSync(cmd!, [...args, "enable", "--scope", scope], {
      env: { ...cliEnv, MEMORABLE_BACKEND: "qm", MEMORABLE_DB_URL: DB },
      stdio: "ignore",
    });

    const memoryProviderConfig = parseMemoryProviderConfig(
      JSON.stringify({
        providers: [{ id: "procedures", type: "memorable", bin: CLI!.split(" "), injectTimeoutMs: 30_000 }],
        routes: [
          { provider: "default", scopes: ["personal"], capture: "automatic" },
          { provider: "procedures", scopes: ["personal"], capture: "automatic", manage: false, label: "Procedures" },
        ],
      }),
      cliEnv,
    );
    const built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "memorable-e2e-")),
        harness: "pi",
        memoryProviderConfig,
        ...(process.env.PI_MODEL ? { modelId: process.env.PI_MODEL } : {}),
        anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
      }),
    );
    server = createInsecureTestServer(built.app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => stub.server.close(() => r()));
    await pool.end();
  });

  async function turn(text: string, threadRef: string): Promise<{ http: number; json: any }> {
    const res = await fetch(`${base}/v1/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        surface: "http-e2e",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef },
        text,
      }),
    });
    return { http: res.status, json: await res.json() };
  }

  async function procedures(): Promise<Array<{ id: string; title: string }>> {
    const r = await pool.query("SELECT id, json->>'title' AS title FROM memorable_procedures");
    return r.rows;
  }

  it("a tool-using turn is recorded as a procedure in the qm backend", { timeout: 240_000 }, async () => {
    const r = await turn(
      "Use the write tool to create osprey/config.txt containing exactly: anchor=7. " +
        "Then use the execute tool to run `cat osprey/config.txt` and report what it printed. " +
        "Also remember for later: my project is called Osprey.",
      "t-record",
    );
    assert.equal(r.http, 200);
    assert.equal(r.json.status, "ok");
    const deadline = Date.now() + 90_000;
    let rows = await procedures();
    while (!rows.length && Date.now() < deadline) {
      await new Promise((s) => setTimeout(s, 2000));
      rows = await procedures();
    }
    assert.ok(rows.length >= 1, "expected memorable record to store a procedure");
    assert.ok(rows[0]!.id.startsWith(`${scope}/`), `procedure keyed by scope: ${rows[0]!.id}`);
    const sent = stub.requests[0] as {
      tool_calls: Array<{ name: string }>;
      task_description?: string;
      harness?: string;
    };
    assert.equal(sent.harness, "qm");
    assert.ok(sent.tool_calls.some((c) => c.name === "write") && sent.tool_calls.some((c) => c.name === "execute"));
    assert.ok(
      !JSON.stringify(sent).includes(process.env.ANTHROPIC_API_KEY!),
      "secrets never reach the extraction call",
    );
  });

  it("a similar task recalls the procedure through the router", { timeout: 180_000 }, async () => {
    const r = await turn(
      "Task: create osprey/config.txt containing anchor=7 and cat it. BUT do not use any tools yet. First tell me: " +
        "does your system prompt contain a section headed 'Procedures' with a block that begins '<!-- retrieved brain context'? " +
        "Reply with exactly YES-PROCEDURE followed by the 'fix landed in' path it names, or exactly NO-PROCEDURE.",
      "t-recall",
    );
    assert.equal(r.http, 200);
    assert.match(r.json.reply, /YES-PROCEDURE/);
    assert.match(r.json.reply, /osprey\/config\.txt/);
  });
});
