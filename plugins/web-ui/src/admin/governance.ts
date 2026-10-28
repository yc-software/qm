import { cardClass, closeIcon, choiceGroup, saveButton, settingStatus } from "./setting-controls.ts";
import { html, type TemplateResult } from "lit";
import { mountTemplate } from "./shared.ts";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { states, patternError, type GovernanceState } from "./governance-state.ts";
export { collect, capture, commit, status, statusKey, load, updateCatalog, states } from "./governance-state.ts";

const cards: Record<string, (s: GovernanceState) => TemplateResult> = {
  "card-auto-flagger": (s) =>
    html`<section class=${govClass(s)} id="card-auto-flagger">
      <div class="head">
        <h2>Auto flagger</h2>
        <p>
          Model and prompt the security screen uses to observe external content. The security boundary and required
          verdict format remain fixed.
        </p>
      </div>
      <div class="body">
        <div class="screening-details">
          <div class="governance-field-grid">
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
        </div>
      </div>
      <div class="foot">
        <button id="auto-flagger-reset" type="button">Restore default</button>
        ${saveButton(s, "Apply", s.disabled)} ${settingStatus(s)}
      </div>
    </section>`,
  "card-command-policy": (s) =>
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
      <div class="foot">${saveButton(s, "Save", s.disabled)}${settingStatus(s)}</div>
    </section>`,
  "card-ambient-policy": (s) =>
    html`<section class=${govClass(s)} id="card-ambient-policy">
      <div class="head">
        <h2>Ambient reply policy</h2>
        <p>
          When the agent wakes on overheard messages in this channel. The ambient judge weighs each batch of new
          messages against the channel's instructions (edit them under Instructions); with none set it stays silent
          unless addressed. The bot ledger says how each automated poster is treated: <b>ignore</b> never wakes the
          judge, <b>rollup</b> batches its posts (judged at most once per the given hours), <b>action</b> marks its
          posts as triggers to act on, <b>user</b> reads it like a person.
        </p>
      </div>
      <div class="body">
        <label for="ambient-enabled">Ambient behavior</label>
        <p class="hint" style="margin: 2px 0 6px">
          When off, the agent never wakes on overheard messages in this channel; it only responds to direct @mentions.
          Default: on only when the channel has instructions (or an action-mode bot is set below), otherwise
          mention-only.
        </p>
        <select
          id="ambient-enabled"
          style="margin-bottom: 14px"
          .value=${s.draft.ambientEnabled == null ? "default" : String(s.draft.ambientEnabled ? "on" : "off")}
          @change=${(event: Event) => changeField(s, "ambient-enabled", event)}
        >
          <option value="default">Default (on when instructions are set)</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
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
  "card-egress": (s) =>
    html`<section class=${govClass(s)} id="card-egress">
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
  "card-org-ambient": (s) =>
    html`<section class=${govClass(s)} id="card-org-ambient">
      <div class="head">
        <h2>Ambient reply policy</h2>
        <p>@-mentions are always answered. Each ambient decision is recorded in the judgments log.</p>
        <button type="button" class="viewlink" data-viewlink="judgments">View judgment log ›</button>
      </div>
      <div class="body">
        ${choiceGroup(
          {
            name: "ambient-reply-choice",
            value: ({ true: "on", false: "off" } as Record<string, string>)[String(s.draft.on)] || "",
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
        >${settingStatus(s)}
      </div>
    </section>`,
};

export function mountCards(): void {
  for (const [id, template] of Object.entries(cards)) {
    const state = states.get(id.slice(5))!;
    state.render = mountTemplate(`template[data-governance-card="${id}"]`, () => template(state));
  }
}
const govClass = (s: GovernanceState, row = false) =>
  cardClass(s, "sv-governance", { "setting-row": row, "egress-disabled": s.disabled });

function changeField(s: GovernanceState, id: string, event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  let value: unknown = input.type === "checkbox" ? input.checked : input.value;
  if (id === "governance-org-ambient") value = value === "on";
  if (id === "ambient-enabled") value = value === "default" ? null : value === "on";
  s.change(id, value);
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
      ${closeIcon(14)}
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
