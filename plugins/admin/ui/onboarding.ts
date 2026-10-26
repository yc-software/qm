import { html, nothing, render } from "lit";
type Data = Record<string, any>;
const providerLabels: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter (hosted open models)",
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Request failed.");
function providerSavedMessage(modelId: string, selected: { ok: boolean; data?: Data }) {
  if (!modelId) return "Key saved. The base model is unchanged.";
  if (selected.ok) return "Key and base model saved.";
  return "Key saved, but the base model could not be changed: " + (selected.data?.message || "the server rejected it.");
}

export class Onboarding {
  context: Data;
  models: Record<string, Data[]> = {};
  providers: Data[] = [];
  provider = "anthropic";
  model = "";
  apiKey = "";
  providerMessage = "";
  providerTone = "";
  providerBusy = false;
  baseModel = "";
  keepBaseModel = false;
  steps: Data = {
    model: { text: "Not ready", tone: "muted", summary: "Add the key the agent will use for its base model." },
    slack: {
      text: "Optional",
      tone: "muted",
      summary: "Create the Slack app, install it, then add its bot and Socket Mode tokens.",
      url: "https://api.slack.com/apps?new_app=1",
    },
    oauth: {
      text: "Optional",
      tone: "muted",
      summary: "Add Google, GitHub, Notion, or other OAuth clients to make those connectors available.",
    },
  };
  request = 0;
  painters: (() => void)[] = [];
  constructor(context: Data = {}) {
    this.context = context;
  }
  mount() {
    for (const placeholder of document.querySelectorAll<HTMLTemplateElement>("template[data-onboarding-ui]")) {
      const kind = placeholder.dataset.onboardingUi!;
      const fragment = document.createDocumentFragment();
      const draw = () => render(this.template(kind), fragment);
      draw();
      placeholder.replaceWith(fragment.firstElementChild!);
      this.painters.push(draw);
    }
  }
  draw() {
    for (const paint of this.painters) paint();
  }
  label(provider: string) {
    return providerLabels[provider] || this.context.connectorName(provider);
  }
  async load() {
    const token = ++this.request,
      view = this.context.view();
    const selection = { provider: this.provider, model: this.model, apiKey: this.apiKey };
    const [models, slack, catalog, config] = await Promise.all([
      this.context.api("GET", "/api/model-providers?catalog=cached"),
      this.context.api("GET", "/api/slack-installation"),
      this.context.api("GET", "/api/connector-catalog"),
      this.context.api("GET", "/api/scopes/" + encodeURIComponent(this.context.orgScope()) + "?view=onboarding"),
    ]);
    if (token !== this.request || view !== this.context.view()) return;
    if (!models.ok || !slack.ok || !catalog.ok || !config.ok) {
      this.providerMessage = "Setup status could not be loaded. Try again.";
      this.providerTone = "err";
      this.draw();
      return;
    }
    this.providers = models.data.providers || [];
    this.models = {};
    this.mergeModels([...(models.data.models || []), ...(config.data.baseModelOptions || [])]);
    const baseModel = config.data.baseModel || config.data.baseModelDefault || "";
    this.baseModel = baseModel;
    const provider =
      Object.entries(this.models).find(([, choices]) => choices.some((model) => model.id === baseModel))?.[0] ||
      this.providers.find((row) => row.configured)?.provider ||
      this.providers[0]?.provider ||
      "";
    const status = this.providers.find((row) => row.provider === provider);
    const subscriptionAuth = models.data.subscriptionAuth;
    const subscriptionReady = Boolean(subscriptionAuth && subscriptionAuth.provider === provider);
    const ready = Boolean(baseModel) && (Boolean(status?.configured) || subscriptionReady);
    let summary = "No base model is configured yet. Pick a provider and model below.";
    if (baseModel) {
      summary = baseModel + " cannot run until its " + this.label(provider) + " key is configured.";
      if (subscriptionReady) summary = baseModel + " · authenticated by subscription — no API key needed.";
      if (status?.configured)
        summary = baseModel + " · " + (status.source === "admin" ? "admin-managed key" : "deployment key");
    }
    this.steps.model = { text: ready ? "Ready" : "Needs a key", tone: ready ? "ok" : "warn", summary };
    if (selection.provider === this.provider && selection.model === this.model && selection.apiKey === this.apiKey) {
      this.provider = provider || this.providers[0]?.provider || "anthropic";
      this.model = this.firstModel();
    } else if (!this.model && !this.keepBaseModel) this.model = this.firstModel();
    this.steps.slack = {
      text: slack.data.configured ? "Connected" : "Optional",
      tone: slack.data.configured ? "ok" : "muted",
      summary: slack.data.configured
        ? "Connected to " + (slack.data.teamName || slack.data.teamId || "a Slack workspace") + "."
        : "Create the Slack app, install it, then add its bot and Socket Mode tokens.",
      url: slack.data.createUrl || "https://api.slack.com/apps?new_app=1",
    };
    const configured = (catalog.data.catalog || []).filter((item: Data) => item.configured);
    this.steps.oauth = {
      text: configured.length ? configured.length + " configured" : "Optional",
      tone: configured.length ? "ok" : "muted",
      summary: configured.length
        ? configured.map((item: Data) => this.context.connectorName(item.provider)).join(", ") +
          " available in the web UI."
        : "Add Google, GitHub, Notion, or other OAuth clients to make those connectors available.",
    };
    this.context.loaded();
    this.draw();
    if (models.data.modelCatalogRefreshing)
      void this.context
        .api("GET", "/api/model-providers")
        .then((fresh: Data) => {
          if (!fresh.ok || token !== this.request || view !== this.context.view()) return;
          this.mergeModels(fresh.data.models || []);
          this.draw();
        })
        .catch(() => {});
  }
  keepsBaseModel() {
    return Boolean(this.baseModel) && !(this.models[this.provider] || []).some((m) => m.id === this.baseModel);
  }
  firstModel() {
    if ((this.models[this.provider] || []).some((m) => m.id === this.baseModel)) return this.baseModel;
    return this.models[this.provider]?.[0]?.id || "";
  }
  mergeModels(models: Data[]) {
    for (const model of models) {
      if (!model.provider) continue;
      const options = (this.models[model.provider] ||= []);
      if (!options.some((option) => option.id === model.id)) options.push(model);
    }
  }
  async connect() {
    if (this.providerBusy) return;
    const provider = this.provider,
      apiKey = this.apiKey.trim(),
      modelId = this.model;
    if (!apiKey) {
      this.providerMessage = "Enter the provider API key.";
      this.providerTone = "err";
      this.draw();
      return;
    }
    this.providerBusy = true;
    this.providerMessage = "Validating with " + this.context.connectorName(provider) + "…";
    this.providerTone = "saving";
    this.draw();
    try {
      const saved = await this.context.api("PUT", "/api/model-providers/" + encodeURIComponent(provider), { apiKey });
      if (!saved.ok) throw new Error(saved.data?.message || "The provider rejected this key.");
      const selected = modelId
        ? await this.context.api("PUT", "/api/scopes/" + encodeURIComponent(this.context.orgScope()) + "/base-model", {
            modelId,
          })
        : { ok: true };
      this.apiKey = "";
      await this.load();
      await this.context.loadCustomProviders();
      this.providerMessage = providerSavedMessage(modelId, selected);
      this.providerTone = selected.ok ? "ok" : "err";
    } catch (error) {
      this.providerMessage = errorText(error);
      this.providerTone = "err";
    } finally {
      this.providerBusy = false;
      this.draw();
    }
  }
  async disableProvider() {
    if (this.providerBusy) return;
    const provider = this.provider;
    if (
      !confirm(
        "Disable the " +
          this.context.connectorName(provider) +
          " model key? Models from this provider will stop working.",
      )
    )
      return;
    this.providerBusy = true;
    this.draw();
    try {
      const response = await this.context.api("DELETE", "/api/model-providers/" + encodeURIComponent(provider));
      if (!response.ok) throw new Error(response.data?.message || "Could not disable this provider.");
      await this.load();
      await this.context.loadCustomProviders();
      this.providerMessage = "Provider disabled.";
      this.providerTone = "ok";
    } catch (error) {
      this.providerMessage = errorText(error);
      this.providerTone = "err";
    } finally {
      this.providerBusy = false;
      this.draw();
    }
  }
  template(kind: string) {
    if (kind === "steps")
      return html`<div class="setup-grid">
        ${["model", "slack", "oauth"].map(
          (key, i) =>
            html`<section class="setup-step">
              <span class=${"badge " + this.steps[key].tone} id=${"onboarding-" + key + "-badge"}
                >${this.steps[key].text}</span
              >
              <h2>${["1. Model provider", "2. Slack app", "3. OAuth apps"][i]}</h2>
              <p id=${"onboarding-" + key + "-summary"}>${this.steps[key].summary}</p>
              ${key === "slack" ? html`<div class="foot"><a class="header-button" id="onboarding-slack-create" href=${this.steps.slack.url} target="_blank" rel="noopener noreferrer">Create Slack app ↗</a><button type="button" data-onboarding-target="slack" @click=${() => this.context.navigate("slack")}>Enter Slack tokens</button></div>` : nothing}${key === "oauth" ? html`<div class="foot"><button type="button" data-onboarding-target="oauth" @click=${() => this.context.navigate("oauth")}>Configure OAuth apps</button></div>` : nothing}
            </section>`,
        )}
      </div>`;
    const choices = this.providers.length
      ? this.providers
      : Object.keys(providerLabels).map((provider) => ({ provider, configured: false }));
    const status = this.providers.find((p) => p.provider === this.provider);
    return html`<section class="card">
      <div class="head">
        <h2>Base model</h2>
        <p>
          Choose a supported provider and model. Saving validates the key, stores it write-only, and makes the selected
          model the organization default.
        </p>
      </div>
      <div class="body setup-form">
        <label
          >Provider
          <select
            id="onboarding-model-provider"
            .value=${this.provider}
            ?disabled=${this.providerBusy}
            @change=${(e: Event) => {
              this.provider = (e.target as HTMLSelectElement).value;
              this.model = this.firstModel();
              this.keepBaseModel = false;
              this.draw();
            }}
          >
            ${choices.map((p) => html`<option value=${p.provider} .selected=${p.provider === this.provider}>${this.label(p.provider) + (p.configured ? " (key configured)" : "")}</option>`)}
          </select></label
        ><label
          >Base model
          <select
            id="onboarding-model-id"
            .value=${this.model}
            ?disabled=${this.providerBusy}
            @change=${(e: Event) => {
              this.model = (e.target as HTMLSelectElement).value;
              this.keepBaseModel = !this.model;
              this.draw();
            }}
          >
            ${(this.models[this.provider] || []).map((model) => html`<option value=${model.id} ?selected=${model.id === this.model}>${model.name}</option>`)}
            ${this.keepsBaseModel() ? html`<option value="" ?selected=${!this.model}>Keep current base model (${this.baseModel})</option>` : nothing}
          </select></label
        ><label
          >API key
          <input
            type="password"
            id="onboarding-model-key"
            autocomplete="off"
            placeholder=${status?.configured ? "•••• set, enter a replacement" : "Write-only API key"}
            .value=${this.apiKey}
            ?disabled=${this.providerBusy}
            @input=${(e: Event) => {
              this.apiKey = (e.target as HTMLInputElement).value;
              this.draw();
            }}
        /></label>
      </div>
      <div class="foot">
        <button
          class="primary"
          id="onboarding-model-save"
          ?disabled=${this.providerBusy}
          @click=${() => this.connect()}
        >
          Validate and connect</button
        ><button
          class="danger"
          id="onboarding-model-delete"
          ?disabled=${this.providerBusy || !status || status.source === "absent"}
          @click=${() => this.disableProvider()}
        >
          Disable this provider</button
        ><span class=${"status" + (this.providerTone ? " " + this.providerTone : "")} id="st-onboarding-model"
          >${this.providerMessage}</span
        >
      </div>
    </section>`;
  }
}
const controller = new Onboarding();
export const mount = () => controller.mount();
export const configure = (context: Data) => {
  controller.context = context;
};
export const load = () => controller.load();
