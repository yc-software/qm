import { mountTemplate } from "./shared.ts";
import { saveButton, settingStatus, saveFooter } from "./setting-controls.ts";
import { SettingState, settingRegistry } from "./setting-state.ts";
import { mountCredentials } from "./settings-credentials.ts";
export {
  configureCredentials,
  credentialState,
  credentialStatus,
  credentialLoading,
  loadCredentials,
  keychainSummary,
} from "./settings-credentials.ts";
import { mountProviders } from "./settings-providers.ts";
export { configureProviders, openProvider, loadProviders } from "./settings-providers.ts";
import { mountFlags } from "./settings-flags.ts";
export { configureFlags, loadFlags } from "./settings-flags.ts";
import { brandingCard } from "./settings-branding.ts";
import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";

type Model = { id: string; name?: string; effortLevels?: string[] };
type Data = Record<string, any>;
const runtimeKeys = ["runtime", "cron-runtime", "subagent-runtime"];
const runtimeReadKey = (key: string) => key.replace(/-runtime$/, "Runtime");
export class SettingsState extends SettingState {
  context: Data = {};
  selected = "";
  editing = false;
  history: Data[] = [];
  collect(_validate = true): Data {
    if (_validate && this.key === "soul" && (this.draft.content || "").length > 100000)
      throw new Error("Maximum length reached");
    if (this.key !== "runtime" && runtimeKeys.includes(this.key)) {
      if (this.draft.inherit) return { inherit: true };
      const { inherit: _inherit, ...selection } = this.draft;
      return structuredClone(selection);
    }
    if (this.key === "branding")
      return Object.fromEntries(Object.entries(this.draft).map(([key, value]) => [key, String(value).trim()]));
    return structuredClone(this.draft);
  }
  get models(): Model[] {
    return this.context.modelsByHarness?.[this.draft.harnessId] || this.context.baseModelOptions || [];
  }
  get catalog(): Model[] {
    return [
      ...Object.values(this.context.modelsByHarness || {}).flat(),
      ...(this.context.baseModelOptions || []),
    ].filter((m: any, i, all) => m?.id && all.findIndex((x: any) => x?.id === m.id) === i) as Model[];
  }
  get harnesses(): string[] {
    return this.context.harnessOptions?.length ? this.context.harnessOptions : [this.context.harnessDefault || "pi"];
  }
  get efforts(): string[] {
    const advertised = this.models.find((model) => model.id === this.draft.modelId)?.effortLevels;
    const levels: string[] = advertised ?? this.context.thinkingLevelsByHarness?.[this.draft.harnessId] ?? [];
    return levels.filter((level) => level !== "auto" && (advertised || (level !== "adaptive" && level !== "default")));
  }
  get fastCapable() {
    return (
      (this.context.fastModeHarnessIds || []).includes(this.draft.harnessId) &&
      (this.context.fastModeModelIds || []).includes(this.draft.modelId)
    );
  }
  normalize() {
    if (!runtimeKeys.includes(this.key)) return;
    if (!this.harnesses.includes(this.draft.harnessId)) this.draft.harnessId = this.harnesses[0];
    if (!this.models.some((m) => m.id === this.draft.modelId)) this.draft.modelId = this.models[0]?.id || "";
    if (this.draft.effortLevel !== "auto" && !this.efforts.includes(this.draft.effortLevel)) {
      const rank = effortTiers.indexOf(this.draft.effortLevel);
      const lower = this.efforts.filter(
        (level) => effortTiers.indexOf(level) >= 0 && effortTiers.indexOf(level) <= rank,
      );
      this.draft.effortLevel = rank >= 0 ? (lower.at(-1) ?? "auto") : (this.efforts[0] ?? "auto");
    }
    if (!this.fastCapable) this.draft.fastMode = false;
  }
  change(field: string, value: unknown) {
    this.draft[field] = value;
    this.normalize();
    this.changed();
  }
  changed() {
    this.message = this.dirty ? "Unsaved changes" : "";
    this.tone = "";
    this.render();
  }
  commit(body: Data) {
    this.baseline = JSON.stringify(body);
    this.saving = false;
    this.changed();
  }
  add() {
    if (this.selected && !this.draft.ids.includes(this.selected)) this.draft.ids.push(this.selected);
    this.selected = "";
    this.changed();
  }
  remove(id: string) {
    this.draft.ids = this.draft.ids.filter((x: string) => x !== id);
    this.changed();
  }
}
export const states = new Map(
  [...runtimeKeys, "webui-models", "soul", "branding"].map((key) => [key, new SettingsState(key)]),
);
export const { owns, collect, capture, commit, status, statusKey } = settingRegistry(states);
export function load(data: Data, scope: string, only?: string) {
  for (const [key, s] of states) {
    if (only && only !== key) continue;
    s.context = data;
    if (key === "branding") {
      s.draft = {
        accent: data.branding?.accent || "",
        mark: data.branding?.mark || "",
        selfLabel: data.branding?.selfLabel || "",
        orgName: data.branding?.orgName || "",
        markUrl: data.branding?.markUrl || "",
      };
      s.available = scope.startsWith("org:") && "branding" in data;
      s.saving = false;
      capture(key);
      continue;
    }
    if (key === "soul") {
      s.draft = { content: data.soul || "", expectedVersion: data.soulVersion || 0 };
      s.history = data.soulHistory || [];
      s.editing = false;
      s.available = true;
      s.saving = false;
      capture(key);
      continue;
    }
    s.available =
      scope.startsWith("org:") &&
      !!data.baseModelOptions?.length &&
      (!runtimeKeys.includes(key) || (!!data.baseModelDefault && runtimeReadKey(key) in data));
    const runtime = data[runtimeReadKey(key)];
    s.draft = runtimeKeys.includes(key)
      ? {
          ...(key !== "runtime" ? { inherit: !runtime } : {}),
          harnessId: runtime?.harnessId || data.harnessDefault || "pi",
          modelId: runtime?.modelId || data.baseModel || data.baseModelDefault || "",
          effortLevel: runtime?.effortLevel || "auto",
          fastMode: runtime?.fastMode === true,
        }
      : { ids: (data.webuiModels || []).filter(Boolean) };
    s.normalize();
    s.saving = false;
    s.selected = "";
    capture(key);
  }
}
export function updateCatalog(data: Data) {
  for (const s of states.values()) {
    s.context = { ...s.context, ...data };
    s.render();
  }
}
const harnessLabels: Record<string, string> = {
  pi: "pi (default)",
  opencode: "OpenCode",
  codex: "Codex",
  claude: "Claude Code",
};
const effortTiers = ["low", "medium", "high", "xhigh", "max", "ultra", "ultracode"];
const effortLabels: Record<string, string> = {
  adaptive: "Adaptive",
  default: "Provider default",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
};
const value = (event: Event) => (event.target as HTMLInputElement).value;
const label = (s: SettingsState, id: string) => {
  const m = s.catalog.find((x) => x.id === id);
  return m?.name && m.name !== id ? `${m.name} (${id})` : id;
};
function card(s: SettingsState) {
  if (s.key === "soul") return soulCard(s);
  if (s.key === "branding") return brandingCard(s);
  if (runtimeKeys.includes(s.key)) {
    const prefix = s.key === "runtime" ? "base" : s.key;
    const purpose = s.key !== "runtime";
    const [title, description] = {
      runtime: ["Conversation runtime", "The default runtime for conversations unless overridden."],
      "cron-runtime": ["Cron runtime", "Used for scheduled jobs without a per-job runtime override."],
      "subagent-runtime": ["Sub-agent runtime", "Used for new sub-agents unless explicitly overridden."],
    }[s.key]!;
    return html`<section
      class=${classMap({ card: true, "sv-models": true, hidden: !s.available, dirty: s.dirty })}
      id=${s.key === "runtime" ? "card-base-model" : `card-${s.key}`}
    >
      <div class="head">
        <h2>${title}</h2>
        <p>${description}</p>
      </div>
      <div class="body">
        ${
          purpose
            ? html`<label class="setting-toggle">
                <input
                  type="checkbox"
                  id=${`${prefix}-inherit`}
                  .checked=${!!s.draft.inherit}
                  @change=${(e: Event) => s.change("inherit", (e.target as HTMLInputElement).checked)}
                />
                <span class="setting-switch" aria-hidden="true"></span>
                <span class="setting-copy"
                  ><strong>Use existing fallback</strong
                  ><small
                    >${s.key === "cron-runtime" ? "Use the job's scope default." : "Use the child’s scope default."}</small
                  ></span
                >
              </label>`
            : null
        }
        <div class="model-runtime-fields">
          <div>
            <label for=${`${prefix}-harness`}>Harness</label
            ><select
              id=${`${prefix}-harness`}
              ?disabled=${purpose && s.draft.inherit}
              .value=${s.draft.harnessId || ""}
              @change=${(e: Event) => s.change("harnessId", value(e))}
            >
              ${s.harnesses.map((id) => html`<option value=${id} ?selected=${id === s.draft.harnessId}>${harnessLabels[id] || id}</option>`)}
            </select>
          </div>
          <div>
            <label for=${`${prefix}-model`}>Model</label
            ><select
              id=${`${prefix}-model`}
              ?disabled=${purpose && s.draft.inherit}
              .value=${s.draft.modelId || ""}
              @change=${(e: Event) => s.change("modelId", value(e))}
            >
              ${repeat(
                s.models,
                (m) => m.id,
                (m) => html`<option value=${m.id} ?selected=${m.id === s.draft.modelId}>${m.name} (${m.id})</option>`,
              )}
            </select>
          </div>
          <div>
            <label for=${`${prefix}-effort`}>Reasoning level</label
            ><select
              id=${`${prefix}-effort`}
              ?disabled=${(purpose && s.draft.inherit) || !s.efforts.length}
              .value=${s.draft.effortLevel || "auto"}
              @change=${(e: Event) => s.change("effortLevel", value(e))}
            >
              ${
                (s.draft.effortLevel || "auto") === "auto"
                  ? html`<option value="auto" selected hidden>Not set</option>`
                  : null
              }
              ${repeat(
                s.efforts,
                (id) => id,
                (id) =>
                  html`<option value=${id} ?selected=${id === s.draft.effortLevel}>${effortLabels[id] || id}</option>`,
              )}
            </select>
          </div>
        </div>
        <label class="setting-toggle" id=${`${prefix}-fast-mode-control`} style=${s.fastCapable ? "" : "display: none"}
          ><input
            type="checkbox"
            id=${`${prefix}-fast-mode`}
            .checked=${!!s.draft.fastMode}
            ?disabled=${!s.fastCapable || (purpose && s.draft.inherit)}
            @change=${(e: Event) => s.change("fastMode", (e.target as HTMLInputElement).checked)}
          /><span class="setting-switch" aria-hidden="true"></span
          ><span class="setting-copy"
            ><strong>Fast mode</strong><small>Only available for supported models.</small></span
          ></label
        >
      </div>
      ${saveFooter(s)}
    </section>`;
  }
  const ids: string[] = s.draft.ids || [];
  const available = s.catalog.filter((m) => !ids.includes(m.id));
  return html`<section
    class=${classMap({ card: true, "sv-models": true, hidden: !s.available, dirty: s.dirty })}
    id="card-webui-models"
  >
    <div class="head"><h2>Enabled models</h2></div>
    <div class="body">
      <div class="model-add-row">
        <div class="model-add-field">
          <label for="webui-models-add">Add a model</label
          ><select
            id="webui-models-add"
            .value=${s.selected}
            ?disabled=${!available.length}
            @change=${(e: Event) => {
              s.selected = value(e);
              s.render();
            }}
          >
            <option value="">Choose a model…</option>
            ${available.map((m) => html`<option value=${m.id}>${label(s, m.id)}</option>`)}
          </select>
        </div>
        <button type="button" id="webui-models-add-button" ?disabled=${!s.selected} @click=${() => s.add()}>
          + Add model
        </button>
      </div>
      <div id="webui-models-list" class="model-list">
        <p id="webui-models-empty" class=${classMap({ hint: true, hidden: !!ids.length })}>
          No additional models enabled.
        </p>
        ${repeat(
          ids,
          (id) => id,
          (id) =>
            html`<span data-chip=${id} class="model-chip"
              ><span>${label(s, id)}</span
              ><button type="button" aria-label=${"Remove " + id} @click=${() => s.remove(id)}>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg></button
            ></span>`,
        )}
      </div>
    </div>
    ${saveFooter(s)}
  </section>`;
}
export function mountCards() {
  mountFlags();
  mountProviders();
  mountCredentials();
  const renderRuntimes = mountTemplate('template[data-settings-card="card-base-model"]', () =>
    runtimeKeys.map((key) => card(states.get(key)!)),
  );
  for (const [key, s] of states) {
    if (runtimeKeys.includes(key)) {
      s.render = renderRuntimes;
      continue;
    }
    const id = (
      {
        soul: "card-soul",
        branding: "card-branding",
        "webui-models": "card-webui-models",
      } as Record<string, string>
    )[key];
    s.render = mountTemplate(`template[data-settings-card="${id}"]`, () => card(s));
  }
}

let soulActions: { formatTime: (time: any) => string; restore: (revision: Data) => Promise<void> } = {
  formatTime: String,
  restore: async () => {},
};
export function configureSoul(actions: typeof soulActions) {
  soulActions = actions;
}
export function refreshSoul(data: Data) {
  const s = states.get("soul")!;
  s.draft.expectedVersion = data.soulVersion || 0;
  s.baseline = JSON.stringify({ content: data.soul || "", expectedVersion: s.draft.expectedVersion });
  s.history = data.soulHistory || [];
  s.changed();
}
function soulCard(s: SettingsState) {
  const saved = JSON.parse(s.baseline).content || "";
  const content = s.draft.content || "";
  return html`<section
    class=${classMap({ card: true, "sv-customize": true, "is-editing": s.editing, dirty: s.dirty })}
    id="card-soul"
  >
    <div class="head">
      <h2>Organization SOUL</h2>
      <p>
        Write the standing instructions composed into every system prompt for this scope. Saving creates a durable
        revision; restoring an older revision creates a new one.
      </p>
    </div>
    <div class="body soul-preview-body">
      <div class="soul-preview-label" id="soul-preview-label">Standing instructions</div>
      <p class="soul-preview" id="soul-preview" aria-labelledby="soul-preview-label">
        ${saved || "No saved instructions"}
      </p>
    </div>
    <div class="body soul-workbench">
      <label for="soul">Standing instructions</label
      ><textarea
        id="soul"
        maxlength="100000"
        placeholder="No scope-specific instructions"
        .value=${content}
        @input=${(e: Event) => s.change("content", value(e))}
      ></textarea>
      <div class="soul-meta">
        <span id="soul-ver"
          >${s.draft.expectedVersion ? "Saved version " + s.draft.expectedVersion : "No saved revision"}</span
        ><span id="soul-size"
          >${content.length.toLocaleString() + " characters · about " + Math.ceil(content.length / 4).toLocaleString() + " tokens"}</span
        ><span id="soul-validation">${content.length >= 100000 ? "Maximum length reached" : "Draft valid"}</span>
      </div>
      <div class="soul-diff" id="soul-diff">
        <section>
          <h3>Saved revision</h3>
          <pre id="soul-saved">${saved || "No saved instructions"}</pre>
        </section>
        <section>
          <h3>Current draft</h3>
          <pre id="soul-draft">
${content === saved ? "No draft changes" : content || "Instructions will be cleared"}</pre>
        </section>
      </div>
      <div class="soul-history" id="soul-history" aria-label="SOUL version history">
        <h3>Version history</h3>
        ${
          s.history.length
            ? repeat(
                s.history,
                (r) => r.version,
                (r) =>
                  html`<div class="soul-revision">
                    <p>
                      Version ${r.version}<small
                        >${r.updatedBy || "Author unavailable"} ·
                        ${r.updatedAt ? soulActions.formatTime(r.updatedAt) : "Time unavailable"}</small
                      >
                    </p>
                    <button
                      type="button"
                      ?disabled=${r.version === s.draft.expectedVersion || s.saving}
                      @click=${() => soulActions.restore({ ...r })}
                    >
                      ${r.version === s.draft.expectedVersion ? "Current" : "Restore"}
                    </button>
                  </div>`,
              )
            : html`<p class="hint">History begins with the next saved revision.</p>`
        }
      </div>
    </div>
    <div class="foot">
      <button
        type="button"
        class="viewlink"
        id="soul-history-link"
        @click=${() => {
          s.editing = true;
          s.render();
          document.getElementById("soul-history")?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
      >
        View history ›</button
      ><button
        type="button"
        id="soul-edit"
        @click=${() => {
          s.editing = !s.editing;
          if (!s.editing) s.draft.content = saved;
          s.changed();
          if (s.editing) document.getElementById("soul")?.focus();
        }}
      >
        ${s.editing ? "Cancel" : "Edit"}</button
      >${saveButton(s, "Save")}${settingStatus(s)}
    </div>
  </section>`;
}
