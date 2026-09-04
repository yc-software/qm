import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("admin shell uses the QM identity with org-injectable branding", () => {
  assert.match(html, /<title>QM Admin<\/title>/);
  assert.match(html, /<meta name="brand-self-label" content="Agent" \/>/);
  assert.match(html, /<div class="brand"><span id="brand-product">Agent<\/span>&nbsp;Admin /);
  assert.doesNotMatch(html, new RegExp(["Work", "Claw"].join(" "), "i"));
  assert.doesNotMatch(html, new RegExp(["Quarter", "master"].join(""), "i"));
});

test("admin shell defaults bare admin URLs to org history", () => {
  assert.match(html, /const DEFAULT_VIEW = "history";/);
  assert.match(html, /let view = DEFAULT_VIEW;/);
  assert.match(
    html,
    /let resolvedView = DEFAULT_VIEW;\s*if \(VIEWS\.includes\(v\)\) resolvedView = v;\s*else if \(session\) resolvedView = "history";[\s\S]*view: resolvedView/,
  );
});

test("connector setup uses the live catalog and shows exact provider and callback links", () => {
  assert.match(html, /api\("GET", "\/api\/connector-catalog"\)/);
  assert.match(html, /setupGuide\.url/);
  assert.match(html, /location\.origin \+ "\/v1\/connectors\/oauth\/" \+ connector\.redirectPath/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /Configured by deployment secrets/);
  assert.match(html, /item\.configured/);
  assert.doesNotMatch(html, /const CONNECTOR_CATALOG = \[/);
  assert.match(html, /id="slack-bot-token"/);
  assert.match(html, /api\("PUT", "\/api\/slack-installation"/);
  assert.match(html, /encrypted in durable storage/);
});

test("temporary onboarding covers model credentials, Slack, and OAuth setup", () => {
  assert.match(html, /view-onboarding/);
  assert.match(html, /Model provider/);
  assert.match(html, /OpenRouter/);
  assert.match(html, /api\("GET", "\/api\/model-providers"\)/);
  assert.match(html, /api\("PUT", "\/api\/model-providers\/" \+ encodeURIComponent\(provider\)/);
  assert.match(html, /models\.data\.models/);
  assert.doesNotMatch(html, /const ONBOARDING_MODELS/);
  assert.match(html, /viewLoadedAt\.onboarding = Date\.now\(\)/);
  assert.match(html, /data-onboarding-target="slack"/);
  assert.match(html, /data-onboarding-target="oauth"/);
});

test("admin shell addresses views by path, not a ?view= query param", () => {
  assert.match(html, /const path = API_BASE \+ "\/" \+ encodeURIComponent\(st\.view \|\| DEFAULT_VIEW\);/);
  assert.doesNotMatch(html, /p\.set\("view", st\.view\)/);
  assert.match(html, /const raw = p\.get\("view"\) \|\| fromPath;/);
  assert.doesNotMatch(html, /st\.view !== "governance"/);
});

test("mobile admin navigation keeps the active section visible and controls touchable", () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /--header-total-h: calc\(var\(--header-h\) \+ var\(--header-safe-top\)\)/);
  assert.match(html, /padding: var\(--header-safe-top\)/);
  assert.match(html, /top: var\(--header-total-h\)/);
  assert.match(html, /\.governance-page-head\s*\{\s*top:\s*calc\(var\(--header-total-h\) \+ 61px\);\s*\}/);
  assert.doesNotMatch(html, /top: (?:calc\()?var\(--header-h\)/);
  assert.doesNotMatch(html, /scroll-margin-top: calc\(var\(--header-h\)/);
  assert.match(html, /const narrowAdminNav = matchMedia\("\(max-width: 900px\)"\);/);
  assert.match(html, /narrowAdminNav\.addEventListener\("change"/);
  assert.match(html, /if \(!active\.isConnected\) return;[\s\S]*if \(!scroller\) return;/);
  assert.match(
    html,
    /scroller\.scrollLeft \+= activeRect\.left - scrollerRect\.left - \(scroller\.clientWidth - activeRect\.width\) \/ 2/,
  );
  assert.doesNotMatch(html, /scroll-snap-(?:type|align)/);
  assert.match(html, /\.tab\s*\{[^}]*flex:\s*0 0 auto;[^}]*width:\s*auto;[^}]*min-height:\s*44px;/);
  assert.match(html, /@media \(max-width: 400px\)[\s\S]*\.who \.pill\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /safe-area-inset-bottom/);
});

test("admin history previews quote the first message instead of saying started", () => {
  assert.equal((html.match(/\?\s*"> "\s*\+\s*s\.firstMessage\s*:\s*"created "/g) || []).length, 1);
  assert.doesNotMatch(html, /\? "started " \+ s\.firstMessage : "created "/);
});

test("transcript visibility controls stay in the sticky header and filter lazy-rendered entries", () => {
  const transcript = html.slice(html.indexOf("async function showTranscript("));
  assert.match(html, /id="header-controls" aria-label="Page controls"/);
  assert.match(html, /checkbox\("thinking", "thinking"\)/);
  assert.match(html, /checkbox\("tool results", "toolResults"\)/);
  assert.match(html, /materialize\(from, firstRendered, true\);[\s\S]*applyTranscriptControls\(\);/);
  assert.match(html, /applyTranscriptControls\(\);\s*const addedHeight = document\.body\.scrollHeight - prevHeight;/);
  assert.match(html, /if \(addedHeight > 1\) io\.observe\(sentinel\);\s*else pauseFilteredReveal\(\);/);
  assert.ok(
    transcript.indexOf("renderTranscriptHeaderControls(() => applyTranscriptControls());") <
      transcript.indexOf("const r = await api("),
    "controls render before the transcript request",
  );
  assert.match(html, /\.header-check \{[^}]*min-height: 44px/);
  assert.match(
    html,
    /\.header-controls:not\(:empty\) \+ \.who \.header-button\s*\{[^}]*width:\s*44px;[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/,
  );
});

test("transcript filters hide diagnostics without hiding folded delivery evidence", () => {
  const source = html.match(/function transcriptEntryHidden\([^)]*\) \{[\s\S]*?\n {6}\}/)?.[0];
  assert.ok(source, "transcriptEntryHidden helper exists");
  const hidden = new Function(`${source}; return transcriptEntryHidden;`)();
  const all = { thinking: true, toolResults: true };
  const noThinking = { thinking: false, toolResults: true };
  const noTools = { thinking: true, toolResults: false };
  assert.equal(hidden(["thinking"], false, all), false);
  assert.equal(hidden(["thinking"], false, noThinking), true);
  assert.equal(hidden(["tool_call", "tool_result"], false, noTools), true);
  assert.equal(hidden(["tool_call"], false, noTools), true);
  assert.equal(hidden(["tool_call", "tool_result", "outbound_delivery"], true, noTools), false);
  assert.equal(hidden(["user"], false, { thinking: false, toolResults: false }), false);
});

test("governance posture saves refresh only the saved card", () => {
  const reloads = html.match(/const SAVE_RELOADS = new Set\(\[[^\n]+/)?.[0] ?? "";
  assert.doesNotMatch(reloads, /security-posture|ambient-policy/);
  assert.match(html, /if \(key === "security-posture" \|\| key === "ambient-policy"\)/);
});

test("governance presents a scoped effective-state control plane", () => {
  assert.match(html, /class="governance-page-head"/);
  assert.match(html, /id="governance-overview"/);
  assert.match(html, /aria-label="Governance sections"/);
  for (const id of [
    "governance-autonomy",
    "governance-boundaries",
    "governance-intelligence",
    "governance-credentials",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
    assert.match(html, new RegExp(`href="#${id}"`));
  }
  assert.match(html, /function renderGovernanceOverview\(data\)/);
  assert.match(html, /Effective security posture/);
  assert.match(html, /Resolved at organization scope/);
});

test("governance renders simple settings as compact rows with contextual actions", () => {
  for (const id of [
    "card-security-posture",
    "card-external-slack",
    "card-base-model",
    "card-people-directory",
    "card-browse-model",
    "card-browse-max-steps",
    "card-turn-wall-clock",
  ]) {
    assert.match(html, new RegExp(`class="card setting-row(?: hidden)?" id="${id}"`));
  }
  assert.match(html, /class="setting-toggle"/);
  assert.match(html, /class="setting-switch" aria-hidden="true"/);
  assert.match(html, /data-save="external-slack-participants">\s*Apply\s*<\/button\s*>/);
  assert.match(html, /"turnWallClockSec" in r\.data/);
});

test("compact governance rows preserve policy detail and collapse before they overflow", () => {
  assert.doesNotMatch(html, /#view-governance \.setting-row > \.head p[^}]*line-clamp/);
  assert.doesNotMatch(html, /#view-governance \.setting-row > \.foot \.status[^}]*white-space:\s*nowrap/);
  assert.match(
    html,
    /@media \(max-width: 640px\)[\s\S]*#view-governance \.setting-row\s*\{[^}]*grid-template-columns:\s*1fr;/,
  );
  assert.match(html, /#view-governance \.setting-row > \.foot \.status[^}]*overflow-wrap: anywhere/);
  assert.match(html, /#view-governance section\.card\.setting-row\s*\{\s*padding:\s*12px 14px;\s*\}/);
  assert.match(html, /#view-governance \.setting-row\.hidden\s*\{\s*display:\s*none;\s*\}/);
});

test("governance reviews high-impact changes in product and preserves drafts", () => {
  assert.match(html, /<dialog class="review-dialog" id="governance-review"/);
  assert.match(html, /key === "security-posture"/);
  assert.match(html, /key === "external-slack-participants"/);
  assert.match(html, /Review the immutable change below/);
  assert.match(html, /function hasGovernanceDraft\(\)/);
  assert.match(html, /function governanceScopeName\(scopeId = scope\)/);
  assert.match(html, /"Organization · " \+ scopeId/);
  assert.match(html, /window\.addEventListener\("beforeunload"/);
  assert.match(html, /function governanceSaveInFlight\(\)/);
  assert.match(html, /The change may already be committing and cannot be safely discarded/);
  assert.match(html, /confirm\.classList\.toggle\("hidden", !confirmLabel\)/);
  assert.doesNotMatch(html, /confirm\("Enable Dangerous/);
});

test("governance makes unenforced egress a draft instead of an effective control", () => {
  assert.match(html, /id="egress-capability"/);
  assert.match(html, />\s*Save draft\s*<\/button\s*>/);
  assert.match(html, /data\.egressEnforcement/);
  assert.match(html, /enforcement\.active \? "Save policy" : "Save draft"/);
  assert.match(html, /enforcement\.reason === "control_plane_unconfigured"/);
  assert.match(html, /control plane cannot mint a reachable proxy token/);
  assert.match(html, /Backend supports policy; control plane inactive/);
  assert.match(html, /Backend cannot enforce host policy/);
});

test("governance keeps effective-state summaries synchronized after focused saves", () => {
  assert.match(html, /renderGovernanceOverview\(fresh\.data\)/);
  assert.match(html, /renderGovernanceOverview\(\{ \.\.\.governanceOverviewData, egress: body \}\)/);
  assert.match(html, /btn\.dataset\.saveRequest === saveRequest/);
  assert.match(html, /setStatus\(SAVE_ST\[key\], "", ""\)/);
});

test("stale governance reads cannot overwrite a newer scope", () => {
  assert.match(html, /const requestId = \+\+governanceReq/);
  assert.match(html, /if \(requestId !== governanceReq \|\| requestedScope !== scope\) return;/);
  assert.match(html, /encodeURIComponent\(requestedScope\) \+ "\/" \+ key/);
});

test("effective egress summary preserves deny-before-allow semantics", () => {
  assert.match(
    html,
    /plural\(effectiveAllowCount, "allowed host"\)[\s\S]*plural\(effectiveDenyCount, "explicitly denied host"\)[\s\S]*deny rules first[\s\S]*all other hosts denied/,
  );
  assert.match(
    html,
    /else if \(effectiveDenyCount\) \{\s*effectiveEgressLabel = plural\(effectiveDenyCount, "denied host"\) \+ " · all other hosts allowed";/,
  );
});

test("egress validation follows programmatic reloads and successful saves", () => {
  assert.match(html, /populateEgress\(r\.data\.egress\)/);
  assert.match(html, /function populateEgress\(policy\)[\s\S]*renderEgressValidation\(\)/);
  assert.match(html, /if \(key === "egress"\)[\s\S]*renderGovernanceOverview[\s\S]*renderEgressValidation\(\)/);
});

test("the removed config-transfer surface stays gone", () => {
  assert.doesNotMatch(html, /governance-transfer|card-config-transfer|configImport|"ct-export"|"ct-import"/);
});

test("the removed API-reference tab stays gone", () => {
  assert.doesNotMatch(html, /renderApiDocs|"api"|api: "API"/);
});

test("policy simulator caveats only implicit allows", () => {
  assert.match(
    html,
    /decision === "allow" && response\.data\.ruleSource == null && response\.data\.deploymentRulesEvaluated === false/,
  );
});

test("untouched command simulation preserves the server default policy floor", () => {
  assert.match(html, /loadedCommandPolicyPresent = r\.data\.commandPolicy != null/);
  assert.match(
    html,
    /if \(loadedCommandPolicyPresent \|\| \$\("card-command-policy"\)\.classList\.contains\("dirty"\)\)\s*simulateBody\.policy = policy/,
  );
  assert.match(html, /if \(key === "command-policy"\) loadedCommandPolicyPresent = true/);
});

test("governance credential editor previews effective capability and uses an in-product immutable delete confirmation", () => {
  for (const id of [
    "sc-cap-host",
    "sc-cap-auth",
    "sc-cap-methods",
    "sc-cap-paths",
    "sc-cap-principals",
    "sc-cap-secret",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /function renderServiceCredentialCapability\(\)/);
  assert.match(html, /expectedUpdatedAt: c\.updatedAt/);
  assert.match(html, /function refreshServiceCredentialConflict\(\)/);
  assert.match(html, /if \(refreshedEditing\) scEditVersion = refreshedEditing\.updatedAt/);
  assert.match(html, /scEditing && scEditVersion != null \? \{ expectedUpdatedAt: scEditVersion \}/);
  assert.match(html, /it remains an edit and cannot recreate the credential/);
  assert.match(html, /latest state could not be loaded\. Refresh the page before deleting/);
  assert.match(html, /latest revision could not be loaded\. Your draft is preserved/);
  assert.match(html, /Save failed because the admin service could not be reached/);
  assert.match(
    html,
    /catch \{\s*updateScFormDirty\(\);\s*setStatus\(\s*"st-service-credentials",\s*"Save failed because the admin service could not be reached/,
  );
  assert.match(html, /usageTruncated \? "at least "/);
  assert.match(html, /Recent users in the retained window/);
  assert.doesNotMatch(html, /serviceCredList\.find\(\(c\) => c\.slug === scEditing\)\?\.updatedAt/);
  assert.match(html, /personal\|team\|org\|channel\|group/);
  assert.match(html, /unsupported legacy grant/);
  assert.match(html, /matches multiple people/);
  assert.match(html, /reviewGovernanceChange/);
  assert.doesNotMatch(html, /confirm\("Delete shared credential/);
});

test("governance SOUL workbench shows draft diff, history, and conflict-safe restore", () => {
  assert.match(html, /id="soul-saved"/);
  assert.match(html, /id="soul-draft"/);
  assert.match(html, /id="soul-history"/);
  assert.match(html, /expectedVersion: soulVersion/);
  assert.match(html, /function refreshSoulConflict\(\)/);
  assert.match(html, /Restore SOUL version/);
});
