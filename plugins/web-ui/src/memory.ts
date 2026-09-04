import { html, nothing, render } from "lit";
import { Clock3, Pencil, RefreshCw, Search, Trash2 } from "lucide";
import { api, ApiError } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { appState, replacePanePreservingFocus } from "./shell";
import { scopedSession, scopedViewTopbar } from "./session-scope";

interface RevisionRow {
  revision: string;
  content: string;
  operation: string;
  author?: string;
  at: number;
}

let memoryDraft = "";
let memorySaved = "";
let memoryRevision = "";
let memoryNotice = "";
let memorySaving = false;
let memoryLoaded = false;
let rawEditing = true;
let search = "";
let historyOpen = false;
let history: RevisionRow[] = [];
let memoryConfirmation: { title: string; body: string; action: string; run: () => Promise<void> } | null = null;

export function resetMemoryState(): void {
  memoryDraft = "";
  memorySaved = "";
  memoryRevision = "";
  memoryNotice = "";
  memorySaving = false;
  memoryLoaded = false;
  rawEditing = true;
  search = "";
  historyOpen = false;
  history = [];
  memoryConfirmation = null;
}

function facts(content: string): Array<{ line: number; text: string; date?: string }> {
  return content.split("\n").flatMap((row, line) => {
    const match = row.match(/^\s*[-*]\s+(?:\((\d{4}-\d{2}-\d{2})\)\s*)?(.*\S)\s*$/);
    return match ? [{ line, ...(match[1] ? { date: match[1] } : {}), text: match[2]! }] : [];
  });
}

function removeFact(line: number): void {
  const lines = memoryDraft.split("\n");
  lines.splice(line, 1);
  memoryDraft = lines.join("\n");
  drawMemory();
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function drawMemory(loading = false): void {
  if (appState.currentView !== "memory" || !appState.mainEl) return;
  const dirty = memoryDraft !== memorySaved;
  const visible = facts(memoryDraft).filter(
    (fact) => !search || fact.text.toLowerCase().includes(search.toLowerCase()),
  );
  const host = document.createElement("div");
  host.className = scopedSession.active ? "pane scoped-view" : "pane";
  render(
    html`
      ${scopedViewTopbar("memory", () => drawMemory())}
      <div class="pane-head">
        <div>
          <h1 class="pane-title">Memory</h1>
          <div class="pane-subtitle">Facts the agent carries into your conversations.</div>
        </div>
        <div class="pane-head-actions">
          <button
            class="btn"
            type="button"
            @click=${() => {
              rawEditing = !rawEditing;
              drawMemory();
            }}
          >
            ${icon(Pencil, 15)} ${rawEditing ? "Facts view" : "Edit notebook"}
          </button>
          <button class="btn" type="button" @click=${() => void toggleHistory()}>${icon(Clock3, 15)} History</button>
          <button
            class="pane-refresh"
            type="button"
            aria-label="Refresh memory"
            title="Refresh memory"
            @click=${() => void renderMemory(true)}
          >
            ${icon(RefreshCw, 17)}
          </button>
        </div>
      </div>
      ${memoryNotice || loading ? html`<div class="status">${memoryNotice || "Loading…"}</div>` : nothing}
      <div class="memory-editor">
        <p class="memory-help">
          Edit the notebook directly. Switch to Facts view to search or remove individual facts. Saves are protected if
          the agent remembers something new while this page is open.
        </p>
        ${
          rawEditing
            ? html`<textarea
                class="memory-text"
                data-focus-key="memory-raw"
                spellcheck="false"
                ?disabled=${loading || memorySaving}
                @input=${(e: Event) => {
                  memoryDraft = (e.target as HTMLTextAreaElement).value;
                  drawMemory();
                }}
                .value=${memoryDraft}
              ></textarea>`
            : html` <label class="memory-search"
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
                <div class="memory-facts">
                  ${
                    visible.length
                      ? visible.map(
                          (fact) =>
                            html`<div class="memory-fact">
                              <div>
                                <div>${fact.text}</div>
                                ${fact.date ? html`<div class="card-meta">Captured ${fact.date}</div>` : nothing}
                              </div>
                              <button
                                class="icon-btn"
                                type="button"
                                aria-label="Forget this fact"
                                title="Forget this fact"
                                @click=${() => removeFact(fact.line)}
                              >
                                ${icon(Trash2, 15)}
                              </button>
                            </div>`,
                        )
                      : html`<div class="empty-state">
                          ${search ? "No remembered facts match this search." : "The agent hasn’t noted any facts yet."}
                        </div>`
                  }
                </div>`
        }
        <div class="memory-actions">
          <button
            class="btn primary memory-save"
            type="button"
            ?disabled=${loading || memorySaving || !dirty}
            @click=${() => void saveMemory()}
          >
            ${memorySaving ? "Saving…" : "Save changes"}
          </button>
          <span class="memory-hint">${dirty && !memorySaving ? "Unsaved changes" : ""}</span>
        </div>
        ${
          historyOpen
            ? html` <section class="memory-history">
                <h2>Revision history</h2>
                ${
                  history.length
                    ? history.map(
                        (row, i) =>
                          html` <div class="memory-revision">
                            <div>
                              <strong>${i === 0 ? "Current" : `Revision ${row.revision}`}</strong>
                              <div class="card-meta">
                                ${fmtDate(row.at)} · ${row.author || "automatic capture"} · ${row.operation}
                              </div>
                            </div>
                            ${i ? html`<button class="btn" type="button" @click=${() => requestRestoreRevision(row)}>Restore</button>` : nothing}
                          </div>`,
                      )
                    : html`<div class="empty-state">Revision history is unavailable for this memory store.</div>`
                }
              </section>`
            : nothing
        }
        ${
          memoryConfirmation
            ? html` <section class="card memory-confirm" role="alertdialog" aria-labelledby="memory-confirm-title">
                <div class="card-head">
                  <h2 class="card-title" id="memory-confirm-title">${memoryConfirmation.title}</h2>
                  <span class="badge warn">Check impact</span>
                </div>
                <p class="memory-help">${memoryConfirmation.body}</p>
                <div class="actions">
                  <button class="btn danger" type="button" @click=${() => void memoryConfirmation?.run()}>
                    ${memoryConfirmation.action}</button
                  ><button
                    class="btn"
                    type="button"
                    @click=${() => {
                      memoryConfirmation = null;
                      drawMemory();
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </section>`
            : nothing
        }
      </div>
    `,
    host,
  );
  replacePanePreservingFocus(host);
}

export async function renderMemory(force = false): Promise<void> {
  if (appState.currentView !== "memory") return;
  const dirty = memoryLoaded && memoryDraft !== memorySaved;
  if (dirty && !force) return void drawMemory();
  if (dirty && force) {
    memoryConfirmation = {
      title: "Discard unsaved memory changes?",
      body: "Refreshing will replace this draft with the latest memory. Copy anything you want to keep before continuing.",
      action: "Discard and refresh",
      run: async () => {
        memoryConfirmation = null;
        memoryDraft = memorySaved;
        await renderMemory(true);
      },
    };
    return void drawMemory();
  }
  const seq = appState.viewRenderSeq;
  memoryNotice = "";
  drawMemory(true);
  try {
    const r = await api<{ content?: string; revision?: string }>("/api/memory");
    if (seq !== appState.viewRenderSeq || appState.currentView !== "memory") return;
    memorySaved = r.content ?? "";
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? "";
    memoryLoaded = true;
  } catch (e) {
    if (seq !== appState.viewRenderSeq || appState.currentView !== "memory") return;
    memoryNotice = errMessage(e, "Failed to load memory.");
  }
  drawMemory();
}

async function saveMemory(): Promise<void> {
  if (memorySaving) return;
  memorySaving = true;
  memoryNotice = "";
  drawMemory();
  try {
    const r = await api<{ content?: string; revision?: string }>("/api/memory", {
      method: "PUT",
      body: JSON.stringify({ content: memoryDraft, revision: memoryRevision }),
    });
    memorySaved = r.content ?? memoryDraft;
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? memoryRevision;
    memoryNotice = "Saved ✓";
    if (historyOpen) {
      try {
        await loadHistory();
      } catch {
        memoryNotice = "Saved ✓ History could not refresh.";
      }
    }
  } catch (e) {
    memoryNotice =
      e instanceof ApiError && e.status === 409
        ? "Memory changed in another conversation. Your draft is still here; copy it if needed, then refresh to merge with the latest version."
        : errMessage(e, "Failed to save memory.");
  } finally {
    memorySaving = false;
    drawMemory();
  }
}

async function loadHistory(): Promise<void> {
  const r = await api<{ revisions?: RevisionRow[] }>("/api/memory/history");
  history = r.revisions ?? [];
}

async function toggleHistory(): Promise<void> {
  historyOpen = !historyOpen;
  if (historyOpen) {
    try {
      await loadHistory();
    } catch (e) {
      memoryNotice = errMessage(e, "Failed to load memory history.");
    }
  }
  drawMemory();
}

function requestRestoreRevision(row: RevisionRow): void {
  memoryConfirmation = {
    title: `Restore memory from ${fmtDate(row.at)}?`,
    body: "The selected notebook will become current. The version you have now remains available in history.",
    action: "Restore revision",
    run: async () => {
      memoryConfirmation = null;
      await restoreRevision(row);
    },
  };
  drawMemory();
}

async function restoreRevision(row: RevisionRow): Promise<void> {
  try {
    const r = await api<{ content?: string; revision?: string }>("/api/memory/restore", {
      method: "POST",
      body: JSON.stringify({ revision: row.revision, expectedRevision: memoryRevision }),
    });
    memorySaved = r.content ?? "";
    memoryDraft = memorySaved;
    memoryRevision = r.revision ?? memoryRevision;
    memoryNotice = "Revision restored ✓";
    try {
      await loadHistory();
    } catch {
      memoryNotice = "Revision restored ✓ History could not refresh.";
    }
  } catch (e) {
    memoryNotice = errMessage(e, "Could not restore that revision.");
  }
  drawMemory();
}
