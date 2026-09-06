import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";
import type { Lease, SessionStore } from "../../src/sessions/session-store.ts";
import type { Session } from "../../src/types.ts";
import { errMessage } from "../../src/util/errors.ts";

export function argValue(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`${name} requires a value`);
    process.exit(1);
  }
  return value;
}

export interface BackfillArgs {
  apply: boolean;
  only: string | undefined;
  force: boolean;
}

export function parseBackfillArgs(forceMessage?: string): BackfillArgs {
  const apply = process.argv.includes("--apply");
  const only = argValue("--session");
  const force = process.argv.includes("--force");
  if (force && forceMessage === undefined) {
    console.error("--force is not supported by this script");
    process.exit(1);
  }
  if (force && !only) {
    console.error(`--force requires --session (${forceMessage})`);
    process.exit(1);
  }
  return { apply, only, force };
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  return url;
}

export function openSessionStore(): SessionStore {
  return createPostgresSessionStore(databaseUrl());
}

export async function resolveSessions(store: SessionStore, only: string | undefined): Promise<Session[]> {
  if (only === undefined) return store.scanAll();
  const session = await store.get(only);
  if (!session) {
    console.error(`unknown session: ${only}`);
    process.exit(1);
  }
  return [session];
}

export type BackfillStep = { action: "work"; detail: string } | { action: "skip"; reason: string; quiet?: boolean };

export async function runBackfill(opts: {
  verb: { dry: string; done: string };
  store: SessionStore;
  sessions: readonly Session[];
  apply: boolean;
  preview: (session: Session) => Promise<BackfillStep>;
  applyStep: (session: Session, lease: Lease) => Promise<BackfillStep>;
}): Promise<never> {
  const { verb, store, sessions, apply } = opts;
  let worked = 0;
  const skips = new Map<string, number>();
  let busy = 0;
  let failed = 0;
  const skip = (sessionId: string, step: { reason: string; quiet?: boolean }): void => {
    skips.set(step.reason, (skips.get(step.reason) ?? 0) + 1);
    if (!step.quiet) console.log(`${step.reason}, skipped: ${sessionId}`);
  };

  for (const session of sessions) {
    try {
      const previewed = await opts.preview(session);
      if (previewed.action === "skip") {
        skip(session.id, previewed);
        continue;
      }
      if (!apply) {
        worked++;
        console.log(`${verb.dry} ${session.id} (${previewed.detail})`);
        continue;
      }
      const { lease } = await store.acquireLease(session.id, "backfill");
      if (!lease) {
        busy++;
        console.log(`busy, skipped: ${session.id}`);
        continue;
      }
      try {
        const done = await opts.applyStep(session, lease);
        if (done.action === "skip") {
          skip(session.id, done);
          continue;
        }
        worked++;
        console.log(`${verb.done} ${session.id} (${done.detail})`);
      } finally {
        await store.releaseLease(lease);
      }
    } catch (err) {
      failed++;
      console.error(`failed ${session.id}: ${errMessage(err)}`);
    }
  }

  const skipSummary = [...skips.entries()].map(([reason, n]) => `${reason} ${n}`).join(", ");
  console.log(
    `${apply ? verb.done : verb.dry} ${worked}${skipSummary ? `, ${skipSummary}` : ""}, busy ${busy}, failed ${failed} (of ${sessions.length} sessions)`,
  );
  process.exit(failed ? 1 : 0);
}
