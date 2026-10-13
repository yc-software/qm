import { html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { saveFooter } from "./setting-controls.ts";
import type { SettingState } from "./setting-state.ts";

type Model = { id: string; name: string; provider: string };
type MemoryState = SettingState & { context: Record<string, any>; change(field: string, value: unknown): void };
const source = (model: Model) => (model.provider === "qm:gateway" ? "model gateway" : "OpenAI, organization key");

function mode(saved: string, models: Model[]) {
  const active = models.find((model) => model.id === saved);
  if (active)
    return html`<strong>Relevance ranking.</strong> ${active.name} (${source(active)}) ranks saved facts by similarity
      to the current message and recent conversation. A turn whose embedding request fails uses the newest facts.`;
  if (saved)
    return html`<strong>Recency fallback.</strong> ${saved} is unavailable (deleted, unverified, or not offered by the
      gateway right now), so recall uses the newest facts until it returns or another model is selected.`;
  return html`<strong>Recency.</strong> No embedding model is selected, so recall uses the newest facts that fit.`;
}

export function memoryCard(s: MemoryState) {
  const models: Model[] = s.context.memoryEmbeddingOptions || [];
  const saved: string = JSON.parse(s.baseline).modelId || "";
  const options =
    saved && !models.some((model) => model.id === saved) ? [...models, { id: saved, name: saved }] : models;
  return html`<section
    class=${classMap({ card: true, "sv-models": true, hidden: !s.available, dirty: s.dirty })}
    id="card-memory-recall"
  >
    <div class="head">
      <h2>Memory recall</h2>
      <p>
        Each turn carries up to 6,000 characters of saved memory. An embedding model picks the most relevant facts;
        without one, the newest facts are used.
      </p>
    </div>
    <div class="body">
      <p class="hint" id="memory-recall-mode">${mode(saved, models)}</p>
      <label for="memory-embedding-model">Embedding model</label
      ><select
        id="memory-embedding-model"
        .value=${s.draft.modelId || ""}
        @change=${(e: Event) => s.change("modelId", (e.target as HTMLSelectElement).value)}
      >
        <option value="" ?selected=${!s.draft.modelId}>None (use newest facts)</option>
        ${options.map((m) => html`<option value=${m.id} ?selected=${m.id === s.draft.modelId}>${"provider" in m ? `${m.name} · ${source(m)}` : `${m.name} (unavailable)`}</option>`)}
      </select>
      <p class="hint">
        Gateway embedding models appear automatically. Register an OpenAI embedding model under Onboarding → Models on
        existing providers; it uses the organization OpenAI key.
      </p>
    </div>
    ${saveFooter(s)}
  </section>`;
}
