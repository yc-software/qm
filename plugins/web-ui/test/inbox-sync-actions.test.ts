import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("inbox sync states use the same labeled action button", () => {
  assert.match(source, /function syncActionTpl/);
  assert.match(source, /class="btn inbox-sync-action"/);
  assert.match(source, /label: "Refresh"/);
  assert.match(source, /label: "Sync"/);
  assert.match(source, /class="inbox-setup-action"/);
  assert.match(source, /busyLabel: "Refreshing…"/);
  assert.match(source, /busyLabel: "Syncing…"/);
  assert.match(source, /"Setting up…" : "Set up"/);
});

test("a pending inbox migration lives in the sync line instead of a banner", () => {
  assert.doesNotMatch(source, /Moving your existing Inbox/);
  assert.doesNotMatch(source, /migrationPending \? html`<div class="inbox-notice"/);
  assert.match(
    source,
    /const moving = inboxState\.migrationPending;\s*if \(!crons\.length && !moving\) return nothing;/,
  );
  assert.match(source, /disabled: moving,/);
  assert.match(source, /tooltip: moving \? MIGRATION_HINT : "Sync now"/);
  assert.match(
    source,
    /<span class="inbox-sync-status" role=\$\{moving \? "status" : nothing\}>\$\{moving \? MIGRATION_STATUS : status\}<\/span>/,
  );
  assert.match(source, /inboxState\.migrationPending \? MIGRATION_STATUS : "Sync not set up"/);
  assert.match(source, /\$\{inboxState\.migrationPending \? tip\(MIGRATION_HINT\) : nothing\}/);
  assert.match(source, /\?disabled=\$\{inboxState\.syncBusy \|\| inboxState\.migrationPending\}/);
  assert.match(
    css,
    /\.inbox-surface\.compact \.inbox-sync-line > \.inbox-sync-status:not\(\[role="status"\]\) \{\s*display: none;/,
  );
});
