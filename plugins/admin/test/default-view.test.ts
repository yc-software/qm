import { SettingsState, load as loadSettings, states as settingsStates } from "../ui/settings.ts";
import { CredentialState } from "../ui/settings-credentials.ts";
import { GovernanceState, load, states } from "../ui/governance-state.ts";
import assert from "node:assert/strict";
import { readAdminSource } from "./admin-source.ts";
import test from "node:test";
import vm from "node:vm";

const html = readAdminSource();

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
  assert.match(html, /id="home-link">[\s\S]*?<span>Back to home<\/span>\s*<\/a>/);
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
  const sections = html.match(/const SECTIONS = (\[[\s\S]*?\n {6}\]);/)?.[1];
  assert.ok(sections);
  const actual = JSON.parse(JSON.stringify(vm.runInNewContext(sections)));
  assert.deepEqual(actual, [
    { views: ["governance", "models", "credentials", "connectors", "slack-settings", "customize", "users"] },
    { label: "Logs", views: ["history", "slack", "judgments", "errors", "audit", "egress"] },
    { label: "Artifacts", views: ["files", "skills", "memory", "deployments", "crons"] },
    { views: ["design-system"] },
  ]);
  assert.match(html, /history: "Sessions"/);
  assert.match(
    html,
    /const VIEWS = \[\.\.\.SECTIONS\.flatMap\(\(s\) => s\.views\), "onboarding", "user", "ackemoji", "keychain"\];/,
  );
});

test("deployment management is presented as Apps", () => {
  assert.match(html, /deployments: "Apps"/);
  assert.match(html, /governanceUI\.artifacts\.deployments\(root, d, artifactContext\(\)\)/);
  assert.doesNotMatch(html, /deployments: "Deployments"/);
});

test("admin shell defaults bare admin URLs to org history", () => {
  assert.match(html, /const DEFAULT_VIEW = "history";/);
  assert.match(html, /let view = DEFAULT_VIEW;/);
  assert.match(
    html,
    /let resolvedView = DEFAULT_VIEW;\s*if \(VIEWS\.includes\(v\) && \(v !== "design-system" \|\| permissions\.includes\("inbox"\)\)\) resolvedView = v;\s*else if \(session\) resolvedView = "history";[\s\S]*view: resolvedView/,
  );
});

test("the design system follows the inbox permission", () => {
  assert.match(html, /if \(v === "design-system" && !permissions\.includes\("inbox"\)\) return;/);
  assert.match(html, /permissions = Array\.isArray\(me\.data\.permissions\) \? me\.data\.permissions : \[\];/);
});

test("connector setup uses reactive forms with write-only Slack credentials", () => {
  assert.match(html, /governanceUI.integrations.configure/);
  assert.match(html, /id="conn-client-secret"/);
  assert.match(html, /type="password"/);
  assert.match(html, /id="slack-bot-token"/);
  assert.match(html, /Set up Slack/);
});

test("temporary onboarding covers model credentials, Slack, and OAuth setup", () => {
  assert.match(html, /view-onboarding/);
  assert.match(html, /Model provider/);
  assert.match(html, /OpenRouter/);
  assert.match(html, /governanceUI\.onboarding\.configure/);
  assert.match(html, /return governanceUI\.onboarding\.load\(\)/);
  assert.doesNotMatch(html, /const ONBOARDING_MODELS/);
  assert.match(html, /viewLoadedAt\.onboarding = Date\.now\(\)/);
  assert.match(html, /data-onboarding-target="slack"/);
  assert.match(html, /data-onboarding-target="oauth"/);
});

test("admin shell addresses views by path, not a ?view= query param", () => {
  assert.match(html, /const path = API_BASE \+ "\/" \+ encodeURIComponent\(st\.view \|\| DEFAULT_VIEW\);/);
  assert.doesNotMatch(html, /p\.set\("view", st\.view\)/);
  assert.match(
    html,
    /const raw = p\.get\("setup"\) === "slack" \|\| slackStep \? "slack-settings" : p\.get\("view"\) \|\| fromPath;/,
  );
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

test("transcript visibility controls stay in the sticky header and filter lazy-rendered entries", () => {
  assert.match(html, /id="header-controls" aria-label="Page controls"/);
  assert.match(html, /governanceUI.transcript.show/);
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
  assert.match(html, /governanceUI.commit\(key, body\)/);
  assert.match(html, /governanceUI.load\(fresh.data, requestedScope, key\)/);
  load({ securityPosture: "auto", sharingPosture: "isolated" }, "org:test");
  states.get("sharing-posture")!.change("sharing-posture", "open");
  load({ securityPosture: "strict", sharingPosture: "isolated" }, "org:test", "security-posture");
  assert.equal(states.get("sharing-posture")!.draft.posture, "open");
  assert.equal(states.get("sharing-posture")!.dirty, true);
});

test("ambient reply policy saves directly from Governance without a duplicate control", () => {
  const state = new GovernanceState("org-ambient");
  state.load({ on: true });
  for (const on of [false, true]) {
    state.change("governance-org-ambient", on);
    assert.deepEqual(state.collect(), { on });
  }
  assert.match(html, /id="governance-org-ambient-save"\s+data-save="org-ambient"/);
  assert.doesNotMatch(html, /id="card-org-ambient"|id="org-ambient"/);
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
  assert.match(html, /governanceUI\.createCard\("card-governance-org-ambient"\)/);
  assert.match(html, /id="sc-editor"/);
  assert.match(html, /id="sc-add"[^>]*>\s*\+ Add credential/);
  assert.match(html, /id="conn-editor"/);
  assert.match(html, /id="slack-token-editor"/);
  assert.match(html, /id="soul-preview"/);
  assert.match(html, /body\[data-subview="connectors"\] \.shellbar/);
  assert.match(html, /connectorTip\.className = "connector-dm-tip admin-notice hidden"/);
  assert.doesNotMatch(html, /First match wins/);
  assert.doesNotMatch(html, /direct mutations blocked/);
  assert.doesNotMatch(html, /The org setting is a minimum/);
  assert.doesNotMatch(html, /The runtime inherited by scopes without an override/);
});

test("governance renders simple settings as compact rows with contextual actions", () => {
  for (const id of ["card-security-posture", "card-sharing-posture", "card-external-slack"]) {
    assert.match(html, new RegExp(`<section(?=[^>]*class="[^"]*setting-row)(?=[^>]*id="${id}")`));
  }
  assert.match(html, /class="setting-toggle"/);
  assert.match(html, /data-save="external-slack-participants"/);
});

test("default runtime controls save reasoning level and fast mode", () => {
  for (const id of ["base-effort", "base-fast-mode", "base-fast-mode-control"])
    assert.match(html, new RegExp(`id="${id}"`));
  loadSettings(
    {
      baseModelOptions: [{ id: "a" }],
      baseModelDefault: "a",
      runtime: { harnessId: "pi", modelId: "a", effortLevel: "high", fastMode: true },
      thinkingLevelsByHarness: { pi: ["auto", "high"] },
      fastModeHarnessIds: ["pi"],
      fastModeModelIds: ["a"],
    },
    "org:test",
    "runtime",
  );
  assert.deepEqual(settingsStates.get("runtime")!.collect(), {
    harnessId: "pi",
    modelId: "a",
    effortLevel: "high",
    fastMode: true,
  });
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
  load({ egress: {}, egressEnforcement: { active: false } }, "org:test");
  assert.equal(states.get("egress")!.disabled, true);
  load({ egress: {}, egressEnforcement: { active: true } }, "org:test");
  assert.equal(states.get("egress")!.disabled, false);
});

test("governance keeps effective-state summaries synchronized after focused saves", () => {
  assert.match(html, /governanceUI.load\(fresh.data, requestedScope, key\)/);
  assert.match(html, /btn\.dataset\.saveRequest === saveRequest/);
});

test("stale governance reads cannot overwrite a newer scope", () => {
  assert.match(html, /const requestId = \+\+governanceReq/);
  assert.match(
    html,
    /if \(requestId !== governanceReq \|\| requestedScope !== scope \|\| requestedView !== view\) return;/,
  );
  assert.match(html, /encodeURIComponent\(requestedScope\) \+ "\/" \+ \(isBranding \? "branding" : key\)/);
});

test("egress omits the backend enforcement summary and hides empty editors", () => {
  assert.doesNotMatch(html, /class="egress-state"/);
  const state = new GovernanceState("egress");
  state.load({ allowedHosts: [], deniedHosts: [] });
  assert.equal(state.allowEditor, false);
  assert.equal(state.denyEditor, false);
  state.load({ allowedHosts: ["example.com"], deniedHosts: [] });
  assert.equal(state.allowEditor, true);
  assert.equal(state.denyEditor, false);
});

test("egress validation follows programmatic reloads and successful saves", () => {
  const state = new GovernanceState("egress");
  state.load({ allowedHosts: ["https://invalid"], deniedHosts: [] });
  assert.equal(state.warnings.length, 1);
  state.load({ allowedHosts: ["example.com"], deniedHosts: [] });
  assert.deepEqual(state.warnings, []);
  state.change("egress-deny", "example.com");
  assert.match(state.warnings[0], /both lists/);
});

test("command policy uses compact sentence rows and a modal tester", () => {
  assert.doesNotMatch(html, /id="mode"|class="policy-mode"/);
  assert.match(html, /id="policy-test-dialog"/);
  assert.match(html, /\$\("policy-test-dialog"\)\.showModal\(\)/);
  const state = new GovernanceState("command-policy");
  state.load({ mode: "allowlist", rules: [{ pattern: "^safe$", decision: "allow" }] });
  assert.deepEqual(state.collect(), { mode: "allowlist", rules: [{ pattern: "^safe$", decision: "allow" }] });
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
  assert.match(html, /credentialState.version = scEditVersion/);
  const state = new CredentialState();
  state.begin({ slug: "test", name: "Test", host: "example.com", updatedAt: 42 });
  assert.equal(state.collect().expectedUpdatedAt, 42);
  assert.match(html, /it remains an edit and cannot recreate the credential/);
  assert.match(html, /latest state could not be loaded\. Refresh the page before deleting/);
  assert.match(html, /latest revision could not be loaded\. Your draft is preserved/);
  assert.match(html, /Save failed because the admin service could not be reached/);
  assert.match(
    html,
    /catch \{\s*updateScFormDirty\(\);\s*setStatus\(\s*"st-service-credentials",\s*"Save failed because the admin service could not be reached/,
  );

  assert.match(html, /Recent users in the retained window/);
  assert.doesNotMatch(html, /serviceCredList\.find\(\(c\) => c\.slug === scEditing\)\?\.updatedAt/);

  assert.match(html, /reviewGovernanceChange/);
  assert.doesNotMatch(html, /confirm\("Delete shared credential/);
});

test("governance SOUL workbench shows draft diff, history, and conflict-safe restore", () => {
  assert.match(html, /id="soul-saved"/);
  assert.match(html, /id="soul-draft"/);
  assert.match(html, /id="soul-history"/);
  const state = new SettingsState("soul");
  state.draft = { content: "test", expectedVersion: 4 };
  assert.equal(state.collect().expectedVersion, 4);
  assert.match(html, /function refreshSoulConflict\(\)/);
  assert.match(html, /Restore SOUL version/);
});

test("the hidden utility hides an element whose component rule is declared later", () => {
  assert.match(html, /<aside class="environment-notice admin-notice hidden" id="environment-notice"/);
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
    "Theme",
    "Pinned channel message",
    "Feature flags",
    "Shared service credentials",
    "Personal keychains",
    "Slack",
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
    "Set up Slack",
    "+ Add OAuth app",
  ]) {
    assert.ok(html.includes(action), `missing ${action}`);
  }
  assert.match(html, /button\.onclick = \(\) => setView\(button\.dataset\.viewlink\)/);
  assert.match(html, /id="model-custom-provider-rows"/);
  assert.match(html, /governanceUI.settings.loadProviders/);
  assert.match(html, /governanceUI.integrations/);
  assert.match(html, /function loadPersonalKeychainSummary\(requestId, requestedScope\)/);
  assert.doesNotMatch(html, /Enabled harnesses/);
  assert.doesNotMatch(html, /id="card-browsing"/);
  assert.doesNotMatch(html, /\$\("feature-flag-enable"\)\.disabled = true/);
});

test("enabled models uses the runtime default and an explicit add interaction", () => {
  assert.doesNotMatch(html, /id="webui-models-default"/);
  assert.match(html, /id="webui-models-add"/);
  assert.match(html, /id="webui-models-add-button"/);
  const state = new SettingsState("webui-models");
  state.draft = { ids: [] };
  state.baseline = JSON.stringify(state.draft);
  state.selected = "model-a";
  state.add();
  assert.deepEqual(state.collect(), { ids: ["model-a"] });
  assert.equal(state.dirty, true);
  state.remove("model-a");
  assert.equal(state.dirty, false);
});

test("custom providers share one in-place editor instead of linking to onboarding", () => {
  assert.match(html, /id="custom-provider-dialog"/);
  assert.match(html, /class="project-dialog-head"/);
  assert.match(html, /class="project-dialog-actions"/);
  assert.match(html, /id="custom-provider-close"[^>]*aria-label="Close"/);
  assert.match(html, /dialog\.custom-provider-dialog[\s\S]*padding: 20px;[\s\S]*border-radius: 10px;/);
  assert.match(html, /\$\("add-custom-provider"\)\.onclick = \(\) => openCustomProviderEditor\(\)/);
  assert.match(html, /\$\("onboarding-add-custom-provider"\)\.onclick = \(\) => openCustomProviderEditor\(\)/);
  assert.match(html, /<option value="openai-responses">OpenAI Responses<\/option>/);
  assert.match(html, /governanceUI.settings.configureProviders/);
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
    /\.posture-choice:has\(input:checked\) \{\s*border-color: transparent;\s*background: color-mix\(in srgb, var\(--text\) 4%, transparent\)/,
  );
});

test("Open sharing explains the benefit and privacy risk in plain language", () => {
  const card = html
    .slice(html.indexOf('id="card-sharing-posture"'), html.indexOf('id="card-egress"'))
    .replace(/\s+/g, " ");
  assert.match(
    card,
    /QM can use your saved memories, files, and skills across conversations when you ask it\s+for\s+help/,
  );
  assert.match(card, /In a group conversation, this could risk revealing private\s+information to\s+others/);
  assert.doesNotMatch(card, /live internal speaker|entitled resources|opted-in contexts/);
});
