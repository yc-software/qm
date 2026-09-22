import { mountTemplate } from "./shared.ts";
import { html, render } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
let config: any;
const labels: Record<string, string> = {
  openai: "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
};
export const provider = {
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
let redraw = () => {};
const mountedSummaries = new WeakSet<HTMLElement>();
export function configureProviders(options: any) {
  config = options;
}
function changeProvider(key: string, value: unknown) {
  provider.draft[key] = value;
  provider.revision++;
}
export function openProvider(item: any = null) {
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
    models: item
      ? item.models
          .map((m: any) => [m.id, m.name, m.contextWindow, m.maxTokens].filter((x) => x != null).join(" | "))
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
export function providerBody() {
  const d = provider.draft;
  const models = d.models
    .split("\n")
    .map((l: string) => l.trim())
    .filter(Boolean)
    .map((l: string) => {
      const [id, name, contextWindow, maxTokens] = l.split("|").map((p) => p.trim());
      return {
        id,
        ...(name ? { name } : {}),
        ...(contextWindow ? { contextWindow: Number(contextWindow) } : {}),
        ...(maxTokens ? { maxTokens: Number(maxTokens) } : {}),
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
async function saveProvider() {
  if (provider.saving) return;
  const body = providerBody();
  const id = provider.draft.id.trim();
  if (!id || !body.name || !body.baseUrl || !body.models.length) {
    provider.message = "Provider id, name, base URL, and at least one model are required.";
    provider.error = true;
    redraw();
    return;
  }
  const revision = provider.revision;
  const session = provider.session;
  provider.saving = true;
  provider.message = "Saving…";
  provider.error = false;
  redraw();
  try {
    const saved = await config.api("PUT", "/api/custom-providers/" + encodeURIComponent(id), body);
    if (session !== provider.session) return;
    if (!saved.ok) {
      provider.error = true;
      provider.message = saved.data?.message || "Could not save this provider.";
      return;
    }
    if (provider.draft.key.trim() === body.apiKey) provider.draft.key = "";
    await config.refresh();
    if (session !== provider.session) return;
    if (revision === provider.revision) closeProvider();
    else provider.message = "Provider saved. Your newer edits are not saved.";
  } catch {
    if (session === provider.session) {
      provider.error = true;
      provider.message = "Could not save this provider. Your draft is preserved.";
    }
  } finally {
    if (session === provider.session) {
      provider.saving = false;
      redraw();
    }
  }
}
async function removeProvider(item: any) {
  if (!confirm("Remove " + item.name + "? Its models leave every model picker.")) return;
  const removed = await config.api("DELETE", "/api/custom-providers/" + encodeURIComponent(item.id));
  if (!removed.ok) {
    provider.message = removed.data?.message || "Could not remove this provider.";
    provider.error = true;
    redraw();
    return;
  }
  await config.refresh();
}
export async function loadProviders() {
  const res = await config.api("GET", "/api/custom-providers");
  if (!res.ok) return;
  provider.rows = (res.data?.providers || []).filter((p: any) => !p.disabled);
  renderRows();
}
function renderRows() {
  for (const [id, compact] of [
    ["model-custom-provider-rows", true],
    ["custom-provider-rows", false],
  ] as const) {
    const root = document.getElementById(id);
    if (!root) continue;
    render(
      html`${repeat(
        provider.rows,
        (p) => p.id,
        (p) =>
          html`<tr>
            ${[p.name + " (" + p.id + ")", labels[p.protocol] || p.protocol, p.baseUrl, compact ? String(p.models.length) : p.models.map((m: any) => m.id).join(", "), keyLabel(p, compact)].map((text) => html`<td>${text}</td>`)}
            <td>
              <button type="button" @click=${() => openProvider(p)}>Edit</button
              ><button class="danger" @click=${() => removeProvider(p)}>Remove</button>
            </td>
          </tr>`,
      )}`,
      root,
    );
  }
  const table = document.getElementById("model-custom-provider-table");
  if (table) table.hidden = !provider.rows.length;
  const summary = document.getElementById("custom-provider-summary");
  if (summary) {
    if (!mountedSummaries.has(summary)) {
      summary.replaceChildren();
      mountedSummaries.add(summary);
    }
    summary.hidden = !!provider.rows.length;
    render(html`No custom providers.`, summary);
  }
  const empty = document.getElementById("custom-provider-empty");
  if (empty) empty.hidden = !!provider.rows.length;
}

function template() {
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
        <label
          >Provider id (slug)<input
            id="custom-provider-id"
            .value=${provider.draft.id || ""}
            @input=${(e: Event) => changeProvider("id", (e.target as HTMLInputElement).value)}
            ?disabled=${provider.editing}
            autocomplete="off"
            placeholder="litellm"
        /></label>
        <label
          >Display name<input
            id="custom-provider-name"
            .value=${provider.draft.name || ""}
            @input=${(e: Event) => changeProvider("name", (e.target as HTMLInputElement).value)}
            autocomplete="off"
            placeholder="LiteLLM"
        /></label>
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
        <label
          >Base URL<input
            id="custom-provider-url"
            .value=${provider.draft.url || ""}
            @input=${(e: Event) => changeProvider("url", (e.target as HTMLInputElement).value)}
            autocomplete="off"
            placeholder="https://gateway.internal/v1"
        /></label>
        <label class="custom-provider-key"
          >API key<input
            type="password"
            id="custom-provider-key"
            .value=${provider.draft.key || ""}
            @input=${(e: Event) => changeProvider("key", (e.target as HTMLInputElement).value)}
            autocomplete="off"
            placeholder="Write-only; blank on edit keeps the stored key"
        /></label>
        <label class="custom-provider-models"
          >Models <span class="label-detail">one per line: id | name | context | max tokens</span
          ><textarea
            id="custom-provider-models"
            .value=${provider.draft.models || ""}
            @input=${(e: Event) => changeProvider("models", (e.target as HTMLInputElement).value)}
            rows="4"
            placeholder="deepseek-chat | DeepSeek V3.2 | 128000 | 8192"
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
        <button type="button" id="custom-provider-cancel" @click=${closeProvider}>Cancel</button
        ><button class="primary" id="custom-provider-save" ?disabled=${provider.saving} @click=${saveProvider}>
          Save provider
        </button>
      </div>
    </dialog>
  `;
}
export function mountProviders() {
  redraw = mountTemplate('template[data-settings-card="custom-provider-dialog"]', template);
}

function keyLabel(p: any, compact: boolean) {
  const text = p.hasKey ? "set (write-only)" : "none";
  return compact ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
