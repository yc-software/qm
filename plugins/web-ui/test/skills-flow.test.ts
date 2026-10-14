import { test } from "node:test";
import assert from "node:assert/strict";
import { SkillsRefreshSequence } from "../src/skills-refresh.ts";
import { SkillsMutationSequence } from "../src/skills-mutation.ts";

test("a reversed completion cannot let an older Skills refresh overwrite the latest response", async () => {
  const sequence = new SkillsRefreshSequence();
  let rows = "initial";
  let resolveOlder!: () => void;
  let resolveLatest!: () => void;
  const olderResponse = new Promise<void>((resolve) => {
    resolveOlder = resolve;
  });
  const latestResponse = new Promise<void>((resolve) => {
    resolveLatest = resolve;
  });
  const apply = async (request: number, response: Promise<void>, value: string) => {
    await response;
    if (sequence.isCurrent(request)) rows = value;
  };

  const older = apply(sequence.begin(), olderResponse, "older");
  const latest = apply(sequence.begin(), latestResponse, "latest");
  resolveLatest();
  await latest;
  resolveOlder();
  await older;

  assert.equal(rows, "latest");
});

test("a completed save cannot clear a newer skill draft", async () => {
  const sequence = new SkillsMutationSequence();
  let draft = "skill A";
  assert.equal(draft, "skill A");
  let resolveSave!: () => void;
  const response = new Promise<void>((resolve) => {
    resolveSave = resolve;
  });
  const operation = sequence.begin();
  const save = (async () => {
    await response;
    if (sequence.isCurrent(operation)) draft = "";
  })();

  sequence.invalidate();
  draft = "skill B";
  resolveSave();
  await save;

  assert.equal(draft, "skill B");
});

test("a completed save refresh cannot consume a newer flow opener", async () => {
  const sequence = new SkillsMutationSequence();
  let opener: string | null = "edit A";
  let restored: string | null = null;
  let refreshed = false;
  let resolveRefresh!: () => void;
  const refresh = new Promise<void>((resolve) => {
    resolveRefresh = resolve;
  });
  const operation = sequence.begin();
  const returnTarget = opener;
  opener = null;
  assert.equal(opener, null);
  const save = (async () => {
    await refresh;
    refreshed = true;
    if (!sequence.isCurrent(operation)) return;
    restored = returnTarget;
  })();

  sequence.invalidate();
  opener = "edit B";
  resolveRefresh();
  await save;

  assert.equal(opener, "edit B");
  assert.equal(restored, null);
  assert.equal(refreshed, true);
});
