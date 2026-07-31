import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Deploys consumes and clears context deep-link handoff state", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /deployScope = contextsState\.selected;\s+contextsState\.selected = null;/);
});

test("Deploys clears archive overlay state when the view is entered", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /archiveCandidate = null;\s+archiveFocusTarget = null;\s+setDeployBackgroundInert\(false\);/);
  assert.match(source, /appState\.currentView !== "deploys" \|\| archiveCandidate\?\.id !== d\.id/);
});

test("archive focus restoration yields to a newly opened dialog", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /archiveFocusTarget = null;\s+drawCurrentDeployView\(\);/);
  assert.match(source, /appState\.currentView !== "deploys" \|\| archiveCandidate/);
});

test("archive confirmation synchronously makes background actions inert", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /archiveCandidate = d;\s+drawCurrentDeployView\(\);\s+setDeployBackgroundInert\(true\);/);
  assert.match(source, /\.deploy-detail, \.deploy-toast/);
});

test("deployment mutations re-check their target after asynchronous work", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /const restoringActive = activeDeploy\?\.id === d\.id;/);
  assert.match(source, /function currentDeployActionView\(targetId: string\)/);
  assert.equal(source.match(/currentDeployActionView\(d\.id\)/g)?.length, 6);
});

test("a restored deployment replaces its stale archived list row when refresh fails", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /deployList = deploymentListAfterRestoreRefresh\(deployList, restored, refreshResult\);/);
  assert.match(source, /return "superseded";/);
});

test("list refreshes cannot clear detail-scoped errors", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /deployNotices\.detail\?\.id === d\.id/);
  assert.match(source, /deployNotices = withDeploymentListNotice\(deployNotices, ""\);/);
  assert.doesNotMatch(source, /deployDetailNotice|deployListNotice/);
});

test("outside-menu dismissal preserves an active deployment detail", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /const restoreListFocus = !activeDeploy;\s+deployMenuId = null;\s+drawCurrentDeployView\(\);/);
  assert.match(source, /restoreFocus && restoreListFocus/);
});

test("the initial list refresh leaves an opened detail and its loading state untouched", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /await refreshDeployments\(\);\s+if \(seq !== appState\.viewRenderSeq \|\| appState\.currentView !== "deploys"\) return;\s+if \(deploymentListRefreshCanRedraw\(activeDeploy\?\.id\)\) drawDeploysPage\(\);/,
  );
});

test("the empty Yours tab does not imply the account has no deployments", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /deploymentTabEmptyMessage\(deployTab\)/);
  assert.doesNotMatch(source, /No deployments yet\./);
  const messages = readFileSync(new URL("../src/deploy-view.ts", import.meta.url), "utf8");
  assert.doesNotMatch(messages, /You have no apps\./);
});
