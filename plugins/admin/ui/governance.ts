import { choiceGroup, saveButton, settingStatus, saveFooter } from "./setting-controls.ts";
import { html, render, type TemplateResult } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { states, patternError, type GovernanceState } from "./governance-state.ts";
export {
  owns,
  collect,
  capture,
  commit,
  status,
  statusKey,
  load,
  loadResource,
  updateCatalog,
  states,
} from "./governance-state.ts";

const cards: Record<string, (s: GovernanceState) => TemplateResult> = {
  "card-security-posture": (s) =>
    html`<section
      class=${classMap({ card: true, "sv-governance": true, "setting-row": true, hidden: !s.available, dirty: s.dirty, "egress-disabled": s.disabled })}
      id="card-security-posture"
    >
      <div class="head">
        <h2>Security posture</h2>
        <p>Choose how the agent screens external content and when it requires your approval.</p>
      </div>
      <div class="body">
        <select
          id="security-posture"
          data-choice-state
          hidden
          .value=${s.value("security-posture")}
          @change=${(event: Event) => changeField(s, "security-posture", event)}
        >
          <option value="dangerous">Dangerous — no content scans; nothing pauses between tool calls</option>
          <option value="auto">Auto — use the deployment’s configured screener</option>
          <option value="strict">Strict — approve tool actions</option>
        </select>
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
            ["dangerous", "Dangerous", "No content screening."],
            ["strict", "Strict", "Every tool action requires human approval."],
          ],
        )}
      </div>
      ${saveFooter(s, "Apply", s.disabled)}
    </section>`,
  "card-auto-flagger": (s) =>
    html`<section
      class=${classMap({ card: true, "sv-governance": true, hidden: !s.available, dirty: s.dirty, "egress-disabled": s.disabled })}
      id="card-auto-flagger"
    >
      <div class="head">
        <h2>Auto flagger</h2>
        <p>
          Model and prompt used when the deployment explicitly enables model screening in Auto mode. These settings do
          not enable screening. The security boundary and required verdict format remain fixed.
        </p>
      </div>
      <div class="body">
        <div class="screening-details">
          <div class="governance-field-grid">
            <div>
              <label for="auto-flagger-harness">Harness</label>
              <select
                id="auto-flagger-harness"
                .value=${s.value("auto-flagger-harness")}
                @change=${(event: Event) => changeField(s, "auto-flagger-harness", event)}
              >
                ${harnessOptions(s).map((id) => html`<option value=${id} ?selected=${id === s.draft.harnessId}>${({ pi: "Pi", opencode: "OpenCode", codex: "Codex", claude: "Claude Code" } as Record<string, string>)[id] || id}</option>`)}
              </select>
            </div>
            <div>
              <label for="auto-flagger-model">Model</label>
              <select
                id="auto-flagger-model"
                .value=${s.value("auto-flagger-model")}
                @change=${(event: Event) => changeField(s, "auto-flagger-model", event)}
              >
                ${s.models.map((entry) => html`<option value=${entry.id} ?selected=${entry.id === s.draft.modelId}>${entry.name} (${entry.id})</option>`)}
              </select>
            </div>
          </div>
          <div class="governance-prompt">
            <label for="auto-flagger-rubric">Quarantine prompt (classification rubric)</label>
            <textarea
              id="auto-flagger-rubric"
              rows="6"
              maxlength="20000"
              .value=${s.value("auto-flagger-rubric")}
              @input=${(event: Event) => changeField(s, "auto-flagger-rubric", event)}
            ></textarea>
          </div>
          <div class="screening-test-options">
            <h3>Test Auto flagger</h3>
            <p class="screening-test-help">
              Try the model and prompt above on recent screenings without applying changes.
            </p>
            <div class="screening-test-fields">
              <label for="auto-flagger-window">Recent screenings to test</label>
              <div class="screening-count">
                <input
                  id="auto-flagger-window"
                  type="number"
                  inputmode="numeric"
                  min="1"
                  max="500"
                  step="1"
                  value="100"
                  aria-describedby="auto-flagger-window-range"
                />
                <span id="auto-flagger-window-range">1–500</span>
              </div>
              <label
                class="screening-compare"
                title="Also replay the configuration in effect today, so the flag rates are comparable"
              >
                <input type="checkbox" id="auto-flagger-compare" />Compare with the currently applied configuration
              </label>
              <button id="auto-flagger-test" type="button">Run test</button>
            </div>
          </div>
        </div>
      </div>
      <div class="foot">
        <button id="auto-flagger-reset" type="button">Restore default</button>
        ${saveButton(s, "Apply", s.disabled)} ${settingStatus(s)}
      </div>
      <div class="foot" id="auto-flagger-test-result" hidden>
        <span class="status" id="st-auto-flagger-test"></span>
      </div>
    </section>`,
  "card-approval-grant-modes": (s) =>
    html`<section
      class=${classMap({ card: true, "sv-governance": true, "setting-row": true, hidden: !s.available, dirty: s.dirty, "egress-disabled": s.disabled })}
      id="card-approval-grant-modes"
    >
      <div class="head">
        <h2>Approval grant options</h2>
        <p>
          Which standing options an approval card offers besides "Allow once". Composes tighten-only with the org value;
          disabling a mode also suspends existing grants of that mode until it is re-enabled. Predeclared command
          approvals and strict-posture tool approvals both honor this.
        </p>
      </div>
      <div class="body">
        <label
          ><input
            type="checkbox"
            id="approval-grant-session"
            .checked=${s.value("approval-grant-session")}
            @change=${(event: Event) => changeField(s, "approval-grant-session", event)}
          />
          Offer "Allow session" (grant lasts for the conversation)</label
        >
        <label
          ><input
            type="checkbox"
            id="approval-grant-always"
            .checked=${s.value("approval-grant-always")}
            @change=${(event: Event) => changeField(s, "approval-grant-always", event)}
          />
          Offer "Allow always" (standing grant across turns)</label
        >
      </div>
      ${saveFooter(s, "Apply", s.disabled)}
    </section>`,
  "card-command-policy": (s) =>
    html`<section
      class=${classMap({ card: true, "sv-governance": true, hidden: !s.available, dirty: s.dirty, "egress-disabled": s.disabled })}
      id="card-command-policy"
    >
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
          <button id="add-rule" type="button" @click=${() => addRule(s)}>+ Add rule</button>
          <button
            id="policy-more"
            type="button"
            class=${classMap({ hidden: s.expanded || s.rules.length <= 3 })}
            @click=${() => {
              s.expanded = true;
              s.render();
            }}
          >
            Show ${s.rules.length - 3} more ${s.rules.length === 4 ? "rule" : "rules"}
          </button>
          <button id="policy-test-open" type="button">Test a command…</button>
        </div>
        <div class="policy-warnings" id="policy-warnings" aria-live="polite">
          ${s.warnings.map((warning) => html`<div>${warning}</div>`)}
        </div>
      </div>
      <div class="foot">${saveButton(s, "Save", s.disabled)}${settingStatus(s, "st-policy")}</div>
    </section>`,
  "card-ambient-policy": (s) =>
    html`<section
      class=${classMap({ card: true, "sv-governance": true, hidden: !s.available, dirty: s.dirty, "egress-disabled": s.disabled })}
      id="card-ambient-policy"
    >
      <div class="head">
        <h2>Ambient reply policy</h2>
        <p>
          What the agent proactively acts on in this channel. The standing order is plain prose the ambient judge weighs
          each batch of new messages against. Empty means it stays silent unless addressed. The bot ledger says how each
          automated poster is treated: <b>ignore</b> never wakes the judge, <b>rollup</b> batches its posts (judged at
          most once per the given hours), <b>action</b> marks its posts as triggers to act on, <b>user</b> reads it like
          a person.
        </p>
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
        <button id="add-bot" type="button" @click=${() => addBot(s)} style="margin-top: 10px">+ Add bot</button>
      </div>
      <div class="foot">
        <button type="button" class="viewlink" data-viewlink="judgments">View judgment log ›</button
        >${saveButton(s, "Save", s.disabled)}${settingStatus(s)}
      </div>
    </section>`,
  "card-sharing-posture": (s) =>
    html`<section
      class=${classMap({ card: true, "sv-governance": true, "setting-row": true, hidden: !s.available, dirty: s.dirty, "egress-disabled": s.disabled })}
      id="card-sharing-posture"
    >
      <div class="head">
        <h2>Sharing posture</h2>
        <p>The organization is a ceiling. Personal and room scopes can opt out, and Isolated always wins.</p>
      </div>
      <div class="body">
        <p id="sharing-posture-effective">${sharingLabel(s)}</p>
        <select
          id="sharing-posture"
          data-choice-state
          hidden
          .value=${s.value("sharing-posture")}
          @change=${(event: Event) => changeField(s, "sharing-posture", event)}
        >
          <option value="isolated">Isolated</option>
          <option value="open">Open</option>
        </select>
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
          type="button"
          id="sharing-posture-inherit"
          ?hidden=${s.scope.startsWith("org:") || s.context.sharingPostureOverride == null}
        >
          Follow organization
        </button>
        ${settingStatus(s)}
      </div>
    </section>`,
  "card-egress": (s) =>
    html`<section
      class=${classMap({ card: true, "sv-governance": true, hidden: !s.available, dirty: s.dirty, "egress-disabled": s.disabled })}
      id="card-egress"
    >
      <div class="head">
        <h2>Egress policy</h2>
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
              class=${classMap({ hidden: s.denyEditor })}
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
              class=${classMap({ hidden: s.allowEditor })}
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
      <div class="foot">
        <button type="button" class="viewlink" data-viewlink="egress">View logs ›</button
        >${saveButton(s, "Save policy", s.disabled)}${settingStatus(s)}
      </div>
    </section>`,
  "card-governance-org-ambient": (s) =>
    html`<section
      class=${classMap({ card: true, "sv-governance": true, hidden: !s.available, dirty: s.dirty, "egress-disabled": s.disabled })}
      id="card-governance-org-ambient"
    >
      <div class="head">
        <h2>Ambient reply policy</h2>
        <p>@-mentions are always answered. Each ambient decision is recorded in the judgments log.</p>
        <button type="button" class="viewlink" data-viewlink="judgments">View judgment log ›</button>
      </div>
      <div class="body">
        <select
          id="governance-org-ambient"
          data-choice-state
          hidden
          .value=${s.draft.on ? "on" : "off"}
          @change=${(event: Event) => changeField(s, "governance-org-ambient", event)}
        >
          <option value="on">Agent judges all messages and replies when useful</option>
          <option value="off">Agent does not read messages or reply unless @-mentioned</option>
        </select>
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
      <div class="foot">
        <button
          type="button"
          class=${classMap({ primary: true, dirty: s.dirty })}
          id="governance-org-ambient-save"
          data-save="org-ambient"
          ?disabled=${!s.dirty || s.saving}
        >
          Apply</button
        >${settingStatus(s, "st-governance-org-ambient")}
      </div>
    </section>`,
};

export function createCard(id: string): HTMLElement {
  const template = cards[id];
  if (!template) throw new Error(`Unknown governance card: ${id}`);
  const fragment = document.createDocumentFragment();
  const key = id === "card-governance-org-ambient" ? "org-ambient" : id.slice(5);
  const state = states.get(key)!;
  state.render = () => render(template(state), fragment);
  state.render();
  return fragment.firstElementChild as HTMLElement;
}

export function mountCards(): void {
  document.querySelectorAll<HTMLTemplateElement>("template[data-governance-card]").forEach((placeholder) => {
    placeholder.replaceWith(createCard(placeholder.dataset.governanceCard!));
  });
}

function changeField(s: GovernanceState, id: string, event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  let value: unknown = input.type === "checkbox" ? input.checked : input.value;
  if (id === "governance-org-ambient") value = value === "on";
  if (id === "ambient-enabled") value = value === "default" ? null : value === "on";
  s.change(id, value);
}
function harnessOptions(s: GovernanceState): string[] {
  return [...new Set<string>([...(s.context.harnessOptions || []), s.draft.harnessId].filter(Boolean))];
}
function sharingLabel(s: GovernanceState): string {
  const title = (value: string) => value[0].toUpperCase() + value.slice(1);
  const inherited = s.scope.startsWith("org:") ? "Default" : "Following organization";
  return (
    (s.context.sharingPostureOverride == null ? inherited : "Configured: " + title(s.context.sharingPostureOverride)) +
    " · Effective: " +
    title(s.context.sharingPosture || "isolated")
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
      class="rowbtn danger"
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
        class="rowbtn danger"
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
