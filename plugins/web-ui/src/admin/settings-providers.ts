import { settingsRow, settingsSection } from "../settings-layout.ts";
import { formField, switchField } from "./setting-controls.ts";
import { html, nothing } from "lit";
import type { AdminPage } from "./sections.ts";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
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
export function providersCard() {
  return html`${settingsSection(
    "Custom providers",
    provider.rows.length
      ? repeat(
          provider.rows,
          (p) => p.id,
          (p) =>
            settingsRow(
              p.name,
              [
                p.id,
                labels[p.protocol] || p.protocol,
                p.baseUrl,
                `${p.models.length} ${p.models.length === 1 ? "model" : "models"}`,
                p.hasKey ? "Key set" : "No key",
              ].join(" · "),
              html`<span class="settings-row-actions">
                <button class="btn" type="button" @click=${() => openProvider(p)}>Edit</button
                ><button class="btn danger" type="button" @click=${() => removeProvider(p)}>Remove</button>
              </span>`,
            ),
        )
      : settingsRow(
          html`<span id="custom-provider-summary">No custom providers</span>`,
          "OpenAI Chat Completions, OpenAI Responses or Anthropic Messages endpoints. Their models join every picker.",
          nothing,
        ),
    {
      id: "card-custom-providers",
      action: html`<button class="btn" type="button" id="add-custom-provider" @click=${() => openProvider()}>
        + Add provider
      </button>`,
    },
  )}
  ${providerDialog()}`;
}

const input = (key: string, label: string, help: string, o: Parameters<typeof formField>[5] = {}) =>
  formField(label, help, "custom-provider-" + key, provider.draft[key] || "", (v) => changeProvider(key, v), o);
function providerDialog() {
  return html`
    <dialog
      @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) closeProvider();
      }}
      @cancel=${() => closeProvider()}
      class="custom-provider-dialog cd"
      id="custom-provider-dialog"
      aria-labelledby="custom-provider-title"
    >
      <header class="cd-head">
        <h2 id="custom-provider-title">
          ${provider.editing ? "Edit " + provider.originalName : "Add custom provider"}
        </h2>
        <p>Connect an OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages endpoint.</p>
      </header>
      <div class="cd-body">
        <section class="cd-section">
          <h3>Provider</h3>
          ${input("name", "Name", "", { placeholder: "LiteLLM" })}
          ${input("id", "Identifier", provider.editing ? "Can't be changed after the provider is created." : "A short slug, such as litellm.", { placeholder: "litellm", disabled: provider.editing })}
          <label class="form-field"
            ><span class="form-label">Protocol</span
            ><select
              id="custom-provider-protocol"
              .value=${provider.draft.protocol || ""}
              @input=${(e: Event) => changeProvider("protocol", (e.target as HTMLInputElement).value)}
            >
              <option value="openai">OpenAI Chat Completions</option>
              <option value="openai-responses">OpenAI Responses</option>
              <option value="anthropic">Anthropic Messages</option>
            </select></label
          >
        </section>
        <section class="cd-section">
          <h3>Connection</h3>
          ${input("url", "Base URL", "", { placeholder: "https://gateway.internal/v1" })}
          ${input("key", "API key", provider.editing ? "Write-only. Leave blank to keep the stored key." : "Write-only. It can't be viewed after saving.", { type: "password", placeholder: provider.editing ? "••••••••  (unchanged)" : "Paste the key" })}
          <div class="settings-card">
            ${switchField("custom-provider-validate", "Validate the key", "Checks it against the endpoint before saving.", !!provider.draft.validate, (on) => changeProvider("validate", on))}
          </div>
        </section>
        <section class="cd-section">
          <h3>Models</h3>
          <label class="form-field"
            ><span class="form-label">Models</span
            ><textarea
              id="custom-provider-models"
              .value=${provider.draft.models || ""}
              @input=${(e: Event) => changeProvider("models", (e.target as HTMLInputElement).value)}
              rows="4"
              placeholder="deepseek-chat | DeepSeek V3.2 | 128000 | 8192 | true"
            ></textarea
            ><span class="form-help"
              >One per line: id | name | context | max tokens | reasoning (true or false).</span
            ></label
          >
        </section>
      </div>
      <footer class="cd-foot">
        <span class="cd-spacer"></span
        ><span
          class=${classMap({ status: true, err: provider.error, saving: provider.saving })}
          id="st-custom-provider"
          aria-live="polite"
          >${provider.message}</span
        ><button class="btn" type="button" id="custom-provider-cancel" @click=${closeProvider}>Cancel</button
        ><button
          class="btn primary"
          type="button"
          id="custom-provider-save"
          ?disabled=${provider.saving}
          @click=${saveProvider}
        >
          ${provider.editing ? "Save" : "Add provider"}
        </button>
      </footer>
    </dialog>
  `;
}
