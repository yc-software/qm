import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SkillsRefreshSequence } from "../src/skills-refresh.ts";
import { SkillsMutationSequence } from "../src/skills-mutation.ts";

const source = readFileSync(new URL("../src/skills.ts", import.meta.url), "utf8");

function bodyOf(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test("focused create/edit flows leave list search and filters untouched on open and close", () => {
  const flow = `${bodyOf("startCreate")}\n${bodyOf("startEdit")}\n${bodyOf("closeFocusedFlow")}`;
  assert.doesNotMatch(flow, /skillSearch\s*=|scopeFilter\s*=|sourceFilter\s*=|statusFilter\s*=/);
  assert.match(
    source,
    /if \(creating \|\| editingTarget\) \{\s*render\(creating \? creatorPane\(\) : editorPane\(\), skillsPageHost\);\s*return;/,
  );
});

test("closing a focused flow clears an unfinished edit loading notice", () => {
  assert.match(bodyOf("startEdit"), /skillsNotice = t\("Loading skill instructions…"\)/);
  assert.match(bodyOf("closeFocusedFlow"), /skillsNotice = ""/);
});

test("entering Skills clears archive overlay state from an earlier visit", () => {
  assert.match(
    bodyOf("renderSkills"),
    /if \(!skillsPageHost \|\| skillsPageHost\.parentElement !== appState\.mainEl\) \{\s*archiveConfirmation = null;\s*archiveFocusTarget = null;\s*setSkillsBackgroundInert\(false\);\s*\}/,
  );
});

test("edit loading and successful saves always move focus to a surviving control", () => {
  const startEdit = bodyOf("startEdit");
  assert.match(
    startEdit,
    /drawSkills\(\);\s*queueMicrotask\(\(\) => skillsPageHost\?\.querySelector<HTMLElement>\("\.context-back"\)\?\.focus\(\)\)/,
  );
  assert.match(
    startEdit,
    /querySelector<HTMLElement>\("#skill-edit-description"\)[\s\S]*querySelector<HTMLElement>\("\.context-back"\)/,
  );
  assert.match(
    bodyOf("saveEdit"),
    /await renderSkills\(\);\s*if \(!skillMutations\.isCurrent\(operation\)\) return;\s*restoreFocusedFlow\(returnTarget\)/,
  );
  assert.match(
    bodyOf("saveCreate"),
    /await renderSkills\(\);\s*if \(!skillMutations\.isCurrent\(operation\)\) return;\s*restoreFocusedFlow\(returnTarget\)/,
  );
  assert.match(
    bodyOf("saveEdit"),
    /if \(!skillMutations\.isCurrent\(operation\)\) \{\s*await renderSkills\(\);\s*return;/,
  );
  assert.match(
    bodyOf("saveCreate"),
    /if \(!skillMutations\.isCurrent\(operation\)\) \{\s*await renderSkills\(\);\s*return;/,
  );
  assert.match(
    bodyOf("restoreFocusedFlow"),
    /if \(creating \|\| editingTarget \|\| archiveConfirmation \|\| appState\.currentView !== "skills"\) return;/,
  );
  assert.match(
    bodyOf("restoreFocusedFlow"),
    /skillId\s*\?\s*\(?matchingEdit \?\? search \?\? create\)?\s*:\s*\(?create \?\? search\)?/,
  );
  assert.match(bodyOf("editorPane"), /editError \? t\("Instructions unavailable\."\) : t\("Loading instructions…"\)/);
  assert.equal(source.match(/shouldBlockRepeatedPublishClick\(reviewed, event\.detail\)/g)?.length, 2);
});

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
  assert.equal(source.match(/!skillsRefreshes\.isCurrent\(request\) \|\| seq !== appState\.viewRenderSeq/g)?.length, 2);
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

test("archive uses a modal dialog with an impact description and managed focus", () => {
  assert.match(
    source,
    /role="dialog"\s+aria-modal="true"\s+aria-labelledby="skill-archive-title"\s+aria-describedby="skill-archive-impact"/,
  );
  assert.match(source, /trapDialogFocus\(event, closeArchiveDialog\)/);
  assert.match(source, /restoreDialogFocus\(target, \(\) => fallback\)/);
  assert.match(source, /focusDialogCancel\(skillsPageHost\)/);
  assert.match(
    source,
    /querySelector<HTMLElement>\("\.list-search input"\)[\s\S]*querySelector<HTMLElement>\("\.list-page-action"\)/,
  );
});
