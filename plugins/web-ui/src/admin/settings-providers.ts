import { html } from "lit";
import type { AdminPage } from "./sections.ts";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { ifDefined } from "lit/directives/if-defined.js";
let ctx: { page: AdminPage; redraw: () => void; refresh: () => Promise<void> };
const labels: Record<string, string> = {
  openai: "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
};
const provider = {
  draft: {} as Record<string, any>,
  editing: false,
  originalName: "",
  saving: false,
  message: "",
  error: false,
  rows: [] as any[],
  revision: 0,
  session: 0,
};
export const useProviders = (next: typeof ctx) => void (ctx = next);
const redraw = () => ctx.redraw();
function changeProvider(key: string, value: unknown) {
  provider.draft[key] = value;
  provider.revision++;
}
function openProvider(item: any = null) {
  provider.session++;
  provider.revision++;
  provider.editing = !!item;
  provider.originalName = item?.name || "";
  provider.draft = {
    id: item?.id || "",
    name: item?.name || "",
    protocol: item?.protocol || "openai",
    url: item?.baseUrl || "",
    key: "",
    modelSpecs: item?.models || [],
    models: item
      ? item.models
          .map((m: any) => [m.id, m.name, m.contextWindow, m.maxTokens, m.reasoning].map((x) => x ?? "").join(" | "))
          .join("\n")
      : "",
    validate: true,
  };
  provider.message = "";
  provider.error = false;
  provider.saving = false;
  redraw();
  (document.getElementById("custom-provider-dialog") as HTMLDialogElement).showModal();
  document.getElementById(provider.editing ? "custom-provider-name" : "custom-provider-id")?.focus();
}
function closeProvider() {
  provider.session++;
  provider.revision++;
  provider.saving = false;
  const dialog = document.getElementById("custom-provider-dialog") as HTMLDialogElement;
  if (dialog.open) dialog.close();
  provider.draft.key = "";
  redraw();
}
function providerBody() {
  const d = provider.draft;
  const models = d.models
    .split("\n")
    .map((l: string) => l.trim())
    .filter(Boolean)
    .map((l: string) => {
      const [id, name, contextWindow, maxTokens, reasoning] = l.split("|").map((p) => p.trim());
      const capability = reasoning === "true" || reasoning === "false" ? reasoning === "true" : reasoning || undefined;
      return {
        ...d.modelSpecs?.find((model: any) => model.id === id),
        id,
        name: name || undefined,
        contextWindow: contextWindow ? Number(contextWindow) : undefined,
        maxTokens: maxTokens ? Number(maxTokens) : undefined,
        reasoning: capability,
      };
    });
  return {
    name: d.name.trim(),
    protocol: d.protocol,
    baseUrl: d.url.trim(),
    models,
    ...(d.key.trim() ? { apiKey: d.key.trim() } : {}),
    ...(d.validate ? {} : { validate: false }),
  };
}
function fail(message: string, draw = true) {
  provider.message = message;
  provider.error = true;
  if (draw) redraw();
}
async function saveProvider() {
  if (provider.saving) return;
  const body = providerBody();
  const id = provider.draft.id.trim();
  if (!id || !body.name || !body.baseUrl || !body.models.length) {
    return fail("Provider id, name, base URL, and at least one model are required.");
  }
  const revision = provider.revision;
  const session = provider.session;
  provider.saving = true;
  provider.message = "Saving…";
  provider.error = false;
  redraw();
  try {
    const saved = await ctx.page.api("PUT", "/api/custom-providers/" + encodeURIComponent(id), body);
    if (session !== provider.session) return;
    if (!saved.ok) return fail(saved.data?.message || "Could not save this provider.", false);
    if (provider.draft.key.trim() === body.apiKey) provider.draft.key = "";
    await ctx.refresh();
    if (session !== provider.session) return;
    if (revision === provider.revision) closeProvider();
    else provider.message = "Provider saved. Your newer edits are not saved.";
  } catch {
    if (session === provider.session) fail("Could not save this provider. Your draft is preserved.", false);
  } finally {
    if (session === provider.session) {
      provider.saving = false;
      redraw();
    }
  }
}
async function removeProvider(item: any) {
  if (!confirm("Remove " + item.name + "? Its models leave every model picker.")) return;
  const removed = await ctx.page.api("DELETE", "/api/custom-providers/" + encodeURIComponent(item.id));
  if (!removed.ok) return fail(removed.data?.message || "Could not remove this provider.");
  await ctx.refresh();
}
export async function loadProviders() {
  const res = await ctx.page.api("GET", "/api/custom-providers");
  if (!res.ok) return;
  provider.rows = (res.data?.providers || []).filter((p: any) => !p.disabled);
  redraw();
}
function providerRows(compact: boolean) {
  return repeat(
    provider.rows,
    (p) => p.id,
    (p) =>
      html`<tr>
        ${[p.name + " (" + p.id + ")", labels[p.protocol] || p.protocol, p.baseUrl, compact ? String(p.models.length) : p.models.map((m: any) => m.id).join(", "), keyLabel(p, compact)].map((text) => html`<td>${text}</td>`)}
        <td>
          <button class="btn" type="button" @click=${() => openProvider(p)}>Edit</button
          ><button class="btn danger" @click=${() => removeProvider(p)}>Remove</button>
        </td>
      </tr>`,
  );
}
export function providersCard() {
  return html`<section class="card sv-models" id="card-custom-providers">
      <div class="head">
        <h2>Custom providers</h2>
        <p>
          OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages endpoints. Their models join the pickers
          above and below.
        </p>
      </div>
      <div class="body">
        <div class="tablewrap" id="model-custom-provider-table" ?hidden=${!provider.rows.length}>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Protocol</th>
                <th>Endpoint</th>
                <th>Models</th>
                <th>Key</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="model-custom-provider-rows">
              ${providerRows(true)}
            </tbody>
          </table>
        </div>
        <div id="custom-provider-summary" class="hint" ?hidden=${!!provider.rows.length}>No custom providers.</div>
      </div>
      <div class="foot">
        <button class="btn" type="button" id="add-custom-provider" @click=${() => openProvider()}>
          + Add provider
        </button>
      </div>
    </section>
    ${providerDialog()}`;
}

function input(
  key: string,
  label: string,
  o: { placeholder: string; disabled?: boolean; type?: string; cls?: string },
) {
  return html`<label class=${ifDefined(o.cls)}
    >${label}<input
      type=${ifDefined(o.type)}
      id=${"custom-provider-" + key}
      .value=${provider.draft[key] || ""}
      @input=${(e: Event) => changeProvider(key, (e.target as HTMLInputElement).value)}
      ?disabled=${!!o.disabled}
      autocomplete="off"
      placeholder=${o.placeholder}
  /></label>`;
}
function providerDialog() {
  return html`
    <dialog
      @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) closeProvider();
      }}
      @cancel=${() => closeProvider()}
      class="custom-provider-dialog"
      id="custom-provider-dialog"
      aria-labelledby="custom-provider-title"
    >
      <div class="project-dialog-head">
        <div>
          <h2 id="custom-provider-title">
            ${provider.editing ? "Edit " + provider.originalName : "Add custom provider"}
          </h2>
          <p>Connect an OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages endpoint.</p>
        </div>
        <button
          class="project-icon-button"
          type="button"
          id="custom-provider-close"
          @click=${closeProvider}
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div class="custom-provider-form">
        ${input("id", "Provider id (slug)", { placeholder: "litellm", disabled: provider.editing })}
        ${input("name", "Display name", { placeholder: "LiteLLM" })}
        <label
          >Protocol<select
            id="custom-provider-protocol"
            .value=${provider.draft.protocol || ""}
            @input=${(e: Event) => changeProvider("protocol", (e.target as HTMLInputElement).value)}
          >
            <option value="openai">OpenAI Chat Completions</option>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic">Anthropic Messages</option>
          </select></label
        >
        ${input("url", "Base URL", { placeholder: "https://gateway.internal/v1" })}
        ${input("key", "API key", { placeholder: "Write-only; blank on edit keeps the stored key", type: "password", cls: "custom-provider-key" })}
        <label class="custom-provider-models"
          >Models
          <span class="label-detail">one per line: id | name | context | max tokens | reasoning (true/false)</span
          ><textarea
            id="custom-provider-models"
            .value=${provider.draft.models || ""}
            @input=${(e: Event) => changeProvider("models", (e.target as HTMLInputElement).value)}
            rows="4"
            placeholder="deepseek-chat | DeepSeek V3.2 | 128000 | 8192 | true"
          ></textarea>
        </label>
        <label class="inline custom-provider-validation"
          ><input
            type="checkbox"
            id="custom-provider-validate"
            .checked=${provider.draft.validate}
            @change=${(e: Event) => changeProvider("validate", (e.target as HTMLInputElement).checked)}
          />
          Validate the key against the endpoint</label
        >
        <span
          class=${classMap({ status: true, err: provider.error, saving: provider.saving })}
          id="st-custom-provider"
          aria-live="polite"
          >${provider.message}</span
        >
      </div>
      <div class="project-dialog-actions">
        <button class="btn" type="button" id="custom-provider-cancel" @click=${closeProvider}>Cancel</button
        ><button class="btn primary" id="custom-provider-save" ?disabled=${provider.saving} @click=${saveProvider}>
          Save provider
        </button>
      </div>
    </dialog>
  `;
}
function keyLabel(p: any, compact: boolean) {
  const text = p.hasKey ? "set (write-only)" : "none";
  return compact ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
