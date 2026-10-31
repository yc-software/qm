import { randomBytes } from "node:crypto";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import pg from "pg";
import { seedTestTenants } from "./tenant-seed.ts";

const { base, signal, port } = workerData as { base: string; signal: Int32Array; port: MessagePort };
const baseUrl = new URL(base);
const prefix = baseUrl.pathname.slice(1);
const prepared = new Map<string, Promise<string>>();
let client: Promise<pg.Client> | undefined;
let dropClient: Promise<pg.Client> | undefined;

async function connect(): Promise<pg.Client> {
  const connected = new pg.Client({ connectionString: base });
  await connected.connect();
  return connected;
}

function admin(): Promise<pg.Client> {
  return (client ??= connect());
}

const released = new Set<string>();
let dropping = Promise.resolve();

async function dropIdle(): Promise<void> {
  const dropper = await (dropClient ??= connect());
  for (const name of released) {
    const { rows } = await dropper.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
      [name],
    );
    if (rows[0]!.n > 0) continue;
    released.delete(name);
    await dropper.query(`DROP DATABASE IF EXISTS ${quoted(name)}`).catch(() => released.add(name));
  }
}

let retry: NodeJS.Timeout | undefined;

function sweep(): void {
  dropping = dropping
    .then(dropIdle)
    .catch(() => undefined)
    .then(() => {
      if (released.size && !retry) {
        retry = setTimeout(() => {
          retry = undefined;
          sweep();
        }, 1000).unref();
      }
    });
}

function release(names: readonly string[]): void {
  for (const name of names) released.add(name);
  sweep();
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function createDatabase(template: string): Promise<string> {
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  await (await admin()).query(`CREATE DATABASE ${quoted(name)}${template ? ` TEMPLATE ${quoted(template)}` : ""}`);
  if (!template) {
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    await seedTestTenants(url.toString());
  }
  return name;
}

function prepare(template: string): void {
  const next = createDatabase(template);
  next.catch(() => {});
  prepared.set(template, next);
}

async function take(template: string): Promise<string> {
  const name = await (prepared.get(template) ?? createDatabase(template));
  prepare(template);
  return name;
}

parentPort!.on("message", async (request: { template?: string; release?: string[] }) => {
  if (request.release) return release(request.release);
  try {
    const name = await take(request.template ?? "");
    port.postMessage({ ok: true, name });
  } catch (error) {
    port.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  }
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
