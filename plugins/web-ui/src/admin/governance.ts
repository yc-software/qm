import { cardClass, choiceGroup, saveButton, settingStatus, saveFooter, reviewChange } from "./setting-controls.ts";
import { html, nothing, render, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { states, load, patternError, type GovernanceState } from "./governance-state.ts";
import { putSetting } from "./setting-state.ts";
import { pageHeader } from "./shared.ts";
import type { AdminPage } from "./sections.ts";

const cards: Record<string, (s: GovernanceState) => TemplateResult> = {
  "security-posture": (s) =>
    html`<section class=${govClass(s, true)} id="card-security-posture">
      <div class="head">
        <h2>Security posture</h2>
        <p>Choose how the agent screens external content and when it requires your approval.</p>
      </div>
      <div class="body">
        ${choiceGroup(
          {
            name: "security-posture-choice",
            value: s.draft.posture,
            choiceFor: "security-posture",
            onChange: (event: Event) => changeField(s, "security-posture", event),
          },
          [
            [
              "auto",
              "Auto",
              "Default. Blocks private-network access. Screens external content when the deployment configures a screener; model screening is off by default.",
            ],
            ["dangerous", "Dangerous", "No posture-based screening; deployment-required screening still applies."],
            ["strict", "Strict", "Every tool action requires human approval."],
          ],
        )}
      </div>
      ${saveFooter(s, "Apply", s.disabled)}
    </section>`,
  "command-policy": (s) =>
    html`<section class=${govClass(s)} id="card-command-policy">
      <div class="head">
        <h2>Command policy</h2>
      </div>
      <div class="body">
        <div class="policy-rules" id="rules">
          ${repeat(
            s.rules,
            (r) => r.id,
            (r, index) => ruleTemplate(s, r, index),
          )}
        </div>
        <p class=${classMap({ hint: true, "rules-empty": true, hidden: s.rules.length > 0 })} id="rules-empty">
          No command rules yet.
        </p>
        <div class="policy-actions">
          <button class="btn" id="add-rule" type="button" @click=${() => addRule(s)}>+ Add rule</button>
          <button
            id="policy-more"
            type="button"
            class=${classMap({ btn: true, hidden: s.expanded || s.rules.length <= 3 })}
            @click=${() => {
              s.expanded = true;
              s.render();
            }}
          >
            Show ${s.rules.length - 3} more ${s.rules.length === 4 ? "rule" : "rules"}
          </button>
          <button class="btn" id="policy-test-open" type="button" @click=${openTester}>Test a command…</button>
        </div>
        <div class="policy-warnings" id="policy-warnings" aria-live="polite">
          ${s.warnings.map((warning) => html`<div>${warning}</div>`)}
        </div>
      </div>
      <div class="foot">${saveButton(s, "Save", s.disabled)}${settingStatus(s, "st-policy")}</div>
    </section>`,
  "ambient-policy": (s) =>
    html`<section class=${govClass(s)} id="card-ambient-policy">
      <div class="head">
        <h2>Ambient reply policy</h2>
        <p>
          What the agent proactively acts on in this channel. The standing order is plain prose the ambient judge weighs
          each batch of new messages against. Empty means it stays silent unless addressed. The bot ledger says how each
          automated poster is treated: <b>ignore</b> never wakes the judge, <b>rollup</b> batches its posts (judged at
          most once per the given hours), <b>action</b> marks its posts as triggers to act on, <b>user</b> reads it like
          a person.
        </p>
        ${viewLink("judgments", "View judgment log ›")}
      </div>
      <div class="body">
        <label for="ambient-enabled">Ambient behavior</label>
        <p class="hint" style="margin: 2px 0 6px">
          When off, the agent never wakes on overheard messages in this channel; it only responds to direct @mentions.
          Default: on for channels with 8 or fewer members, off for larger ones.
        </p>
        <select
          id="ambient-enabled"
          style="margin-bottom: 14px"
          .value=${s.draft.ambientEnabled == null ? "default" : String(s.draft.ambientEnabled ? "on" : "off")}
          @change=${(event: Event) => changeField(s, "ambient-enabled", event)}
        >
          <option value="default">Default (by channel size)</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
        <label for="ambient-orders">Standing order</label>
        <textarea
          id="ambient-orders"
          placeholder="(none, the agent stays silent here unless addressed)"
          .value=${s.value("ambient-orders")}
          @input=${(event: Event) => changeField(s, "ambient-orders", event)}
        ></textarea>
        <div class="tablewrap" style="margin-top: 14px">
          <table class="rules">
            <thead>
              <tr>
                <th style="width: 34%">Bot (author name)</th>
                <th style="width: 30%">Handling</th>
                <th>Rollup hours</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="ambient-bots">
              ${repeat(
                s.bots,
                (b) => b.id,
                (b) => botTemplate(s, b),
              )}
            </tbody>
          </table>
        </div>
        <p class=${classMap({ hint: true, "rules-empty": true, hidden: s.bots.length > 0 })} id="ambient-bots-empty">
          No bots in the ledger yet.
        </p>
        <button class="btn" id="add-bot" type="button" @click=${() => addBot(s)} style="margin-top: 10px">
          + Add bot
        </button>
      </div>
      <div class="foot">${saveButton(s, "Save", s.disabled)}${settingStatus(s)}</div>
    </section>`,
  "sharing-posture": (s) =>
    html`<section class=${govClass(s, true)} id="card-sharing-posture">
      <div class="head">
        <h2>Sharing posture</h2>
        <p>The organization is a ceiling. Personal and room scopes can opt out, and Isolated always wins.</p>
      </div>
      <div class="body">
        <p id="sharing-posture-effective">${sharingLabel(s)}</p>
        ${choiceGroup(
          {
            name: "sharing-posture-choice",
            value: s.draft.posture,
            choiceFor: "sharing-posture",
            onChange: (event: Event) => changeField(s, "sharing-posture", event),
          },
          [
            ["isolated", "Isolated", "Resources stay in their own scope unless explicitly shared."],
            [
              "open",
              "Open",
              "QM can use your saved memories, files, and skills across conversations when you ask it for help. In a group conversation, this could risk revealing private information to others.",
            ],
          ],
        )}
      </div>
      <div class="foot">
        ${saveButton(s, "Apply", s.disabled)}
        <button
          class="btn"
          type="button"
          id="sharing-posture-inherit"
          @click=${inheritSharing}
          ?hidden=${s.scope.startsWith("org:") || s.context.sharingPostureOverride == null}
        >
          Follow organization
        </button>
        ${settingStatus(s)}
      </div>
    </section>`,
  egress: (s) =>
    html`<section class=${govClass(s)} id="card-egress">
      <div class="head">
        <h2>Egress policy</h2>
        ${viewLink("egress", "View logs ›")}
      </div>
      <div class="body">
        <div
          class=${classMap({ "governance-capability": true, "admin-notice": true, "admin-notice--warning": true, hidden: !s.disabled })}
          id="egress-capability"
          role="status"
        >
          <div>
            <strong
              >${s.context.egressEnforcement?.reason === "control_plane_unconfigured" ? "Enforcement is not activated" : "Agent computer egress policy unavailable"}</strong
            ><span>${egressExplanation(s)}</span>
          </div>
        </div>
        <div class="egress-empty-state">
          <span class=${classMap({ hint: true, hidden: s.allowEditor || s.denyEditor })} id="egress-empty"
            >No egress rules.</span
          >
          <div class="egress-actions">
            <button
              type="button"
              id="egress-add-deny"
              ?disabled=${s.disabled}
              class=${classMap({ btn: true, hidden: s.denyEditor })}
              @click=${() => {
                s.denyEditor = true;
                s.render();
              }}
            >
              + Denylist
            </button>
            <button
              type="button"
              id="egress-add-allow"
              ?disabled=${s.disabled}
              class=${classMap({ btn: true, hidden: s.allowEditor })}
              @click=${() => {
                s.allowEditor = true;
                s.render();
              }}
            >
              + Allowlist
            </button>
          </div>
        </div>
        <div class=${classMap({ "egress-editor": true, hidden: !s.denyEditor })} id="egress-deny-editor">
          <label for="egress-deny">Denylist: hosts the agent may never reach</label>
          <textarea
            id="egress-deny"
            placeholder="ads.example.com&#10;pastebin.com"
            .value=${s.value("egress-deny")}
            @input=${(event: Event) => changeField(s, "egress-deny", event)}
            ?disabled=${s.disabled}
          ></textarea>
        </div>
        <div class=${classMap({ "egress-editor": true, hidden: !s.allowEditor })} id="egress-allow-editor">
          <label for="egress">Allowlist: when present, only these outbound hosts may be reached</label>
          <textarea
            id="egress"
            placeholder="example.com&#10;api.internal"
            .value=${s.value("egress")}
            @input=${(event: Event) => changeField(s, "egress", event)}
            ?disabled=${s.disabled}
          ></textarea>
        </div>
        <div class="policy-warnings" id="egress-warnings" aria-live="polite">
          ${s.warnings.map((warning) => html`<div>${warning}</div>`)}
        </div>
      </div>
      <div class="foot">${saveButton(s, "Save policy", s.disabled)}${settingStatus(s)}</div>
    </section>`,
  "org-ambient": (s) =>
    html`<section class=${govClass(s)} id="card-governance-org-ambient">
      <div class="head">
        <h2>Ambient reply policy</h2>
        <p>@-mentions are always answered. Each ambient decision is recorded in the judgments log.</p>
        ${viewLink("judgments", "View judgment log ›")}
      </div>
      <div class="body">
        ${choiceGroup(
          {
            name: "ambient-reply-choice",
            value: ({ true: "on", false: "off" } as Record<string, string>)[String(s.draft.on)] || "",
            choiceFor: "governance-org-ambient",
            onChange: (event: Event) => changeField(s, "governance-org-ambient", event),
          },
          [
            ["on", "Reply when useful", "Agent judges all messages and replies when useful"],
            ["off", "Only when mentioned", "Agent does not read messages or reply unless @-mentioned"],
          ],
        )}
      </div>
      ${saveFooter(s)}
    </section>`,
};

function govClass(s: GovernanceState, row = false) {
  return cardClass(s, "sv-governance", {
    "setting-row": row,
    "egress-disabled": s.disabled,
    "flat-first": shown()[0] === s.key,
    "flat-last": shown().at(-1) === s.key,
  });
}

function changeField(s: GovernanceState, id: string, event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  let value: unknown = input.type === "checkbox" ? input.checked : input.value;
  if (id === "governance-org-ambient") value = value === "on";
  if (id === "ambient-enabled") value = value === "default" ? null : value === "on";
  s.change(id, value);
}
function sharingLabel(s: GovernanceState): string {
  const inherited = s.scope.startsWith("org:") ? "Default" : "Following organization";
  return (
    (s.context.sharingPostureOverride == null
      ? inherited
      : "Configured: " + titleCase(s.context.sharingPostureOverride)) +
    " · Effective: " +
    titleCase(s.context.sharingPosture || "isolated")
  );
}
let rowId = 0;
function addRule(s: GovernanceState) {
  s.rules.unshift({ id: --rowId, pattern: "", decision: "deny", reason: "" });
  s.expanded = true;
  s.changed();
  document.querySelector<HTMLInputElement>("#rules .policy-pattern")?.focus();
}
function addBot(s: GovernanceState) {
  s.bots.push({ id: --rowId, name: "", mode: "ignore", hours: "" });
  s.changed();
  document.querySelector<HTMLInputElement>("#ambient-bots tr:last-child input")?.focus();
}
function ruleTemplate(s: GovernanceState, r: GovernanceState["rules"][number], index: number) {
  const change = (key: "pattern" | "decision" | "reason", event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    r[key] = input.value;
    if (key === "pattern") input.setCustomValidity(patternError(r.pattern));
    s.changed();
  };
  return html`<div class=${classMap({ "policy-rule": true, hidden: !s.expanded && index >= 3 })}>
    <select class=${"policy-effect effect-control effect-" + r.decision} @change=${(e: Event) => change("decision", e)}>
      ${[
        ["allow", "Allow"],
        ["deny", "Deny"],
        ["require_approval", "Require approval"],
      ].map(([value, label]) => html`<option value=${value} ?selected=${value === r.decision}>${label}</option>`)}
    </select>
    <input
      class="policy-pattern"
      type="text"
      .value=${r.pattern}
      placeholder="regex"
      spellcheck="false"
      aria-label="Command pattern"
      aria-invalid=${String(!!patternError(r.pattern))}
      @input=${(e: Event) => change("pattern", e)}
    />
    <input
      class="policy-reason"
      type="text"
      .value=${r.reason}
      placeholder="Reason (optional)"
      @input=${(e: Event) => change("reason", e)}
    />
    <button
      type="button"
      class="btn compact rowbtn danger"
      title="Remove this command policy rule"
      aria-label="Remove command policy rule"
      @click=${() => {
        s.rules = s.rules.filter((rule) => rule !== r);
        s.changed();
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="m4 4 8 8M12 4l-8 8" />
      </svg>
    </button>
  </div>`;
}
function botTemplate(s: GovernanceState, b: GovernanceState["bots"][number]) {
  const change = (key: "name" | "mode" | "hours", e: Event) => {
    b[key] = (e.currentTarget as HTMLInputElement).value;
    s.changed();
  };
  return html`<tr>
    <td>
      <input
        type="text"
        .value=${b.name}
        placeholder="e.g. GitHub"
        spellcheck="false"
        @input=${(e: Event) => change("name", e)}
      />
    </td>
    <td>
      <select @change=${(e: Event) => change("mode", e)}>
        ${[
          ["ignore", "ignore (never wakes the judge)"],
          ["rollup", "rollup (batch, judge periodically)"],
          ["action", "action (posts are triggers)"],
          ["user", "user (read like a person)"],
        ].map(([value, label]) => html`<option value=${value} ?selected=${b.mode === value}>${label}</option>`)}
      </select>
    </td>
    <td>
      <input
        type="number"
        min="1"
        step="1"
        placeholder="24"
        .value=${b.hours}
        ?disabled=${b.mode !== "rollup"}
        @input=${(e: Event) => change("hours", e)}
      />
    </td>
    <td class="rule-action">
      <button
        type="button"
        class="btn compact rowbtn danger"
        title="Remove this bot from the ledger"
        aria-label="Remove bot ledger entry"
        @click=${() => {
          s.bots = s.bots.filter((bot) => bot !== b);
          s.changed();
        }}
      >
        Remove
      </button>
    </td>
  </tr>`;
}

function egressExplanation(s: GovernanceState) {
  const enforcement = s.context.egressEnforcement || { backend: "unknown" };
  if (enforcement.reason === "control_plane_unconfigured")
    return "Egress enforcement has not been activated for agent computers.";
  const backend = String(enforcement.backend).replace(/(^|[-_ ])\w/g, (value) =>
    value.replace(/[-_]/, " ").toUpperCase(),
  );
  return (
    "Agent computers use " +
    backend +
    ", which cannot enforce host restrictions on all outbound traffic. A configured egress proxy still applies policy to traffic sent through it."
  );
}

const titleCase = (value: string) => value[0]!.toUpperCase() + value.slice(1);
const EFFECT_LABELS: Record<string, string> = { allow: "Allow", deny: "Deny", require_approval: "Require approval" };
const ORDER = ["security-posture", "sharing-posture", "org-ambient", "ambient-policy", "command-policy", "egress"];
const shown = () => ORDER.filter((key) => states.get(key)!.available);

let page: AdminPage;
let data: Record<string, any> | null = null;
let loadedScope = "";
let failure = "";
let generation = 0;
let policyPresent = false;
let labels: Record<string, string> | null = null;
const tester = { sample: "", result: "Enter a sample command to test the scope policy.", tone: "", busy: false };

const scopePath = (scope: string) => "/api/scopes/" + encodeURIComponent(scope);
const orgScope = () => page.scope.startsWith("org:");
const stale = (scope: string, token: number) => page.scope !== scope || generation !== token || !page.host.isConnected;
const viewLink = (view: string, label: string) =>
  html`<a class="viewlink" href=${page.href(view, { scope: orgScope() || view === "judgments" ? null : page.scope })}
    >${label}</a
  >`;

function scopeName(scope = page.scope) {
  const [kind, ...rest] = scope.split(":");
  const id = rest.join(":");
  if (kind === "org") return "Organization · " + id;
  if (labels?.[scope]) return labels[scope]!;
  if (kind === "channel" || kind === "group") return id.startsWith("#") ? id : "#" + id;
  if (kind === "personal") return id.split("@")[0]!.replace(/^[a-z]/, (c) => c.toUpperCase());
  return id || scope;
}

function draw() {
  if (!page?.host.isConnected) return;
  render(view(), page.host);
}

function view() {
  const ready = data && loadedScope === page.scope;
  return html`<div id="view-governance">
    ${pageHeader(
      orgScope() ? {} : { back: { label: "Governance", href: page.href("governance") }, title: scopeName() },
    )}
    ${
      ready
        ? html`${environmentNotice(data!)}
            <div class="governance-content">${shown().map((key) => cards[key]!(states.get(key)!))}</div>
            ${testerDialog()}`
        : html`<p id="governance-loading" class="hint" role="status">${failure || "Loading settings…"}</p>`
    }
  </div>`;
}

function environmentNotice(d: Record<string, any>) {
  const attachment = d.environmentAttachment;
  if (!attachment) return nothing;
  const name = attachment.environmentName || scopeName(attachment.environmentId);
  return html`<aside class="environment-notice admin-notice" id="environment-notice" role="status">
    <div>
      <strong>Uses named environment ${name}</strong>
      <p>
        Computer files and working memory resolve to this environment. Governance and conversation history remain scoped
        here.
      </p>
    </div>
    <a class="btn" href=${page.href("governance", { scope: attachment.environmentId })}>Open ${name}</a>
  </aside>`;
}

function testerDialog() {
  return html`<dialog
    class="review-dialog policy-test-dialog"
    id="policy-test-dialog"
    aria-labelledby="policy-test-title"
  >
    <div class="review-dialog-head">
      <h2 id="policy-test-title">Test a command</h2>
    </div>
    <div class="review-dialog-body">
      <label for="policy-sample"
        >Command<input
          type="text"
          id="policy-sample"
          placeholder="git push --force origin main"
          autocomplete="off"
          spellcheck="false"
          .value=${tester.sample}
          @input=${(e: Event) => (tester.sample = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            void simulate();
          }}
      /></label>
      <div class="policy-result" id="policy-result" data-tone=${tester.tone} aria-live="polite">${tester.result}</div>
    </div>
    <div class="review-dialog-foot">
      <button
        class="btn"
        type="button"
        id="policy-test-close"
        @click=${() => page.host.querySelector<HTMLDialogElement>("#policy-test-dialog")!.close()}
      >
        Close</button
      ><button
        id="policy-simulate"
        class="btn primary"
        type="button"
        ?disabled=${tester.busy}
        @click=${() => simulate()}
      >
        Test command
      </button>
    </div>
  </dialog>`;
}

function openTester() {
  page.host.querySelector<HTMLDialogElement>("#policy-test-dialog")!.showModal();
  page.host.querySelector<HTMLInputElement>("#policy-sample")!.focus();
}

function say(result: string, tone = "") {
  tester.result = result;
  tester.tone = tone;
  draw();
}

async function simulate() {
  const command = tester.sample;
  if (!command.trim()) return say("Enter a sample command first.");
  const state = states.get("command-policy")!;
  let policy;
  try {
    policy = state.collect();
  } catch (error) {
    return say(error instanceof Error ? error.message : "Policy is invalid.", "danger");
  }
  tester.busy = true;
  say("Evaluating with the server’s command scanner…");
  const body: Record<string, unknown> = { command };
  if (policyPresent || state.dirty) body.policy = policy;
  const r = await page.api("PUT", scopePath(page.scope) + "/command-policy-simulate", body);
  tester.busy = false;
  if (!r.ok) return say(r.data?.message || "Simulation failed.", "danger");
  const { decision, ruleSource, ruleIndex, matched, reason } = r.data;
  const tone = ({ allow: "ok", deny: "danger" } as Record<string, string>)[decision] || "warn";
  const effect = (EFFECT_LABELS[decision] || decision) + (reason ? " · " + reason : "");
  const rule =
    ({ organization: "Organization rule ", scope: "This scope’s rule " } as Record<string, string>)[ruleSource] ?? null;
  say(
    rule
      ? rule + (ruleIndex + 1) + " matches" + (matched ? " “" + matched + "”" : "") + " → " + effect
      : "No scope-policy rule matches → " + effect,
    tone,
  );
}

function review(key: string, body: Record<string, any>) {
  if (!key.endsWith("-posture")) return Promise.resolve(true);
  const before = JSON.parse(states.get(key)!.baseline).posture;
  const facts: [string, string][] = [
    ["Scope", scopeName()],
    ["Current", titleCase(before)],
    ["Proposed", titleCase(body.posture)],
  ];
  if (key === "security-posture") {
    const dangerous = body.posture === "dangerous";
    return reviewChange({
      title: dangerous ? "Enable Dangerous autonomy?" : "Change security posture?",
      subtitle: "Review the immutable change below before it is applied.",
      facts,
      warning: dangerous
        ? "Dangerous disables posture-based content screening and tool approval gates. Deployment-required screening still applies. Predeclared command approvals, hard denials, identity, authorization, credential scope, revocation, and audit remain enforced."
        : "This changes the effective tools and approval behavior for future turns in this scope.",
      confirmLabel: dangerous ? "Enable Dangerous" : "Apply posture",
      danger: dangerous,
    });
  }
  if (key === "sharing-posture") {
    const open = body.posture === "open";
    return reviewChange({
      title: open ? "Enable Open sharing?" : "Return to Isolated sharing?",
      subtitle: "This applies to future live human turns in the selected scope.",
      facts,
      warning: open
        ? "Open can reveal a speaker's private information in shared replies. It does not carry credentials, history, writes, automation, or another person's resources. Organization, personal, and room policy must all allow it."
        : "Cross-context resources will again require explicit shares or grants.",
      confirmLabel: open ? "Enable Open" : "Use Isolated",
      danger: open,
    });
  }
  return Promise.resolve(true);
}

function guard(scope: string, token: number) {
  return { api: page.api, current: () => !stale(scope, token) };
}

async function save(key: string) {
  const state = states.get(key)!;
  const scope = page.scope;
  const token = generation;
  let body;
  try {
    body = state.collect();
  } catch (error) {
    state.message = error instanceof Error ? error.message : "Could not save.";
    state.tone = "err";
    return draw();
  }
  if (!(await review(key, body)) || stale(scope, token)) return;
  const r = await putSetting(guard(scope, token), scope, state, key, body);
  if (!r?.ok) return;
  state.commit(body);
  if (key === "command-policy") policyPresent = true;
  if (["security-posture", "sharing-posture", "ambient-policy"].includes(key)) await refresh(key, scope, token);
}

async function refresh(key: string, scope: string, token: number) {
  const state = states.get(key)!;
  const fresh = await page.api("GET", scopePath(scope) + "?view=governance");
  if (stale(scope, token) || state.dirty) return;
  if (!fresh.ok) {
    state.message = "Saved, but the current setting could not be refreshed.";
    state.tone = "warn";
    return draw();
  }
  data = fresh.data;
  load(fresh.data, scope, key);
  state.message = "Saved";
  state.tone = "ok";
  draw();
}

async function inheritSharing() {
  const scope = page.scope;
  const token = generation;
  const confirmed = await reviewChange({
    title: "Follow organization sharing?",
    subtitle: "Remove this scope's sharing override.",
    facts: [["Scope", scopeName()]],
    warning:
      "The organization's sharing setting will apply. A personal or room Isolated override still takes precedence.",
    confirmLabel: "Follow organization",
  });
  if (!confirmed || stale(scope, token)) return;
  const r = await page.api("PUT", scopePath(scope) + "/sharing-posture", { inherit: true });
  if (stale(scope, token)) return;
  const state = states.get("sharing-posture")!;
  if (r.ok) return refresh("sharing-posture", scope, token);
  state.message = "Could not reset sharing.";
  state.tone = "err";
  draw();
}

export async function mount(next: AdminPage) {
  page = next;
  for (const [key, state] of states) {
    state.render = draw;
    state.save = () => save(key);
  }
  if (data && loadedScope === page.scope && [...states.values()].some((state) => state.dirty)) return draw();
  const scope = page.scope;
  const token = ++generation;
  if (scope !== loadedScope) failure = "";
  draw();
  if (!orgScope() && !labels)
    void page.api("GET", "/api/scopes").then((r) => {
      if (!r.ok) return;
      labels = Object.fromEntries((r.data.scopes || []).map((row: any) => [row.scopeId, row.label || ""]));
      draw();
    });
  const r = await page.api("GET", scopePath(scope) + "?view=governance");
  if (stale(scope, token)) return;
  if (!r.ok) {
    const message = r.status === 403 ? "You don't administer this scope." : r.data?.message || "Failed to load.";
    if (loadedScope !== scope)
      failure = r.status === 403 ? message : "Could not load settings. Select Governance to retry.";
    else Object.assign(states.get("command-policy")!, { message, tone: "err" });
    return draw();
  }
  data = r.data;
  loadedScope = scope;
  policyPresent = r.data.commandPolicy != null;
  load(r.data, scope);
  draw();
}
