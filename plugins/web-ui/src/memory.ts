import { html, nothing, render } from "lit";
import { Pencil, Search, Trash2 } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { appState, replacePanePreservingFocus } from "./shell";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { tip } from "./tooltip";

interface Fact {
  id: string;
  text: string;
  createdAt: number;
}

let facts: Fact[] = [];
let notice = "";
let busy = false;
let search = "";
let editing: { id: string; text: string } | null = null;

export function resetMemoryState(): void {
  facts = [];
  notice = "";
  busy = false;
  search = "";
  editing = null;
}

async function change(method: "PATCH" | "DELETE", body: object, done: string): Promise<void> {
  busy = true;
  notice = "";
  drawMemory();
  try {
    facts = (await api<{ facts?: Fact[] }>("/api/memory", { method, body: JSON.stringify(body) })).facts ?? [];
    editing = null;
    notice = done;
  } catch (e) {
    notice = errMessage(e, "Failed to save memory.");
  } finally {
    busy = false;
    drawMemory();
  }
}

function factRow(fact: Fact) {
  const { text } = fact;
  if (editing?.id === fact.id)
    return html`<div class="memory-fact editing">
      <textarea
        class="memory-text"
        data-focus-key="memory-edit"
        ?disabled=${busy}
        .value=${editing.text}
        @input=${(e: Event) => (editing = { id: fact.id, text: (e.target as HTMLTextAreaElement).value })}
      ></textarea>
      <div class="memory-actions">
        <button
          class="btn primary"
          type="button"
          ?disabled=${busy || !editing.text.trim()}
          @click=${() => void change("PATCH", { facts: [editing!] }, "Saved ✓")}
        >
          Save
        </button>
        <button
          class="btn"
          type="button"
          @click=${() => {
            editing = null;
            drawMemory();
          }}
        >
          Cancel
        </button>
      </div>
    </div>`;
  return html`<div class="memory-fact">
    <div>
      <div>${text}</div>
      <div class="card-meta">Captured ${new Date(fact.createdAt).toISOString().slice(0, 10)}</div>
    </div>
    <button
      class="icon-btn"
      type="button"
      aria-label="Edit this fact"
      ${tip("Edit this fact")}
      @click=${() => {
        editing = { id: fact.id, text };
        drawMemory();
      }}
    >
      ${icon(Pencil, 15)}
    </button>
    <button
      class="icon-btn"
      type="button"
      aria-label="Forget this fact"
      ${tip("Forget this fact")}
      ?disabled=${busy}
      @click=${() => void change("DELETE", { ids: [fact.id] }, "Forgotten ✓")}
    >
      ${icon(Trash2, 15)}
    </button>
  </div>`;
}

function drawMemory(loading = false): void {
  if (appState.currentView !== "memory" || !appState.mainEl) return;
  const visible = facts.filter((fact) => !search || fact.text.toLowerCase().includes(search.toLowerCase()));
  const host = document.createElement("div");
  host.className = scopedSession.active ? "pane scoped-view" : "pane";
  render(
    html`
      ${scopedViewTopbar("memory", () => drawMemory())}
      <div class="list-page-head">
        <div>
          <h1 class="pane-title">Memory</h1>
        </div>
        <label class="list-search"
          >${icon(Search, 16)}<input
            data-focus-key="memory-search"
            aria-label="Search memory"
            type="search"
            placeholder="Search remembered facts"
            .value=${search}
            @input=${(e: Event) => {
              search = (e.target as HTMLInputElement).value;
              drawMemory();
            }}
        /></label>
      </div>
      ${notice || loading ? html`<div class="status">${notice || "Loading…"}</div>` : nothing}
      <div class="memory-editor">
        <div class="memory-facts">
          ${
            visible.length
              ? visible.map(factRow)
              : html`<div class="empty-state">
                  ${search ? "No remembered facts match this search." : "The agent hasn’t noted any facts yet."}
                </div>`
          }
        </div>
      </div>
    `,
    host,
  );
  replacePanePreservingFocus(host);
}

export async function renderMemory(): Promise<void> {
  if (appState.currentView !== "memory") return;
  if (editing) return void drawMemory();
  const seq = appState.viewRenderSeq;
  notice = "";
  drawMemory(true);
  try {
    const r = await api<{ facts?: Fact[] }>("/api/memory");
    if (seq !== appState.viewRenderSeq || appState.currentView !== "memory") return;
    facts = r.facts ?? [];
  } catch (e) {
    if (seq !== appState.viewRenderSeq || appState.currentView !== "memory") return;
    notice = errMessage(e, "Failed to load memory.");
  }
  drawMemory();
}
