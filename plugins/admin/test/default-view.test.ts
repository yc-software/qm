import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function resolvedDisplay(classes: string[]) {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  const held = new Set(classes);
  let display = "";
  let important = false;
  for (const [, selectors, body] of styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const matches = selectors.split(",").some(
      (selector) =>
        /^(\.[A-Za-z0-9_-]+)+$/.test(selector.trim()) &&
        selector
          .trim()
          .split(".")
          .filter(Boolean)
          .every((name) => held.has(name)),
    );
    if (!matches) continue;
    for (const [, value, bang] of body.matchAll(/display:\s*([a-z-]+)\s*(!important)?\s*;/g)) {
      if (important && !bang) continue;
      display = value;
      important = !!bang;
    }
  }
  return display;
}

test("admin shell uses the QM identity with org-injectable branding", () => {
  assert.match(html, /<title>QM Admin<\/title>/);
  assert.match(html, /<meta name="brand-self-label" content="QM" \/>/);
  assert.match(html, /<header class="top">/);
  assert.match(html, /id="home-link">← Back to home<\/a>/);
  assert.match(html, /<span class="brand-mark" aria-hidden="true"><\/span>/);
  assert.match(
    html,
    /<span class="brand-name"\s*>\s*<span id="brand-product" data-brand-product>QM<\/span> <span class="brand-suffix">\(admin\)<\/span>/,
  );
  assert.match(html, /<aside class="admin-sidebar"[^>]*>\s*<div class="brand">/, "the lockup sits in the sidebar");
  assert.match(html, /<main class="admin-main" id="main" aria-label="Admin content">/);
  assert.doesNotMatch(html, new RegExp(["Work", "Claw"].join(" "), "i"));
  assert.doesNotMatch(html, new RegExp(["Quarter", "master"].join(""), "i"));
});

test("admin shell groups control, logs, and artifacts like the reorganization", () => {
  assert.match(
    html,
    /const SECTIONS = \[\s*\{ views: \["governance", "models", "credentials", "connectors", "customize", "users"\] \},\s*\{ label: "Logs", views: \["history", "slack", "judgments", "errors", "audit", "egress", "metrics"\] \},\s*\{ label: "Artifacts", views: \["files", "skills", "memory", "deployments", "crons", "retention"\] \},\s*\];/,
  );
  assert.match(html, /history: "Sessions"/);
  assert.match(
    html,
    /const VIEWS = \[\.\.\.SECTIONS\.flatMap\(\(s\) => s\.views\), "onboarding", "user", "ackemoji", "keychain"\];/,
  );
});

test("deployment management is presented as Apps", () => {
  assert.match(html, /deployments: "Apps"/);
  assert.match(html, /Search all apps…/);
  assert.doesNotMatch(html, /deployments: "Deployments"/);
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
  assert.match(html, /if \(key === "security-posture" \|\| key === "sharing-posture" \|\| key === "ambient-policy"\)/);
});

test("compact ambient reply policy tracks the value after each save", () => {
  assert.match(html, /if \(key === "org-ambient"\) \{/);
  assert.match(html, /governanceOrgAmbientSaved = body\.on \? "on" : "off"/);
  assert.match(html, /\$\("governance-org-ambient-save"\)\.disabled = true/);
  assert.match(
    html,
    /orgAmbientStatus\.classList\.contains\("err"\)[\s\S]*\$\("governance-org-ambient-save"\)\.disabled = false/,
  );
});

test("governance retains scoped effective-state data behind the compact reference layout", () => {
  assert.doesNotMatch(html, /class="governance-page-head"/);
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
  assert.match(html, /Effective sharing posture/);
  assert.match(html, /Resolved at organization scope/);
  assert.match(
    html,
    /#view-governance > \.governance-overview,[\s\S]*#view-governance \.governance-sections,[\s\S]*#view-governance \.governance-group,[\s\S]*display: none !important;/,
  );
});

test("control-plane pages use the shared web UI canvas without redundant page introductions", () => {
  assert.doesNotMatch(html, /const GOV_HEADS/);
  assert.doesNotMatch(html, /Set the organization’s operating boundaries/);
  assert.doesNotMatch(html, /The runtimes, models, and browsing defaults agents run with/);
  assert.match(
    html,
    /#view-governance \.governance-content \{[\s\S]*border: 0;[\s\S]*background: transparent;[\s\S]*box-shadow: none/,
  );
  assert.match(html, /--cta: oklch\(0\.27 0\.062 250\)/);
  assert.match(html, /data-choice-for="security-posture"/);
  assert.match(html, /data-choice-for="sharing-posture"/);
  assert.match(html, /data-checkbox-for="external-slack-participants"/);
  assert.match(html, /governanceAmbient\.id = "card-governance-org-ambient"/);
  assert.match(html, /id="sc-editor"/);
  assert.match(html, /id="sc-add">\+ Add credential/);
  assert.match(html, /id="conn-editor"/);
  assert.match(html, /id="slack-token-editor"/);
  assert.match(html, /id="soul-preview"/);
  assert.match(html, /body\[data-subview="connectors"\] \.shellbar/);
  assert.match(html, /connectorTip\.className = "connector-dm-tip hidden"/);
  assert.doesNotMatch(html, /First match wins/);
  assert.doesNotMatch(html, /direct mutations blocked/);
  assert.doesNotMatch(html, /The org setting is a minimum/);
  assert.doesNotMatch(html, /The runtime inherited by scopes without an override/);
});

test("governance renders simple settings as compact rows with contextual actions", () => {
  for (const id of [
    "card-security-posture",
    "card-sharing-posture",
    "card-external-slack",
    "card-base-model",
    "card-people-directory",
    "card-turn-wall-clock",
  ]) {
    assert.match(html, new RegExp(`class="card(?: sv-[a-z]+)? setting-row(?: hidden)?" id="${id}"`));
  }
  assert.match(html, /class="setting-toggle"/);
  assert.match(html, /class="setting-switch" aria-hidden="true"/);
  assert.match(html, /data-save="external-slack-participants">\s*Apply\s*<\/button\s*>/);
  assert.match(html, /"turnWallClockSec" in r\.data/);
});

test("default runtime controls save reasoning level and fast mode", () => {
  assert.match(html, /id="base-effort"/);
  assert.match(html, /id="base-fast-mode"/);
  assert.match(html, /id="base-fast-mode-control"/);
  assert.match(html, /thinkingLevelsByHarness/);
  assert.match(html, /fastModeModelIds/);
  assert.match(html, /fastModeHarnessIds/);
  assert.match(html, /base-fast-mode-control"\)\.style\.display = fastCapable \? "" : "none"/);
  assert.match(
    html,
    /runtime: \(\) => \(\{[\s\S]*effortLevel: \$\("base-effort"\)\.value,[\s\S]*fastMode: \$\("base-fast-mode"\)\.checked/,
  );
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
  assert.equal(resolvedDisplay(["setting-row", "hidden"]), "none");
});

test("governance reviews high-impact changes in product and preserves drafts", () => {
  assert.match(html, /<dialog class="review-dialog" id="governance-review"/);
  assert.match(html, /key === "security-posture"/);
  assert.match(html, /key === "sharing-posture"/);
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

test("governance disables egress controls when agent computers cannot enforce them", () => {
  assert.match(html, /id="egress-capability"/);
  assert.doesNotMatch(html, /View deployment/);
  assert.match(html, /id="egress-deny-editor"/);
  assert.match(html, /id="egress-allow-editor"/);
  assert.match(html, /class="egress-empty-state"/);
  assert.match(html, /id="egress-add-deny">\+ Denylist/);
  assert.match(html, /id="egress-add-allow">\+ Allowlist/);
  assert.match(html, /data\.egressEnforcement/);
  assert.match(html, /egressCard\.classList\.toggle\("egress-disabled", !enforcement\.active\)/);
  assert.match(html, /capability\.classList\.toggle\("hidden", !!enforcement\.active\)/);
  assert.match(html, /control\.disabled = !enforcement\.active/);
  assert.match(html, /enforcement\.reason === "control_plane_unconfigured"/);
  assert.match(html, /Egress enforcement has not been activated for agent computers/);
  assert.match(html, /Backend supports policy; control plane inactive/);
  assert.match(html, /Backend cannot enforce host policy/);
  assert.doesNotMatch(html, /fidelity, which cannot enforce outbound host policy/);
  assert.doesNotMatch(html, /Agents still have open outbound access/);
  assert.match(html, /Agent computer egress policy unavailable/);
  assert.match(html, /"Agent computers use "\s*\+\s*titleCase\(enforcement.backend\)/);
  assert.match(html, /cannot enforce host restrictions on all outbound traffic/);
  assert.match(html, /A configured egress proxy still applies policy to traffic sent through it/);
  assert.doesNotMatch(html, /This deployment’s|The deployment backend cannot enforce/);
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

test("egress omits the backend enforcement summary and hides empty editors", () => {
  assert.doesNotMatch(html, /class="egress-state"/);
  assert.doesNotMatch(html, /id="egress-backend"|id="egress-enforcement"|id="egress-effective"/);
  assert.doesNotMatch(html, /Policy is enforced|enforces this policy/);
  assert.match(html, /Denylist: hosts the agent may never reach/);
  assert.match(html, /Allowlist: when present, only these outbound hosts may be reached/);
  assert.match(html, /const hasRules = allowedHosts\.length > 0 \|\| deniedHosts\.length > 0/);
  assert.match(html, /\$\("egress-deny-editor"\)\.classList\.toggle\("hidden", deniedHosts\.length === 0\)/);
  assert.match(html, /\$\("egress-allow-editor"\)\.classList\.toggle\("hidden", allowedHosts\.length === 0\)/);
});

test("egress validation follows programmatic reloads and successful saves", () => {
  assert.match(html, /populateEgress\(r\.data\.egress\)/);
  assert.match(html, /function populateEgress\(policy\)[\s\S]*renderEgressValidation\(\)/);
  assert.match(html, /if \(key === "egress"\)[\s\S]*renderGovernanceOverview[\s\S]*populateEgress\(body\)/);
});

test("command policy uses compact sentence rows and a modal tester", () => {
  assert.doesNotMatch(html, /id="mode"|class="policy-mode"/);
  assert.match(html, /commandPolicyMode = cp\?\.mode \|\| "denylist"/);
  assert.match(html, /return \{ mode: commandPolicyMode, rules \}/);
  assert.match(html, /row\.append\(sel, pat, rsn, del\)/);
  assert.match(html, /\$\("rules"\)\.prepend\(row\)/);
  assert.match(html, /slice\(3\)/);
  assert.match(html, /id="policy-test-dialog"/);
  assert.match(html, /\$\("policy-test-dialog"\)\.showModal\(\)/);
  assert.doesNotMatch(html, /Patterns matched against each executed command/);
  assert.doesNotMatch(html, /Priority<\/th>|Order<\/th>|Move rule up|Move rule down/);
});

test("the removed config-transfer surface stays gone", () => {
  assert.doesNotMatch(html, /governance-transfer|card-config-transfer|configImport|"ct-export"|"ct-import"/);
});

test("the removed API-reference tab stays gone", () => {
  assert.doesNotMatch(html, /renderApiDocs|"api"|api: "API"/);
});

test("policy simulator omits deployment caveats", () => {
  assert.doesNotMatch(
    html,
    /deploymentRulesEvaluated|deployment’s rules may still restrict|Deployment rules may further restrict/i,
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

test("the hidden utility hides an element whose component rule is declared later", () => {
  assert.match(html, /<aside class="environment-notice hidden" id="environment-notice"/);
  assert.match(html, /notice\.classList\.toggle\("hidden", !attachment\)/);
  assert.equal(resolvedDisplay(["environment-notice"]), "flex");
  assert.equal(resolvedDisplay(["environment-notice", "hidden"]), "none");
  for (const component of ["admin-app", "scope-menu", "pack-adv", "ovmenu", "dense-row", "setting-row"]) {
    assert.equal(resolvedDisplay([component, "hidden"]), "none");
  }
});

test("admin parity views expose the requested card groups and real navigation actions", () => {
  for (const text of [
    "Security posture",
    "Sharing posture",
    "Command policy",
    "Ambient reply policy",
    "Egress policy",
    "External Slack audience",
    "Default runtime",
    "Custom providers",
    "Enabled models",
    "Organization SOUL",
    "Branding",
    "People directory",
    "Channel defaults",
    "Turn budget",
    "Feature flags",
    "Shared service credentials",
    "Personal keychains",
    "Slack installation",
    "OAuth apps",
    "Built-in connectors",
  ]) {
    assert.ok(html.includes(text), `missing ${text}`);
  }
  for (const action of [
    "View judgment log ›",
    "View logs ›",
    "View history ›",
    "+ Add provider",
    "+ Add flag",
    "View usage ›",
    "View users ›",
    "Rotate tokens…",
    "+ Add OAuth app",
  ]) {
    assert.ok(html.includes(action), `missing ${action}`);
  }
  assert.match(html, /button\.onclick = \(\) => setView\(button\.dataset\.viewlink\)/);
  assert.match(html, /id="model-custom-provider-rows"/);
  assert.match(html, /provider\.models\.length/);
  assert.match(html, /function renderBuiltInConnectors\(\)/);
  assert.match(html, /function loadPersonalKeychainSummary\(\)/);
  assert.doesNotMatch(html, /Enabled harnesses/);
  assert.doesNotMatch(html, /id="card-browsing"/);
  assert.doesNotMatch(html, /\$\("feature-flag-enable"\)\.disabled = true/);
});

test("enabled models uses the runtime default and an explicit add interaction", () => {
  assert.doesNotMatch(html, /id="webui-models-default"/);
  assert.match(html, /id="webui-models-add">\s*<option value="">Choose a model…<\/option>/);
  assert.match(html, /id="webui-models-add-button" disabled>\+ Add model<\/button>/);
  assert.match(html, /className = "model-chip"/);
  assert.match(html, /updateSectionDirty\("webui-models"\)/);
  assert.match(html, /"webui-models": \(\) => \(\{ ids: webuiModelIds \}\)/);
});

test("custom providers share one in-place editor instead of linking to onboarding", () => {
  assert.match(html, /id="custom-provider-dialog"/);
  assert.match(html, /class="project-dialog-head"/);
  assert.match(html, /class="project-dialog-actions"/);
  assert.match(html, /id="custom-provider-close" aria-label="Close"/);
  assert.match(html, /dialog\.custom-provider-dialog[\s\S]*padding: 20px;[\s\S]*border-radius: 10px;/);
  assert.match(html, /\$\("add-custom-provider"\)\.onclick = \(\) => openCustomProviderEditor\(\)/);
  assert.match(html, /\$\("onboarding-add-custom-provider"\)\.onclick = \(\) => openCustomProviderEditor\(\)/);
  assert.match(html, /edit\.onclick = \(\) => openCustomProviderEditor\(provider\)/);
  assert.match(html, /actions\.append\(edit, customProviderRemoveButton\(provider\)\)/);
  assert.match(html, /if \(view === "models"\) await loadScope\(\)/);
  assert.doesNotMatch(html, /\$\("add-custom-provider"\)\.onclick = \(\) => \{[\s\S]*?setView\("onboarding"\)/);
});

test("all admin data views receive the shared flat cards and custom dropdowns", () => {
  assert.match(html, /#view-data section\.card,[\s\S]*#view-connectors section\.card[\s\S]*box-shadow: none/);
  assert.match(html, /\.admin-app select\[data-dd-host\]/);
  assert.match(html, /initCustomDropdowns\(\$\("app-view"\)\)/);
  assert.match(html, /btn\.setAttribute\("aria-controls", menu\.id\)/);
  assert.match(
    html,
    /btn\.setAttribute\("aria-label", label \? label \+ ": " \+ lab\.textContent : lab\.textContent\)/,
  );
  assert.match(html, /btn\.setAttribute\("aria-activedescendant", it\.id\)/);
  assert.match(html, /\.observe\(\$\("app-view"\), \{ childList: true, subtree: true \}\)/);
});

test("grouped parity cards keep each setting bound to its own save action", () => {
  assert.match(html, /card\.dataset\.saveScope = save\.dataset\.save/);
  assert.match(html, /const subsection = target\.closest\("\[data-save-scope\]"\)/);
});

test("admin follows the main UI theme preference", () => {
  assert.match(html, /localStorage\.getItem\("theme"\)/);
  assert.match(html, /--warn-surface: oklch\(0\.25 0\.035 85\)/);
  assert.match(html, /background: var\(--warn-surface\)/);
  assert.match(html, /window\.matchMedia\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(html, /document\.documentElement\.classList\.toggle\("dark", dark\)/);
  assert.match(html, /:root\.dark\s*\{/);
  assert.match(html, /input:not\(\[type\]\)/);
});

test("governance follows the neutral web UI interaction palette", () => {
  assert.doesNotMatch(html, /--accent:\s*#f26522/);
  assert.match(html, /\.viewlink \{[\s\S]*?color: var\(--muted\)/);
  assert.match(
    html,
    /\.posture-choice:has\(input:checked\) \{\s*border-color: var\(--border\);\s*background: var\(--subtle\)/,
  );
});

test("Open sharing explains the benefit and privacy risk in plain language", () => {
  const card = html.slice(html.indexOf('id="card-sharing-posture"'), html.indexOf('id="card-egress"'));
  assert.match(
    card,
    /QM can use your saved memories, files, and skills across conversations when you ask it for\s+help/,
  );
  assert.match(card, /In a group conversation, this could risk revealing private information to\s+others/);
  assert.doesNotMatch(card, /live internal speaker|entitled resources|opted-in contexts/);
});
