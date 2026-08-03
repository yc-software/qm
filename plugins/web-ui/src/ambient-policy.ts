import { html, nothing, type TemplateResult } from "lit";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { t } from "./i18n";

export const BOT_MODES = ["ignore", "rollup", "action", "user"] as const;
export type BotMode = (typeof BOT_MODES)[number];
export interface BotPolicyView {
  name: string;
  mode: BotMode;
  rollupHours?: number;
}
interface PolicyWire {
  policy: {
    orders: string;
    bots: Record<string, { mode: BotMode; rollupHours?: number }>;
    ambientEnabled?: boolean | null;
    updatedAt: number;
  };
}

export const ambientPolicyState = {
  scope: null as string | null,
  loading: false,
  orders: "",
  ambientEnabled: null as boolean | null,
  bots: [] as BotPolicyView[],
  baseUpdatedAt: 0,
  dirty: false,
  saving: false,
  notice: "",
  noticeKind: "" as "" | "saved" | "error",
  newBotName: "",
};

let loadSeq = 0;
let redraw: () => void = () => {};

export function ambientPolicyApplies(scopeId: string): boolean {
  return scopeId.startsWith("channel:") || scopeId.startsWith("group:");
}

export function resetAmbientPolicy(): void {
  loadSeq += 1;
  ambientPolicyState.scope = null;
  ambientPolicyState.loading = false;
  ambientPolicyState.orders = "";
  ambientPolicyState.ambientEnabled = null;
  ambientPolicyState.bots = [];
  ambientPolicyState.baseUpdatedAt = 0;
  ambientPolicyState.dirty = false;
  ambientPolicyState.saving = false;
  ambientPolicyState.notice = "";
  ambientPolicyState.noticeKind = "";
  ambientPolicyState.newBotName = "";
}

export async function loadAmbientPolicy(scopeId: string, onChange: () => void): Promise<void> {
  redraw = onChange;
  if (!ambientPolicyApplies(scopeId) || ambientPolicyState.scope === scopeId) return;
  resetAmbientPolicy();
  const seq = ++loadSeq;
  ambientPolicyState.scope = scopeId;
  ambientPolicyState.loading = true;
  try {
    const r = await api<PolicyWire>(`/api/contexts/${encodeURIComponent(scopeId)}/ambient-policy`);
    if (seq !== loadSeq) return;
    ambientPolicyState.orders = r.policy.orders;
    ambientPolicyState.ambientEnabled = r.policy.ambientEnabled ?? null;
    ambientPolicyState.bots = Object.entries(r.policy.bots).map(([name, p]) => ({
      name,
      mode: p.mode,
      ...(p.rollupHours !== undefined ? { rollupHours: p.rollupHours } : {}),
    }));
    ambientPolicyState.baseUpdatedAt = r.policy.updatedAt;
  } catch (e) {
    if (seq !== loadSeq) return;
    ambientPolicyState.notice = errMessage(e, t("ambient.loadFailed"));
    ambientPolicyState.noticeKind = "error";
  } finally {
    if (seq === loadSeq) {
      ambientPolicyState.loading = false;
      redraw();
    }
  }
}

function markDirty(): void {
  ambientPolicyState.dirty = true;
  ambientPolicyState.notice = "";
  ambientPolicyState.noticeKind = "";
  redraw();
}

async function save(): Promise<void> {
  const scope = ambientPolicyState.scope;
  if (!scope || ambientPolicyState.saving) return;
  const bots: Record<string, { mode: BotMode; rollupHours?: number }> = {};
  for (const b of ambientPolicyState.bots) {
    const name = b.name.trim();
    if (!name) continue;
    bots[name] = { mode: b.mode, ...(b.mode === "rollup" && b.rollupHours ? { rollupHours: b.rollupHours } : {}) };
  }
  ambientPolicyState.saving = true;
  redraw();
  try {
    const r = await api<PolicyWire>(`/api/contexts/${encodeURIComponent(scope)}/ambient-policy`, {
      method: "PUT",
      body: JSON.stringify({
        orders: ambientPolicyState.orders,
        bots,
        ambientEnabled: ambientPolicyState.ambientEnabled,
        baseUpdatedAt: ambientPolicyState.baseUpdatedAt,
      }),
    });
    ambientPolicyState.orders = r.policy.orders;
    ambientPolicyState.ambientEnabled = r.policy.ambientEnabled ?? null;
    ambientPolicyState.bots = Object.entries(r.policy.bots).map(([name, p]) => ({
      name,
      mode: p.mode,
      ...(p.rollupHours !== undefined ? { rollupHours: p.rollupHours } : {}),
    }));
    ambientPolicyState.baseUpdatedAt = r.policy.updatedAt;
    ambientPolicyState.dirty = false;
    ambientPolicyState.notice = t("ambient.saved");
    ambientPolicyState.noticeKind = "saved";
  } catch (e) {
    ambientPolicyState.notice = errMessage(e, t("ambient.saveFailed"));
    ambientPolicyState.noticeKind = "error";
  } finally {
    ambientPolicyState.saving = false;
    redraw();
  }
}

function addBot(): void {
  const name = ambientPolicyState.newBotName.trim();
  if (!name) return;
  if (ambientPolicyState.bots.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
    ambientPolicyState.notice = t("ambient.alreadyAdded", { name });
    ambientPolicyState.noticeKind = "error";
    redraw();
    return;
  }
  ambientPolicyState.bots = [...ambientPolicyState.bots, { name, mode: "ignore" }];
  ambientPolicyState.newBotName = "";
  markDirty();
}

function botRow(b: BotPolicyView, i: number): TemplateResult {
  return html`
    <div class="ambient-bot-row">
      <span class="ambient-bot-name">${b.name}</span>
      <select
        class="ambient-bot-mode"
        aria-label=${t("ambient.handling", { name: b.name })}
        ?disabled=${ambientPolicyState.saving}
        @change=${(e: Event) => {
          const mode = (e.currentTarget as HTMLSelectElement).value as BotMode;
          ambientPolicyState.bots = ambientPolicyState.bots.map((x, j) => (j === i ? { ...x, mode } : x));
          markDirty();
        }}
      >
        ${BOT_MODES.map((m) => html`<option value=${m} ?selected=${m === b.mode}>${botModeLabel(m)}</option>`)}
      </select>
      ${
        b.mode === "rollup"
          ? html`<label class="ambient-bot-hours"
              >${t("ambient.batchEvery")}
              <input
                type="number"
                min="1"
                step="1"
                data-focus-key=${`ambient-hours-${i}`}
                aria-label=${t("ambient.batchInterval", { name: b.name })}
                .value=${String(b.rollupHours ?? 24)}
                ?disabled=${ambientPolicyState.saving}
                @input=${(e: InputEvent) => {
                  const v = Number((e.currentTarget as HTMLInputElement).value);
                  ambientPolicyState.bots = ambientPolicyState.bots.map((x, j) =>
                    j === i ? { ...x, rollupHours: Number.isFinite(v) && v > 0 ? v : undefined } : x,
                  );
                  markDirty();
                }}
              />
              ${t("ambient.hours")}</label
            >`
          : nothing
      }
      <button
        class="project-icon-button danger"
        type="button"
        aria-label=${t("ambient.removeBot", { name: b.name })}
        title=${t("ambient.remove")}
        ?disabled=${ambientPolicyState.saving}
        @click=${() => {
          ambientPolicyState.bots = ambientPolicyState.bots.filter((_, j) => j !== i);
          markDirty();
        }}
      >
        ✕
      </button>
    </div>
  `;
}

function botModeLabel(mode: BotMode): string {
  if (mode === "ignore") return t("ambient.mode.ignore");
  if (mode === "rollup") return t("ambient.mode.rollup");
  if (mode === "action") return t("ambient.mode.action");
  return t("ambient.mode.user");
}

export function ambientPolicySection(scopeId: string): TemplateResult | typeof nothing {
  if (!ambientPolicyApplies(scopeId)) return nothing;
  if (ambientPolicyState.scope !== scopeId) return nothing;
  if (ambientPolicyState.loading)
    return html`<section class="context-panel ambient-policy" aria-labelledby="ambient-policy-title">
      <h2 class="context-panel-title" id="ambient-policy-title">${t("ambient.title")}</h2>
      <div class="context-panel-loading">${t("ambient.loading")}</div>
    </section>`;
  return html`
    <section class="context-panel ambient-policy" aria-labelledby="ambient-policy-title">
      <div class="context-panel-heading">
        <div>
          <h2 class="context-panel-title" id="ambient-policy-title">${t("ambient.title")}</h2>
          <p class="context-panel-copy">${t("ambient.choose")}</p>
        </div>
      </div>
      <label class="ambient-field" for="ambient-enabled">
        <span class="ambient-field-label">${t("ambient.behavior")}</span>
        <span class="ambient-policy-hint"
          >${t("ambient.behaviorHint")}</span
        >
      </label>
      <select
        id="ambient-enabled"
        class="ambient-enabled-select"
        data-focus-key="ambient-enabled"
        ?disabled=${ambientPolicyState.saving}
        @change=${(e: Event) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          ambientPolicyState.ambientEnabled = v === "default" ? null : v === "on";
          markDirty();
        }}
      >
        <option value="default" ?selected=${ambientPolicyState.ambientEnabled === null}>
          ${t("ambient.default")}
        </option>
        <option value="on" ?selected=${ambientPolicyState.ambientEnabled === true}>${t("ambient.on")}</option>
        <option value="off" ?selected=${ambientPolicyState.ambientEnabled === false}>${t("ambient.off")}</option>
      </select>
      <label class="ambient-field" for="ambient-orders">
        <span class="ambient-field-label">${t("ambient.standingOrders")}</span>
        <span class="ambient-policy-hint" id="ambient-orders-hint"
          >${t("ambient.ordersHint")}</span
        >
      </label>
      <textarea
        id="ambient-orders"
        data-focus-key="ambient-orders"
        class="ambient-orders"
        rows="4"
        aria-describedby="ambient-orders-hint"
        placeholder=${t("ambient.ordersPlaceholder")}
        .value=${ambientPolicyState.orders}
        ?disabled=${ambientPolicyState.saving}
        @input=${(e: InputEvent) => {
          ambientPolicyState.orders = (e.currentTarget as HTMLTextAreaElement).value;
          markDirty();
        }}
      ></textarea>
      <div class="ambient-field-heading">
        <h3>${t("ambient.posters")}</h3>
        <p class="ambient-policy-hint">${t("ambient.postersHint")}</p>
      </div>
      ${ambientPolicyState.bots.length ? html`<div class="ambient-bot-list">${ambientPolicyState.bots.map((b, i) => botRow(b, i))}</div>` : html`<div class="empty compact">${t("ambient.none")}</div>`}
      <form
        class="ambient-bot-add"
        @submit=${(e: SubmitEvent) => {
          e.preventDefault();
          addBot();
        }}
      >
        <input
          data-focus-key="ambient-bot-name"
          type="text"
          maxlength="120"
          aria-label=${t("ambient.botName")}
          required
          placeholder=${t("ambient.botName")}
          .value=${ambientPolicyState.newBotName}
          ?disabled=${ambientPolicyState.saving}
          @input=${(e: InputEvent) => {
            ambientPolicyState.newBotName = (e.currentTarget as HTMLInputElement).value;
            redraw();
          }}
        />
        <button class="btn" type="submit" ?disabled=${ambientPolicyState.saving}>${t("ambient.addBot")}</button>
      </form>
      <div class="ambient-policy-actions">
        <button
          class="btn primary"
          type="button"
          ?disabled=${!ambientPolicyState.dirty || ambientPolicyState.saving}
          @click=${() => void save()}
        >
          ${ambientPolicyState.saving ? t("ambient.saving") : t("ambient.save")}
        </button>
        ${
          ambientPolicyState.notice
            ? html`<span
                class=${`ambient-policy-status ${ambientPolicyState.noticeKind === "error" ? "error" : ""}`}
                aria-live="polite"
                >${ambientPolicyState.notice}</span
              >`
            : nothing
        }
      </div>
    </section>
  `;
}
