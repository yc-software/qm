import { randomBytes } from "node:crypto";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import pg from "pg";
import { seedTestTenant } from "./test-tenant.ts";

const { base, signal, port } = workerData as { base: string; signal: Int32Array; port: MessagePort };
const baseUrl = new URL(base);
const prefix = baseUrl.pathname.slice(1);
const prepared = new Map<string, Promise<string>>();
let client: Promise<pg.Client> | undefined;

function admin(): Promise<pg.Client> {
  return (client ??= (async () => {
    const connected = new pg.Client({ connectionString: base });
    await connected.connect();
    return connected;
  })());
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

interface Request {
  template?: string;
  bare?: boolean;
  database?: string;
  sql?: string;
}

async function runSql(database: string, sql: string): Promise<string> {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  const connected = new pg.Client({ connectionString: url.toString() });
  await connected.connect();
  try {
    await connected.query(sql);
  } finally {
    await connected.end();
  }
  return database;
}

async function createDatabase({
  template = process.env.QM_TEST_TEMPLATE_DATABASE ?? "",
  bare = false,
}: Request): Promise<string> {
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  const from = bare ? "" : template;
  await (await admin()).query(`CREATE DATABASE ${quoted(name)}${from ? ` TEMPLATE ${quoted(from)}` : ""}`);
  if (!from && !bare) {
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    await seedTestTenant(url.toString());
  }
  return name;
}

function prepare(request: Request): void {
  const next = createDatabase(request);
  next.catch(() => {});
  prepared.set(JSON.stringify(request), next);
}

async function take(request: Request): Promise<string> {
  const name = await (prepared.get(JSON.stringify(request)) ?? createDatabase(request));
  prepare(request);
  return name;
}

parentPort!.on("message", async (request: Request) => {
  try {
    const name = request.database && request.sql ? await runSql(request.database, request.sql) : await take(request);
    port.postMessage({ ok: true, name });
  } catch (error) {
    port.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
