import { html, nothing, render } from "lit";
import { Clock3, Pencil, RefreshCw, Search, Trash2 } from "lucide";
import { api, ApiError } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { appState, replacePanePreservingFocus } from "./shell";
import { locale, t } from "./i18n";

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
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

function drawMemory(loading = false): void {
  if (appState.currentView !== "memory" || !appState.mainEl) return;
  const dirty = memoryDraft !== memorySaved;
  const visible = facts(memoryDraft).filter(
    (fact) => !search || fact.text.toLowerCase().includes(search.toLowerCase()),
  );
  const host = document.createElement("div");
  host.className = "pane";
  render(
    html`
      <div class="pane-head">
        <div>
          <h1 class="pane-title">${t("memory.title")}</h1>
          <div class="pane-subtitle">${t("memory.subtitle")}</div>
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
            ${icon(Pencil, 15)} ${rawEditing ? t("memory.facts") : t("memory.edit")}
          </button>
          <button class="btn" type="button" @click=${() => void toggleHistory()}>${icon(Clock3, 15)} ${t("memory.history")}</button>
          <button
            class="pane-refresh"
            type="button"
            aria-label=${t("memory.refresh")}
            title=${t("memory.refresh")}
            @click=${() => void renderMemory(true)}
          >
            ${icon(RefreshCw, 17)}
          </button>
        </div>
      </div>
      ${memoryNotice || loading ? html`<div class="status">${memoryNotice || t("memory.loading")}</div>` : nothing}
      <div class="memory-editor">
        <p class="memory-help">
          ${t("memory.help")}
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
                    aria-label=${t("memory.search")}
                    type="search"
                    placeholder=${t("memory.searchPlaceholder")}
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
                                ${fact.date ? html`<div class="card-meta">${t("memory.captured", { date: fact.date })}</div>` : nothing}
                              </div>
                              <button
                                class="icon-btn"
                                type="button"
                                aria-label=${t("memory.forget")}
                                title=${t("memory.forget")}
                                @click=${() => removeFact(fact.line)}
                              >
                                ${icon(Trash2, 15)}
                              </button>
                            </div>`,
                        )
                      : html`<div class="empty-state">
                          ${search ? t("memory.noMatches") : t("memory.empty")}
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
            ${memorySaving ? t("memory.saving") : t("memory.saveChanges")}
          </button>
          <span class="memory-hint">${dirty && !memorySaving ? t("memory.unsaved") : ""}</span>
        </div>
        ${
          historyOpen
            ? html` <section class="memory-history">
                <h2>${t("memory.revisionHistory")}</h2>
                ${
                  history.length
                    ? history.map(
                        (row, i) =>
                          html` <div class="memory-revision">
                            <div>
                              <strong>${i === 0 ? t("memory.current") : t("memory.revision", { revision: row.revision })}</strong>
                              <div class="card-meta">
                                ${fmtDate(row.at)} · ${row.author || t("memory.automaticCapture")} · ${row.operation}
                              </div>
                            </div>
                            ${i ? html`<button class="btn" type="button" @click=${() => requestRestoreRevision(row)}>${t("memory.restore")}</button>` : nothing}
                          </div>`,
                      )
                    : html`<div class="empty-state">${t("memory.historyUnavailable")}</div>`
                }
              </section>`
            : nothing
        }
        ${
          memoryConfirmation
            ? html` <section class="card memory-confirm" role="alertdialog" aria-labelledby="memory-confirm-title">
                <div class="card-head">
                  <h2 class="card-title" id="memory-confirm-title">${memoryConfirmation.title}</h2>
                  <span class="badge warn">${t("memory.checkImpact")}</span>
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
                    ${t("memory.cancel")}
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
      title: t("memory.discardTitle"),
      body: t("memory.discardBody"),
      action: t("memory.discardRefresh"),
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
    memoryNotice = errMessage(e, t("memory.loadFailed"));
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
    memoryNotice = t("memory.saved");
    if (historyOpen) {
      try {
        await loadHistory();
      } catch {
        memoryNotice = t("memory.savedHistoryFailed");
      }
    }
  } catch (e) {
    memoryNotice =
      e instanceof ApiError && e.status === 409
        ? t("memory.changedElsewhere")
        : errMessage(e, t("memory.saveFailed"));
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
      memoryNotice = errMessage(e, t("memory.historyLoadFailed"));
    }
  }
  drawMemory();
}

function requestRestoreRevision(row: RevisionRow): void {
  memoryConfirmation = {
    title: t("memory.restoreTitle", { date: fmtDate(row.at) }),
    body: t("memory.restoreBody"),
    action: t("memory.restoreRevision"),
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
    memoryNotice = t("memory.restored");
    try {
      await loadHistory();
    } catch {
      memoryNotice = t("memory.restoredHistoryFailed");
    }
  } catch (e) {
    memoryNotice = errMessage(e, t("memory.restoreFailed"));
  }
  drawMemory();
}
