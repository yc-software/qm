import { html, nothing, type TemplateResult } from "lit";
import { History, RotateCcw } from "lucide";
import { api, type ProjectIcon } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { projectIconTpl } from "./project-icon";

interface Version {
  version: number;
  name: string;
  description: string;
  instructions: string;
  icon?: ProjectIcon;
  restoredFrom?: number;
  editedBy: string;
  editedAt: number | string;
}

interface HistoryEntry {
  open: boolean;
  versions: Version[] | null;
  more: boolean;
  loading: boolean;
  viewing: number | null;
  error: string;
}

interface HistoryPersona {
  id: string;
  name: string;
  version: number;
}

export interface HistoryOptions {
  persona: HistoryPersona;
  canEdit: boolean;
  action: (label: string, glyph: Parameters<typeof icon>[0], run: () => void) => TemplateResult;
  redraw: () => void;
  restored: (persona: unknown, flash: string) => void;
  failed: (message: string) => void;
}

const PAGE = 20;

const historyState = new Map<string, HistoryEntry>();

function historyFor(id: string): HistoryEntry {
  let entry = historyState.get(id);
  if (!entry) {
    entry = { open: false, versions: null, more: false, loading: false, viewing: null, error: "" };
    historyState.set(id, entry);
  }
  return entry;
}

function reset(entry: HistoryEntry): void {
  entry.versions = null;
  entry.more = false;
  entry.viewing = null;
  entry.error = "";
}

const base = (id: string) => `/api/personas/${encodeURIComponent(id)}/versions`;

async function loadPage(persona: HistoryPersona, redraw: () => void): Promise<void> {
  const entry = historyFor(persona.id);
  const before = entry.versions?.at(-1)?.version;
  entry.loading = true;
  redraw();
  try {
    const page = await api<{ versions: Version[]; more: boolean }>(
      `${base(persona.id)}?full=1&limit=${PAGE}${before ? `&before=${before}` : ""}`,
    );
    entry.versions = [...(entry.versions ?? []), ...page.versions];
    entry.more = page.more;
    entry.error = "";
  } catch (e) {
    entry.versions ??= [];
    entry.error = errMessage(e, "Couldn't load history.");
  }
  entry.loading = false;
  redraw();
}

function fieldTpl(label: string, value: TemplateResult | string): TemplateResult {
  return html`<div class="persona-version-field">
    <b>${label}</b>
    <div dir="auto">${value}</div>
  </div>`;
}

function versionTpl(version: Version): TemplateResult {
  return html`<div class="persona-version-changes">
    ${fieldTpl("Name", version.name)} ${fieldTpl("Icon", projectIconTpl(version.icon, 16) ?? "Default")}
    ${fieldTpl("Description", version.description || "—")}
    ${fieldTpl(
      "Instructions",
      html`<pre class="persona-version-text">${version.instructions || "No instructions."}</pre>`,
    )}
  </div>`;
}

function summaryLine(version: Version): string {
  if (version.restoredFrom) return `rolled back to v${version.restoredFrom}`;
  return version.version === 1 ? "created" : "";
}

export function historySectionTpl(opts: HistoryOptions): TemplateResult {
  const { persona, redraw } = opts;
  const entry = historyFor(persona.id);
  if (entry.open && entry.versions === null && !entry.loading) void loadPage(persona, redraw);
  const toggle = () => {
    entry.open = !entry.open;
    reset(entry);
    redraw();
  };
  const view = (version: number) => {
    entry.viewing = entry.viewing === version ? null : version;
    redraw();
  };
  const restore = async (version: number) => {
    if (!window.confirm(`Roll ${persona.name} back to version ${version}? This saves it as a new version.`)) return;
    try {
      const r = await api<{ persona: unknown }>(`${base(persona.id)}/${version}/restore`, {
        method: "POST",
        body: "{}",
      });
      reset(entry);
      opts.restored(r.persona, `Rolled back to version ${version}.`);
    } catch (e) {
      opts.failed(errMessage(e, "Couldn't roll back."));
    }
  };
  const row = (version: Version) => {
    const viewing = entry.viewing === version.version;
    const summary = summaryLine(version);
    return html`<div class="persona-version">
      <div class="persona-version-row">
        <button
          class="persona-version-open"
          type="button"
          aria-expanded=${viewing ? "true" : "false"}
          @click=${() => view(version.version)}
        >
          <strong>v${version.version}</strong>
          ${version.version === persona.version ? html`<span class="badge ok">Current</span>` : nothing}
          <span class="hint">${new Date(version.editedAt).toLocaleString()} · ${version.editedBy}</span>
          ${summary ? html`<span class="hint">· ${summary}</span>` : nothing}
        </button>
        ${
          version.version !== persona.version && opts.canEdit
            ? html`<button class="btn persona-action" type="button" @click=${() => void restore(version.version)}>
                ${icon(RotateCcw, 14)}<span>Roll back</span>
              </button>`
            : nothing
        }
      </div>
      ${viewing ? versionTpl(version) : nothing}
    </div>`;
  };
  const body = () => {
    if (!entry.open) return nothing;
    if (entry.versions === null) return html`<p class="hint" role="status">Loading history…</p>`;
    return html`<div class="persona-skill-list persona-version-list">${entry.versions.map(row)}</div>
      ${
        entry.more
          ? html`<button
              class="btn persona-action"
              type="button"
              ?disabled=${entry.loading}
              @click=${() => void loadPage(persona, redraw)}
            >
              ${entry.loading ? "Loading…" : "Show older"}
            </button>`
          : nothing
      }
      ${entry.error ? html`<p class="composer-error" role="alert">${entry.error}</p>` : nothing}`;
  };
  return html`<section class="persona-section">
    <div class="persona-section-head">
      <h3>History</h3>
      <div class="persona-section-actions">
        ${opts.action(
          entry.open ? "Hide" : `Show ${persona.version} version${persona.version === 1 ? "" : "s"}`,
          History,
          toggle,
        )}
      </div>
    </div>
    ${body()}
  </section>`;
}
