import { html, nothing, type TemplateResult } from "lit";
import { History, RotateCcw } from "lucide";
import { api, type ProjectIcon } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./icons";
import { projectIconTpl } from "./project-icon";
import { canvasToast } from "./split";

type VersionField = "name" | "description" | "instructions" | "icon";

interface VersionSummary {
  version: number;
  changed: VersionField[];
  restoredFrom?: number;
  editedBy: string;
  editedAt: number | string;
}

interface Version extends VersionSummary {
  name: string;
  description: string;
  instructions: string;
  icon?: ProjectIcon;
}

interface HistoryEntry {
  open: boolean;
  versions: VersionSummary[] | null;
  more: boolean;
  loading: boolean;
  viewing: number | null;
  details: Map<number, { version: Version; previous: Version | null } | "loading">;
  error: string;
}

export interface HistoryPersona {
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
}

const FIELD_LABELS: Record<VersionField, string> = {
  name: "name",
  description: "description",
  instructions: "instructions",
  icon: "icon",
};

const historyState = new Map<string, HistoryEntry>();

function historyFor(id: string): HistoryEntry {
  let entry = historyState.get(id);
  if (!entry) {
    entry = { open: false, versions: null, more: false, loading: false, viewing: null, details: new Map(), error: "" };
    historyState.set(id, entry);
  }
  return entry;
}

function reset(entry: HistoryEntry): void {
  entry.versions = null;
  entry.more = false;
  entry.viewing = null;
  entry.details.clear();
  entry.error = "";
}

const base = (id: string) => `/api/personas/${encodeURIComponent(id)}/versions`;

async function loadPage(persona: HistoryPersona, redraw: () => void): Promise<void> {
  const entry = historyFor(persona.id);
  const before = entry.versions?.at(-1)?.version;
  entry.loading = true;
  redraw();
  try {
    const page = await api<{ versions: VersionSummary[]; more: boolean }>(
      `${base(persona.id)}${before ? `?before=${before}` : ""}`,
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

async function loadDetail(persona: HistoryPersona, version: number, redraw: () => void): Promise<void> {
  const entry = historyFor(persona.id);
  entry.details.set(version, "loading");
  try {
    entry.details.set(
      version,
      await api<{ version: Version; previous: Version | null }>(`${base(persona.id)}/${version}`),
    );
  } catch (e) {
    entry.details.delete(version);
    entry.error = errMessage(e, "Couldn't load that version.");
  }
  redraw();
}

type DiffLine = { kind: "same" | "add" | "del"; text: string };

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "same", text: a[i++]! });
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!))
      out.push({ kind: "del", text: a[i++]! });
    else out.push({ kind: "add", text: b[j++]! });
  }
  return out;
}

const DIFF_MARK = { add: "+ ", del: "- ", same: "  " } as const;

function instructionsTpl(version: Version, previous: Version | null): TemplateResult | typeof nothing {
  if (!previous) return html`<pre class="persona-diff" dir="auto">${version.instructions || "No instructions."}</pre>`;
  if (previous.instructions === version.instructions) return nothing;
  const lines = lineDiff(previous.instructions, version.instructions);
  const near = (index: number) => lines.slice(Math.max(0, index - 2), index + 3).some((l) => l.kind !== "same");
  return html`<pre class="persona-diff" aria-label="Instruction changes">
${lines
  .filter((line, index) => line.kind !== "same" || near(index))
  .map((line) => html`<span class="persona-diff-${line.kind}">${DIFF_MARK[line.kind]}${line.text}</span>`)}</pre>`;
}

function changesTpl(detail: { version: Version; previous: Version | null }): TemplateResult {
  const { version, previous } = detail;
  const changed = new Set(version.changed);
  return html`<div class="persona-version-changes">
    ${changed.has("name") ? html`<div><b>Name</b> <span dir="auto">${version.name}</span></div>` : nothing}
    ${
      previous && changed.has("icon")
        ? html`<div><b>Icon</b> ${projectIconTpl(version.icon, 16) ?? html`<span class="hint">default</span>`}</div>`
        : nothing
    }
    ${
      changed.has("description")
        ? html`<div><b>Description</b> <span dir="auto">${version.description || "—"}</span></div>`
        : nothing
    }
    ${instructionsTpl(version, previous)}
  </div>`;
}

function detailTpl(detail: { version: Version; previous: Version | null } | "loading" | undefined): TemplateResult {
  if (!detail || detail === "loading") return html`<p class="hint" role="status">Loading…</p>`;
  return changesTpl(detail);
}

function summaryLine(version: VersionSummary): string {
  if (version.restoredFrom) return `rolled back to v${version.restoredFrom}`;
  if (version.version === 1) return "created";
  return version.changed.length ? `changed ${version.changed.map((f) => FIELD_LABELS[f]).join(", ")}` : "";
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
    if (entry.viewing !== null && !entry.details.has(version)) void loadDetail(persona, version, redraw);
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
      canvasToast(errMessage(e, "Couldn't roll back."));
    }
  };
  const row = (version: VersionSummary) => {
    const viewing = entry.viewing === version.version;
    const detail = entry.details.get(version.version);
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
          ${summaryLine(version) ? html`<span class="hint">· ${summaryLine(version)}</span>` : nothing}
        </button>
        ${
          version.version !== persona.version && opts.canEdit
            ? html`<button class="btn persona-action" type="button" @click=${() => void restore(version.version)}>
                ${icon(RotateCcw, 14)}<span>Roll back</span>
              </button>`
            : nothing
        }
      </div>
      ${viewing ? detailTpl(detail) : nothing}
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
