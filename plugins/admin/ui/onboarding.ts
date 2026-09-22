import { html, nothing, render } from "lit";
type Data = Record<string, any>;
const providerLabels: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter (hosted open models)",
};
const fieldLabels: Record<string, string> = {
  name: "Display name",
  template: "Compatible builtin template",
  contextWindow: "Context window (tokens)",
  maxTokens: "Maximum output (tokens)",
  input: "Input ($ / million tokens)",
  output: "Output ($ / million tokens)",
  cacheRead: "Cache read ($ / million tokens)",
  cacheWrite: "Cache write ($ / million tokens)",
};
const flagLabels: Record<string, string> = {
  base: "Offer in admin model choices",
  webui: "Offer in web picker by default",
  fastMode: "Model supports the Anthropic fast tier",
  auxiliary: "Eligible for auxiliary tasks",
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Request failed.");
export class Onboarding {
  context: Data;
  models: Record<string, Data[]> = {};
  providers: Data[] = [];
  templates: Data[] = [];
  entries: Data[] = [];
  provider = "anthropic";
  model = "";
  apiKey = "";
  providerMessage = "";
  providerTone = "";
  providerBusy = false;
  registryProvider = "openai";
  registryId = "";
  editing = false;
  providerLocked = false;
  lookup: Data | null = null;
  draft: Data = {};
  registryBusy = false;
  lookingUp = false;
  registryMessage = "";
  registryTone = "";
  advanced = false;
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
  lookupRequest = 0;
  registryRequest = 0;
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
  resetLookup() {
    this.lookupRequest++;
    this.lookup = null;
    this.lookingUp = false;
    this.registryMessage = "";
    this.registryTone = "";
    this.advanced = false;
  }
  reset(spec?: Data) {
    if (this.registryBusy) return;
    this.resetLookup();
    this.editing = Boolean(spec);
    this.providerLocked = Boolean(spec?.provider);
    this.registryId = spec?.id || "";
    this.registryProvider = spec?.provider || "openai";
    if (spec)
      this.showLookup({
        kind: "saved",
        spec,
        missing: [
          ...["name", "template", "contextWindow", "maxTokens"].filter((field) => spec[field] == null),
          ...["input", "output", "cacheRead", "cacheWrite"].filter((field) => spec.cost?.[field] == null),
        ],
        source: "Saved administrator definition",
        message: "Review the saved definition under Advanced overrides. Changes require verification again.",
      });
    this.draw();
  }
  showLookup(result: Data) {
    this.lookup = { ...result, identity: { provider: this.registryProvider, id: this.registryId.trim() } };
    this.draft = {};
    for (const field of ["name", "template", "contextWindow", "maxTokens"])
      this.draft[field] = String(result.spec[field] ?? "");
    for (const field of ["input", "output", "cacheRead", "cacheWrite"])
      this.draft[field] = String(result.spec.cost?.[field] ?? "");
    for (const field of Object.keys(flagLabels))
      this.draft[field] = result.spec[field] ?? (field === "base" || field === "webui");
    this.draft.tiers = JSON.stringify(result.spec.cost?.tiers ?? [], null, 2);
    this.advanced = false;
  }
  async loadRegistry() {
    const token = ++this.registryRequest;
    const response = await this.context.api("GET", "/api/model-registry");
    if (token !== this.registryRequest) return;
    if (!response.ok) {
      this.registryMessage = "Could not load models.";
      this.registryTone = "err";
      this.draw();
      return;
    }
    this.templates = response.data.templates || [];
    this.entries = (response.data.models || []).filter((row: Data) => !row.disabled);
    this.draw();
  }
  async load() {
    const token = ++this.request,
      view = this.context.view();
    const selection = { provider: this.provider, model: this.model, apiKey: this.apiKey };
    void this.loadRegistry().catch(() => {});
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
    this.mergeModels([
      ...(models.data.models || []),
      ...(config.data.baseModelOptions || []),
      ...Object.values(config.data.modelsByHarness || {}).flat(),
    ]);
    const baseModel = config.data.baseModel || config.data.baseModelDefault || "";
    const provider =
      Object.entries(this.models).find(([, choices]) => choices.some((model) => model.id === baseModel))?.[0] ||
      this.providers.find((row) => row.configured)?.provider ||
      this.providers[0]?.provider ||
      "";
    const status = this.providers.find((row) => row.provider === provider);
    const harnessAuth = models.data.harnessAuth;
    const harnessReady = Boolean(harnessAuth && harnessAuth.provider === provider);
    const ready = Boolean(baseModel) && (Boolean(status?.configured) || harnessReady);
    let summary = "No base model is configured yet. Pick a provider and model below.";
    if (baseModel) {
      summary = baseModel + " cannot run until its " + this.label(provider) + " key is configured.";
      if (harnessReady)
        summary = baseModel + " · authenticated by the " + harnessAuth.harnessId + " harness — no API key needed.";
      if (status?.configured)
        summary = baseModel + " · " + (status.source === "admin" ? "admin-managed key" : "deployment key");
    }
    this.steps.model = { text: ready ? "Ready" : "Needs a key", tone: ready ? "ok" : "warn", summary };
    if (selection.provider === this.provider && selection.model === this.model && selection.apiKey === this.apiKey) {
      this.provider = provider || this.providers[0]?.provider || "anthropic";
      this.model = (this.models[this.provider] || []).some((m) => m.id === baseModel)
        ? baseModel
        : this.models[this.provider]?.[0]?.id || "";
    } else if (!this.model) this.model = this.models[this.provider]?.[0]?.id || "";
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
      const selected = await this.context.api(
        "PUT",
        "/api/scopes/" + encodeURIComponent(this.context.orgScope()) + "/base-model",
        { modelId },
      );
      this.apiKey = "";
      await this.load();
      await this.context.loadCustomProviders();
      this.providerMessage = selected.ok
        ? "Key and base model saved."
        : "Key saved, but the base model could not be changed.";
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
  async lookupModel() {
    if (this.registryBusy) return;
    this.resetLookup();
    const token = this.lookupRequest;
    this.lookingUp = true;
    this.registryMessage = "Looking up exact model metadata…";
    this.draw();
    try {
      const response = await this.context.api("POST", "/api/model-registry/lookup", {
        provider: this.registryProvider,
        id: this.registryId.trim(),
      });
      if (token !== this.lookupRequest) return;
      if (!response.ok) throw new Error(response.data?.message || "Lookup failed. Try again.");
      this.showLookup(response.data);
      this.registryMessage = "Metadata loaded. Review, then verify access.";
    } catch (error) {
      if (token === this.lookupRequest) {
        this.registryMessage = errorText(error);
        this.registryTone = "err";
      }
    } finally {
      if (token === this.lookupRequest) {
        this.lookingUp = false;
        this.draw();
      }
    }
  }
  async deleteModel(spec: Data) {
    if (this.registryBusy || !confirm("Delete " + spec.name + "? New uses will be refused.")) return;
    this.registryBusy = true;
    this.draw();
    try {
      const response = await this.context.api("DELETE", "/api/model-registry/" + encodeURIComponent(spec.id));
      if (!response.ok) throw new Error(response.data?.message || "Could not delete model.");
      await this.load();
      this.registryBusy = false;
      this.reset();
      this.registryMessage = "Model deleted.";
      this.registryTone = "ok";
    } catch (error) {
      this.registryMessage = errorText(error);
      this.registryTone = "err";
    } finally {
      this.registryBusy = false;
      this.draw();
    }
  }
  collect() {
    if (!this.lookup) throw new Error("Look up the model first.");
    const identity = { provider: this.registryProvider, id: this.registryId.trim() };
    if (JSON.stringify(identity) !== JSON.stringify(this.lookup.identity))
      throw new Error("Look up the current model before verifying.");
    if (this.lookup.kind === "builtin") return { provider: identity.provider, verify: true };
    const value = (field: string) => String(this.draft[field] ?? "").trim();
    const number = (field: string) => {
      if (!value(field)) throw new Error(field + " is required");
      const n = Number(value(field));
      if (!Number.isFinite(n)) throw new Error(field + " must be a number");
      return n;
    };
    if (!value("name") || !value("template")) throw new Error("Display name and a compatible template are required.");
    return {
      ...identity,
      name: value("name"),
      template: value("template"),
      contextWindow: number("contextWindow"),
      maxTokens: number("maxTokens"),
      cost: {
        ...Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map((field) => [field, number(field)])),
        tiers: JSON.parse(value("tiers") || "[]"),
      },
      ...Object.fromEntries(Object.keys(flagLabels).map((field) => [field, this.draft[field]])),
      verify: true,
    };
  }
  async verify() {
    if (this.registryBusy || !this.lookup) return;
    try {
      const body = this.collect(),
        builtin = this.lookup.kind === "builtin",
        id = this.registryId.trim();
      this.registryBusy = true;
      this.registryMessage = "Checking the model with organization credentials…";
      this.registryTone = "";
      this.draw();
      const response = await this.context.api(
        builtin ? "POST" : "PUT",
        "/api/model-registry/" + encodeURIComponent(id) + (builtin ? "/enable" : ""),
        body,
      );
      if (!response.ok) throw new Error(response.data?.message || "Could not verify model.");
      await this.load();
      this.registryMessage = builtin
        ? response.data.message
        : "Model verified and enabled with organization credentials. Personal-key access may differ.";
      this.registryTone = "ok";
    } catch (error) {
      this.registryMessage = errorText(error);
      this.registryTone = "err";
    } finally {
      this.registryBusy = false;
      this.draw();
    }
  }
  field(name: string) {
    const change = (e: Event) => {
      this.draft[name] = (e.target as HTMLInputElement).value;
      this.draw();
    };
    let input = html`<input
      id=${"model-registry-" + name}
      type="number"
      min=${(() => {
        if (name === "contextWindow") return "2";
        return name === "maxTokens" ? "1" : "0";
      })()}
      step=${name === "contextWindow" || name === "maxTokens" ? "1" : "any"}
      required
      .value=${this.draft[name] || ""}
      ?disabled=${this.registryBusy}
      @input=${change}
    />`;
    if (name === "name")
      input = html`<input
        type="text"
        id="model-registry-name"
        autocomplete="off"
        required
        .value=${this.draft.name || ""}
        ?disabled=${this.registryBusy}
        @input=${change}
      />`;
    if (name === "template")
      input = html`<select
        id="model-registry-template"
        .value=${this.draft.template || ""}
        ?disabled=${this.registryBusy}
        @change=${change}
      >
        <option value="">Choose a compatible template</option>
        ${this.templates.filter((t) => t.provider === this.registryProvider).map((t) => html`<option value=${t.id} .selected=${t.id === this.draft.template}>${t.name}</option>`)}
      </select>`;
    return html`<label>${fieldLabels[name]} ${input}</label>`;
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
    if (kind === "provider") {
      const choices = this.providers.length
        ? this.providers
        : Object.keys(providerLabels).map((provider) => ({ provider, configured: false }));
      const status = this.providers.find((p) => p.provider === this.provider);
      return html`<section class="card">
        <div class="head">
          <h2>Base model</h2>
          <p>
            Choose a supported provider and model. Saving validates the key, stores it write-only, and makes the
            selected model the organization default.
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
                this.model = this.models[this.provider]?.[0]?.id || "";
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
                this.draw();
              }}
            >
              ${(this.models[this.provider] || []).map((model) => html`<option value=${model.id} .selected=${model.id === this.model}>${model.name}</option>`)}
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
    return this.registryTemplate();
  }
  registryTemplate() {
    const lookup = this.lookup,
      spec = lookup?.spec || {},
      missing: string[] = lookup?.missing || [];
    const template = this.templates.find((t) => t.id === this.draft.template);
    const identityChange = (key: "registryId" | "registryProvider") => (e: Event) => {
      this[key] = (e.target as HTMLInputElement).value;
      this.resetLookup();
      this.draw();
    };
    let summary = spec.name || spec.id;
    if (lookup?.kind === "builtin")
      summary = `${spec.name} · ${spec.contextWindow.toLocaleString()} context tokens · ${spec.maxTokens.toLocaleString()} maximum output · $${spec.cost.input} input / $${spec.cost.output} output per million tokens`;
    return html`<section class="card">
      <div class="head">
        <h2>Models on existing providers</h2>
        <p>
          Start with a provider and model ID. We look up exact catalog or provider metadata before asking for any
          missing details. Organization credentials are inherited; subscription support is not implied.
        </p>
      </div>
      <div class="body">
        <table class="table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Provider</th>
              <th>Template</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="model-registry-rows">
            ${this.entries.map(({ spec, unavailableReason, verifiedAt }) => {
              let verification = " — Not verified";
              if (verifiedAt)
                verification = " — Verified with organization credentials " + new Date(verifiedAt).toLocaleString();
              if (unavailableReason) verification = " — " + unavailableReason;
              return html`<tr>
                <td>${(spec.name || spec.id) + " (" + spec.id + ")" + verification}</td>
                <td>${spec.provider || "Unknown"}</td>
                <td>${spec.template || "Missing"}</td>
                <td>
                  <button ?disabled=${this.registryBusy} @click=${() => this.reset(spec)}>Edit</button
                  ><button class="danger" ?disabled=${this.registryBusy} @click=${() => this.deleteModel(spec)}>
                    Delete
                  </button>
                </td>
              </tr>`;
            })}
          </tbody>
        </table>
        <p class="muted" id="model-registry-empty" ?hidden=${this.entries.length > 0}>No additional models.</p>
      </div>
      <div class="body setup-form">
        <label
          >Provider
          <select
            id="model-registry-provider"
            .value=${this.registryProvider}
            ?disabled=${this.registryBusy || this.providerLocked}
            @change=${identityChange("registryProvider")}
          >
            <option value="openai" .selected=${this.registryProvider === "openai"}>OpenAI</option>
            <option value="anthropic" .selected=${this.registryProvider === "anthropic"}>Anthropic</option>
          </select></label
        ><label
          >Model ID
          <input
            type="text"
            id="model-registry-id"
            autocomplete="off"
            placeholder="e.g. claude-opus-4-6"
            required
            .value=${this.registryId}
            ?disabled=${this.registryBusy || this.editing}
            @input=${identityChange("registryId")}
        /></label>
      </div>
      <div class="foot">
        <button
          id="model-registry-lookup"
          class="primary"
          ?disabled=${this.registryBusy || this.lookingUp}
          @click=${() => this.lookupModel()}
        >
          Look up model
        </button>
      </div>
      <div class="body" id="model-registry-result" ?hidden=${!lookup}>
        <p id="model-registry-source" class="muted">
          ${lookup ? "Source: " + lookup.source + (lookup.catalogGeneratedAt ? " · catalog " + new Date(lookup.catalogGeneratedAt).toLocaleDateString() : "") : ""}
        </p>
        <p id="model-registry-summary">${summary}</p>
        <p id="model-registry-lookup-note" class="muted">${lookup?.message || ""}</p>
        <div id="model-registry-missing" ?hidden=${!missing.length}>
          <h3>Complete missing information</h3>
          <p class="muted">
            These fields were not available from the exact model record. Use the provider's documentation; choose a
            compatible template explicitly.
          </p>
          <div class="setup-form" id="model-registry-missing-fields">
            ${Object.keys(fieldLabels)
              .filter((key) => missing.includes(key))
              .map((key) => this.field(key))}
          </div>
        </div>
        <details
          id="model-registry-advanced"
          ?hidden=${lookup?.kind === "builtin"}
          .open=${this.advanced}
          @toggle=${(e: Event) => {
            this.advanced = (e.target as HTMLDetailsElement).open;
          }}
        >
          <summary>Advanced overrides</summary>
          <p class="muted">
            Review imported values or override them. Pricing is per million tokens. Overrides require verification
            again.
          </p>
          <div class="setup-form" id="model-registry-advanced-fields">
            ${Object.keys(fieldLabels)
              .filter((key) => !missing.includes(key))
              .map((key) => this.field(key))}
            <p class="muted" id="model-registry-capabilities">
              ${template ? `Inherited: ${template.input.join(", ")} input; reasoning ${template.reasoning ? "yes" : "no"}.` : ""}
            </p>
            ${Object.entries(flagLabels).map(
              ([key, label]) =>
                html`<label class="check"
                  ><input
                    id=${"model-registry-" + key}
                    type="checkbox"
                    .checked=${this.draft[key] ?? (key === "base" || key === "webui")}
                    ?disabled=${this.registryBusy}
                    @change=${(e: Event) => {
                      this.draft[key] = (e.target as HTMLInputElement).checked;
                      this.draw();
                    }}
                  />
                  ${label}</label
                >`,
            )}
            <details>
              <summary>Advanced pricing tiers</summary>
              <label
                >JSON array of inputTokensAbove, input, output, cacheRead and cacheWrite<textarea
                  id="model-registry-tiers"
                  rows="4"
                  placeholder="[]"
                  .value=${this.draft.tiers || ""}
                  ?disabled=${this.registryBusy}
                  @input=${(e: Event) => {
                    this.draft.tiers = (e.target as HTMLTextAreaElement).value;
                    this.draw();
                  }}
                ></textarea>
              </label>
            </details>
          </div>
        </details>
      </div>
      <p class="muted" id="model-registry-verification-notice">
        Verify and enable sends a synthetic connection check using the organization's serving credentials. It may incur
        a small provider charge (up to 128 output tokens per request; an additional check with fast mode; provider
        retries may apply). A successful check confirms access now, not pricing, maximum context, every capability, or
        personal-key access. Failed checks do not save or enable the new definition. Existing saved settings remain
        unchanged. A failed recheck of those settings removes their verification.
      </p>
      <div class="foot">
        <button
          class="primary"
          id="model-registry-save"
          ?disabled=${!lookup || this.registryBusy}
          @click=${() => this.verify()}
        >
          ${(() => {
            if (this.registryBusy) return "Verifying…";
            return lookup?.kind === "builtin" ? "Verify and enable existing model" : "Verify and enable";
          })()}</button
        ><button id="model-registry-new" ?disabled=${this.registryBusy} @click=${() => this.reset()}>New model</button
        ><span class=${"status" + (this.registryTone ? " " + this.registryTone : "")} id="st-model-registry"
          >${this.registryMessage}</span
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
