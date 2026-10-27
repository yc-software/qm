import { html } from "lit";
import { Pencil, Trash2 } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { appState } from "./shell";
import { artifactPage, listPageTpl } from "./list-page";
import { tip } from "./tooltip";

interface Fact {
  id: string;
  text: string;
  createdAt: number;
}

let facts: Fact[] = [];
let notice = "";
let busy = false;
let editing: { id: string; text: string } | null = null;
const page = artifactPage("memory", "memory-page", "memory");

export function resetMemoryState(): void {
  facts = [];
  notice = "";
  busy = false;
  page.query = "";
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
    return html`<div class="list-row memory-fact editing">
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
  return html`<div class="list-row memory-fact">
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
  page.paint(
    listPageTpl({
      title: "Memory",
      search: {
        value: page.query,
        placeholder: "Search remembered facts",
        onInput: (value) => {
          page.query = value;
          drawMemory();
        },
      },
      notice: notice || (loading ? "Loading…" : ""),
      rows: facts.filter((fact) => page.matches(fact.text)).map(factRow),
      empty: page.query ? "No remembered facts match this search." : "The agent hasn’t noted any facts yet.",
    }),
    () => drawMemory(),
  );
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
