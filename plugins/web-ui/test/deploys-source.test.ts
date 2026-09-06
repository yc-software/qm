import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

function bodyOf(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

test("app index rows launch live apps by default and use Manage for app details", () => {
  const row = bodyOf("deploymentRow");
  const title = row.slice(row.indexOf("const title"), row.indexOf("return html`"));
  assert.doesNotMatch(
    row,
    /deploy-row-url|deploy-row-meta|ownerLabel|permissionBadge|versionLabel|deployedLabel|Copy app URL/,
  );
  assert.match(row, /deploymentTitle\(d\)/);
  assert.match(row, /statusLabel\(d\)/);
  assert.match(row, /running && d\.webUrl/);
  assert.match(row, /href=\$\{withBase\(d\.webUrl\)\}/);
  assert.match(row, /target="_blank"/);
  assert.match(row, /class="deploy-row-actions"[\s\S]*class="deploy-status/);
  assert.doesNotMatch(title, /deploy-status/);
  assert.match(row, /class="btn deploy-manage"[\s\S]*@click=\$\{\(\) => void openDeploy\(d\)\}/);
  assert.doesNotMatch(row, /deploy-menu|More actions/);
  assert.doesNotMatch(row, />Open \$\{icon\(ExternalLink/);
  assert.match(css, /\.deploy-row-main\[href\]::after \{\s*position: absolute;\s*inset: 0;/);
  assert.match(css, /\.deploy-row-actions \{\s*position: relative;\s*z-index: 1;/);
});

test("app index header keeps search and tabs without secondary controls", () => {
  const draw = bodyOf("drawDeploysPage");
  assert.doesNotMatch(draw, /onScope:|action:|controls:|deploySort|Deploy with Agent/);
  assert.match(draw, /placeholder: "Search apps"/);
  assert.match(draw, /deployTabs\(\)/);
});

test("the global Apps route clears a scope inherited from an earlier scoped visit", () => {
  assert.match(source, /else \{\s*deployScope = null;\s*\}/);
});

test("app index content uses the shared centered layout", () => {
  assert.doesNotMatch(
    css,
    /\.deploys-page \.list-page-head,\s*\.deploys-page \.list-search,\s*\.deploys-page \.list-rows \{\s*margin-right: 0;\s*margin-left: 0;/,
  );
  assert.match(
    css,
    /\.deploy-row-main \{\s*min-width: 0;\s*display: flex;\s*flex-direction: row;\s*align-items: center;\s*justify-content: flex-start;/,
  );
});

test("Deploys consumes and clears context deep-link handoff state", () => {
  assert.match(source, /deployScope = contextsState\.selected;\s+contextsState\.selected = null;/);
});

test("Deploys clears archive overlay state when the view is entered", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /archiveCandidate = null;\s+restoreArchiveFocus = false;\s+setDeployBackgroundInert\(false\);/);
  assert.match(source, /appState\.currentView !== "deploys" \|\| archiveCandidate\?\.id !== d\.id/);
});

test("archive focus restoration yields to a newly opened dialog", () => {
  const source = readFileSync(new URL("../src/deploys.ts", import.meta.url), "utf8");
  assert.match(source, /restoreArchiveFocus = false;\s+drawCurrentDeployView\(\);/);
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
