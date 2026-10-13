import { mountTemplate } from "./shared.ts";
import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
let config: any;
const NEW_PROVIDER = { id: "", protocol: "chat-completions", baseUrl: "", credential: "", editing: false };
const state = {
  scope: "",
  data: null as any,
  provider: { ...NEW_PROVIDER },
  rule: null as any,
  saving: false,
  message: "",
  providerStatus: false,
};
let redraw = () => {};
export function configureDecisions(options: any) {
  config = options;
}
export function loadDecisions(data: any, scope: string) {
  state.scope = scope;
  state.data = scope.startsWith("org:") ? data.decisions || null : null;
  state.rule = null;
  redraw();
}
const hookActions = (hook: string) => state.data.hooks.find((h: any) => h.id === hook)?.actions || [];
const option = (key: string, o: any, hook: string) => ({
  key,
  description: o.description || "",
  action: o.action || hookActions(hook)[0],
  message: o.message || "",
  modelId: o.runtime?.modelId || "",
  effortLevel: o.runtime?.effortLevel || "",
  fastMode: !!o.runtime?.fastMode,
});
function ruleForm(r: any) {
  const hook = r?.hook || state.data.hooks[0]?.id || "";
  return {
    editing: !!r,
    id: r?.id || "",
    hook,
    question: r?.question || "",
    provider: r?.model.provider || state.data.providers[0]?.id || "",
    model: r?.model.model || "",
    mode: r?.mode || "observe",
    onError: r?.onError || "a",
    options: Object.entries(r?.options || { a: {}, b: {} }).map(([k, o]) => option(k, o, hook)),
  };
}
function openRule(r: any) {
  state.rule = ruleForm(r);
  redraw();
  document.querySelector("#card-decisions .decision-rule")?.scrollIntoView({ block: "nearest" });
}
function ruleBody(d: any) {
  return {
    id: d.id,
    hook: d.hook,
    question: d.question,
    model: { provider: d.provider, model: d.model },
    mode: d.mode,
    onError: d.onError,
    options: Object.fromEntries(
      d.options.map((o: any) => [
        o.key,
        {
          description: o.description,
          action: o.action,
          ...(o.message ? { message: o.message } : {}),
          ...(o.action === "use_runtime"
            ? {
                runtime: {
                  modelId: o.modelId,
                  ...(o.effortLevel ? { effortLevel: o.effortLevel } : {}),
                  fastMode: o.fastMode,
                },
              }
            : {}),
        },
      ]),
    ),
  };
}
async function send(body: any, done: () => void) {
  state.providerStatus = !!body.provider;
  state.saving = true;
  state.message = "Saving…";
  redraw();
  try {
    const result = await config.save(state.scope, body);
    if (result.ok) done();
    state.message = result.ok ? "Saved." : result.error || result.data?.message || "Save failed.";
  } catch (error) {
    state.message = `Could not save: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.saving = false;
    redraw();
  }
}
const upsert = (list: any[], item: any) =>
  [...list.filter((x) => x.id !== item.id), item].sort((a, b) => (a.id < b.id ? -1 : 1));
function saveProvider() {
  const p = state.provider;
  const provider = {
    id: p.id,
    protocol: p.protocol,
    ...(p.baseUrl ? { baseUrl: p.baseUrl, credential: p.credential } : {}),
  };
  void send({ provider }, () => {
    state.data.providers = upsert(state.data.providers, provider);
    state.provider = { ...NEW_PROVIDER };
  });
}
function saveRule() {
  const rule = ruleBody(state.rule);
  void send({ rule }, () => {
    state.data.rules = upsert(state.data.rules, rule);
    state.rule = null;
  });
}
function remove(kind: "Provider" | "Rule", id: string) {
  if (!confirm(`Remove decision ${kind.toLowerCase()} ${id}?`)) return;
  const key = kind === "Provider" ? "providers" : "rules";
  void send({ [`remove${kind}`]: id }, () => (state.data[key] = state.data[key].filter((x: any) => x.id !== id)));
}
const field = (
  label: string,
  value: string,
  set: (v: string) => void,
  hint = "",
  locked = false,
  suggestions: readonly string[] = [],
) =>
  html`<label
    >${label}<input
      list=${suggestions.length ? `decision-${label.replace(/\s/g, "-")}` : ""}
      ?disabled=${locked}
      .value=${value}
      placeholder=${hint}
      @input=${(e: Event) => set((e.target as HTMLInputElement).value)}
    />${
      suggestions.length
        ? html`<datalist id=${`decision-${label.replace(/\s/g, "-")}`}>
            ${[...new Set(suggestions)].map((v) => html`<option value=${v}></option>`)}
          </datalist>`
        : ""
    }</label
  >`;
const select = (label: string, value: string, values: readonly string[], set: (v: string) => void) =>
  html`<label
    >${label}<select @change=${(e: Event) => (set((e.target as HTMLSelectElement).value), redraw())}>
      ${values.map((v) => html`<option value=${v} .selected=${v === value}>${v}</option>`)}
    </select></label
  >`;
const row = (label: string, onEdit: () => void, onRemove: () => void) =>
  html`<div class="feature-flag-row">
    <code>${label}</code
    ><span
      ><button ?disabled=${state.saving} @click=${onEdit}>Edit</button
      ><button class="danger" ?disabled=${state.saving} @click=${onRemove}>Remove</button></span
    >
  </div>`;
function optionFields(d: any, o: any, i: number) {
  return html`<fieldset class="decision-option">
    ${field("Option", o.key, (v) => ((o.key = v), redraw()))}
    ${field("Description", o.description, (v) => (o.description = v))}
    ${field("Message", o.message, (v) => (o.message = v), "optional")}
    ${select("Action", o.action, hookActions(d.hook), (v) => (o.action = v))}
    ${
      o.action === "use_runtime"
        ? html`${select("Model", o.modelId, ["", ...state.data.models], (v) => (o.modelId = v))}
            ${field("Effort", o.effortLevel, (v) => (o.effortLevel = v), "optional")}
            <label class="setting-toggle"
              ><input
                type="checkbox"
                .checked=${o.fastMode}
                @change=${(e: Event) => (o.fastMode = (e.target as HTMLInputElement).checked)}
              />Fast mode</label
            >`
        : ""
    }
    <button class="danger" @click=${() => (d.options.splice(i, 1), redraw())}>Remove option</button>
  </fieldset>`;
}
function ruleEditor() {
  const d = state.rule;
  const set = (key: string) => (v: string) => (d[key] = v);
  return html`<div class="decision-form decision-rule">
    ${field("Rule id", d.id, set("id"), "e.g. hard-tasks", d.editing)}
    ${select(
      "Hook",
      d.hook,
      state.data.hooks.map((h: any) => h.id),
      set("hook"),
    )}
    <label class="decision-question"
      >Question<textarea
        .value=${d.question}
        @input=${(e: Event) => (d.question = (e.target as HTMLTextAreaElement).value)}
      ></textarea>
    </label>
    ${select(
      "Decision provider",
      d.provider,
      state.data.providers.map((p: any) => p.id),
      set("provider"),
    )}
    ${field("Decision model", d.model, set("model"), "model served by the provider", false, [
      ...state.data.rules.filter((r: any) => r.model.provider === d.provider).map((r: any) => r.model.model),
      ...(state.data.providers.find((p: any) => p.id === d.provider)?.baseUrl ? [] : state.data.gatewayModels || []),
    ])}
    ${select("Mode", d.mode, state.data.modes, set("mode"))}
    ${select("On error", d.onError, ["", ...d.options.map((o: any) => o.key)], set("onError"))}
    ${d.options.map((o: any, i: number) => optionFields(d, o, i))}
    <div>
      <button @click=${() => (d.options.push(option("", {}, d.hook)), redraw())}>+ Option</button>
      <button class="primary" ?disabled=${state.saving} @click=${saveRule}>Save rule</button>
      <button @click=${() => ((state.rule = null), redraw())}>Cancel</button>
    </div>
  </div>`;
}
function template() {
  const data = state.data;
  const p = state.provider;
  return html`<section class=${classMap({ card: true, "sv-customize": true, hidden: !data })} id="card-decisions">
    <div class="head">
      <h2>Decision rules</h2>
      <p>
        Classifiers that run at harness hooks. A rule asks its decision model a question, picks an option, and applies
        that option's action. Observe rules only log their verdicts.
      </p>
    </div>
    ${
      data
        ? html`<div class="body">
              <h3>Providers</h3>
              ${data.providers.map((x: any) =>
                row(
                  `${x.id}: ${x.protocol}${x.baseUrl ? ` · ${x.baseUrl} · ${x.credential}` : " · model gateway"}`,
                  () => ((state.provider = { ...NEW_PROVIDER, ...x, editing: true }), redraw()),
                  () => remove("Provider", x.id),
                ),
              )}
              <div class="decision-form">
                ${field("Provider id", p.id, (v) => (p.id = v), "", p.editing)}
                ${select("Protocol", p.protocol, data.protocols, (v) => (p.protocol = v))}
                ${field("Base URL", p.baseUrl, (v) => (p.baseUrl = v), "blank uses the model gateway")}
                ${field("Credential", p.credential, (v) => (p.credential = v), "org service credential", false, data.credentials || [])}
                <button ?disabled=${state.saving || !p.id} @click=${saveProvider}>Save provider</button>
                ${p.editing ? html`<button @click=${() => ((state.provider = { ...NEW_PROVIDER }), redraw())}>Cancel</button>` : ""}
                <span class="status">${state.providerStatus ? state.message : ""}</span>
              </div>
              <h3>Rules</h3>
              ${data.rules.map((r: any) =>
                row(
                  `${r.id}: ${r.hook} · ${r.mode}`,
                  () => openRule(r),
                  () => remove("Rule", r.id),
                ),
              )}
              ${state.rule ? ruleEditor() : ""}
            </div>
            <div class="foot">
              <button
                class="primary"
                ?disabled=${state.saving || !!state.rule || !data.providers.length}
                @click=${() => openRule(null)}
              >
                + Add rule</button
              ><span class="status">${state.providerStatus ? "" : state.message}</span>
            </div>`
        : ""
    }
  </section>`;
}
export function mountDecisions() {
  redraw = mountTemplate('template[data-settings-card="card-decisions"]', template);
}
