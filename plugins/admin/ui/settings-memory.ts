import { mountTemplate } from "./shared.ts";
import { html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
type Data = Record<string, any>;
let config: { api: (method: string, path: string, body?: unknown) => Promise<Data> };
export const memory = {
  scope: "",
  available: false,
  saved: "",
  selected: "",
  catalog: [] as Data[],
  registered: [] as Data[],
  openai: null as Data | null,
  apiKey: "",
  modelId: "",
  name: "",
  busy: false,
  message: "",
  tone: "",
};
let redraw = () => {};
export function configureMemory(options: typeof config) {
  config = options;
}
const source = (model: Data) => (model.provider === "qm:gateway" ? "model gateway" : "OpenAI, organization key");
const report = (message: string, tone = "") => {
  memory.message = message;
  memory.tone = tone;
  redraw();
};
const failed = (response: Data, fallback: string) => {
  if (!response.ok) throw new Error(response.data?.message || response.data?.error || fallback);
};
async function refresh() {
  const [registry, providers] = await Promise.all([
    config.api("GET", "/api/model-registry"),
    config.api("GET", "/api/model-providers?catalog=cached"),
  ]);
  failed(registry, "Could not load embedding models (HTTP " + registry.status + ").");
  failed(providers, "Could not load the OpenAI key status (HTTP " + providers.status + ").");
  memory.catalog = registry.data.embeddingModels || [];
  memory.registered = (registry.data.models || []).filter(
    (row: Data) => row.spec?.kind === "embedding" && !row.disabled,
  );
  memory.openai = (providers.data.providers || []).find((row: Data) => row.provider === "openai") || null;
}
export async function loadMemory(data: Data, scope: string) {
  memory.scope = scope;
  memory.available = scope.startsWith("org:") && "memoryEmbeddingModel" in data;
  memory.saved = memory.selected = data.memoryEmbeddingModel || "";
  memory.message = "";
  if (!memory.available) return redraw();
  try {
    await refresh();
  } catch (error) {
    memory.message = (error as Error).message;
    memory.tone = "err";
  }
  redraw();
}
async function run(pending: string, action: () => Promise<string>) {
  if (memory.busy) return;
  memory.busy = true;
  report(pending, "saving");
  try {
    const done = await action();
    await refresh();
    report(done, "ok");
  } catch (error) {
    report((error as Error).message, "err");
  } finally {
    memory.busy = false;
    redraw();
  }
}
const apply = () =>
  run("Saving…", async () => {
    const modelId = memory.selected || null;
    const scope = memory.scope;
    const response = await config.api("PUT", "/api/scopes/" + encodeURIComponent(scope) + "/memory-embedding-model", {
      modelId,
    });
    failed(response, "Could not change the embedding model.");
    if (memory.scope === scope) memory.saved = memory.selected = modelId ?? "";
    return modelId ? "Saved. Recall ranks by relevance from the next turn." : "Saved. Recall uses newest facts.";
  });
const saveKey = () =>
  run("Validating the key with OpenAI…", async () => {
    const response = await config.api("PUT", "/api/model-providers/openai", { apiKey: memory.apiKey.trim() });
    failed(response, "OpenAI rejected this key.");
    memory.apiKey = "";
    return "OpenAI key saved.";
  });
const register = (id: string, name: string) =>
  run("Verifying with one embedding request…", async () => {
    if (!id || !name) throw new Error("Enter a model ID and display name.");
    const response = await config.api("PUT", "/api/model-registry/" + encodeURIComponent(id), {
      kind: "embedding",
      name,
      provider: "openai",
      verify: true,
    });
    failed(response, "Could not verify this model.");
    memory.modelId = memory.name = "";
    return name + " verified. Select it above to use it.";
  });
const remove = (spec: Data) => {
  if (!confirm("Delete " + spec.name + "? Recall falls back to newest facts if it is selected.")) return;
  void run("Deleting…", async () => {
    failed(await config.api("DELETE", "/api/model-registry/" + encodeURIComponent(spec.id)), "Could not delete.");
    return spec.name + " deleted.";
  });
};
function mode() {
  const active = memory.catalog.find((model) => model.id === memory.saved);
  if (active)
    return html`<strong>Relevance ranking</strong>
      <small
        >${active.name} (${source(active)}) ranks saved facts by similarity to the current message and recent
        conversation. A turn whose embedding request fails uses the newest facts instead.</small
      >`;
  if (memory.saved)
    return html`<strong>Recency fallback</strong>
      <small
        >${memory.saved} is unavailable (deleted, not verified, or not offered by the gateway right now), so recall uses
        the newest facts until it returns or another model is selected.</small
      >`;
  return html`<strong>Recency</strong>
    <small>No embedding model is selected, so recall uses the newest facts that fit the budget.</small>`;
}
function keyStatus() {
  if (memory.openai?.configured)
    return memory.openai.source === "admin"
      ? "Organization OpenAI key: set by an administrator."
      : "Organization OpenAI key: provided by the deployment.";
  return "Organization OpenAI key: not set. OpenAI embedding models cannot be verified or used until one is saved.";
}
const label = (model: Data) => (model.provider ? `${model.name} · ${source(model)}` : model.name);
const value = (event: Event) => (event.target as HTMLInputElement).value;
function template() {
  const options = [...memory.catalog];
  if (memory.saved && !options.some((model) => model.id === memory.saved))
    options.push({ id: memory.saved, name: memory.saved + " (unavailable)" });
  return html`<section
    class=${classMap({ card: true, "sv-models": true, hidden: !memory.available })}
    id="card-memory-recall"
  >
    <div class="head">
      <h2>Memory recall</h2>
      <p>
        Each turn carries up to 6,000 characters of saved memory facts. An embedding model picks the most relevant
        facts; without one, the newest facts are used.
      </p>
    </div>
    <div class="body">
      <p class="memory-recall-mode" id="memory-recall-mode">${mode()}</p>
      <label for="memory-embedding-model">Embedding model</label
      ><select
        id="memory-embedding-model"
        .value=${memory.selected}
        ?disabled=${memory.busy}
        @change=${(e: Event) => {
          memory.selected = value(e);
          redraw();
        }}
      >
        <option value="" .selected=${!memory.selected}>None (use newest facts)</option>
        ${options.map((model) => html`<option value=${model.id} .selected=${model.id === memory.selected}>${label(model)}</option>`)}
      </select>
      <p class="hint">
        Embedding models served by the model gateway are listed automatically. To call OpenAI directly, register a model
        below.
      </p>
    </div>
    <div class="foot">
      <button
        class=${classMap({ primary: true, dirty: memory.selected !== memory.saved })}
        id="memory-embedding-save"
        ?disabled=${memory.busy || memory.selected === memory.saved}
        @click=${apply}
      >
        Apply
      </button>
    </div>
    <div class="body">
      <h3>OpenAI embedding models</h3>
      <p class="hint" id="memory-openai-key-status">${keyStatus()}</p>
      <div class="model-add-row">
        <div class="model-add-field">
          <label for="memory-openai-key">OpenAI API key (also used by OpenAI chat models)</label
          ><input
            type="password"
            id="memory-openai-key"
            autocomplete="off"
            placeholder=${memory.openai?.configured ? "•••• set, enter a replacement" : "Write-only API key"}
            .value=${memory.apiKey}
            ?disabled=${memory.busy}
            @input=${(e: Event) => {
              memory.apiKey = value(e);
              redraw();
            }}
          />
        </div>
        <button id="memory-openai-key-save" ?disabled=${memory.busy || !memory.apiKey.trim()} @click=${saveKey}>
          Save key
        </button>
      </div>
      ${
        memory.registered.length
          ? html`<table class="table">
              <tbody id="memory-embedding-rows">
                ${memory.registered.map(
                  ({ spec, unavailableReason, verifiedAt }) =>
                    html`<tr>
                      <td>
                        ${spec.name} (${spec.id})<br /><small class="muted"
                          >${unavailableReason || (verifiedAt ? "Verified " + new Date(verifiedAt).toLocaleString() : "Not verified")}</small
                        >
                      </td>
                      <td>
                        <button ?disabled=${memory.busy} @click=${() => register(spec.id, spec.name)}>
                          Verify again</button
                        ><button class="danger" ?disabled=${memory.busy} @click=${() => remove(spec)}>Delete</button>
                      </td>
                    </tr>`,
                )}
              </tbody>
            </table>`
          : nothing
      }
      <div class="model-add-row">
        <div class="model-add-field">
          <label for="memory-embedding-id">Model ID</label
          ><input
            id="memory-embedding-id"
            autocomplete="off"
            placeholder="text-embedding-3-small"
            .value=${memory.modelId}
            ?disabled=${memory.busy}
            @input=${(e: Event) => {
              memory.modelId = value(e);
              redraw();
            }}
          />
        </div>
        <div class="model-add-field">
          <label for="memory-embedding-name">Display name</label
          ><input
            id="memory-embedding-name"
            autocomplete="off"
            placeholder="OpenAI small embeddings"
            .value=${memory.name}
            ?disabled=${memory.busy}
            @input=${(e: Event) => {
              memory.name = value(e);
              redraw();
            }}
          />
        </div>
        <button
          id="memory-embedding-register"
          ?disabled=${memory.busy}
          @click=${() => register(memory.modelId.trim(), memory.name.trim())}
        >
          Verify and register
        </button>
      </div>
      <p class="hint">Verification sends one small, billable embedding request with the organization OpenAI key.</p>
    </div>
    <div class="foot">
      <span class=${classMap({ status: true, [memory.tone]: !!memory.tone })} id="st-memory-recall" aria-live="polite"
        >${memory.message}</span
      >
    </div>
  </section>`;
}
export function mountMemory() {
  redraw = mountTemplate('template[data-settings-card="card-memory-recall"]', template);
}
