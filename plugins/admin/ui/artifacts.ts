import { html, nothing, render } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { card, bareCard, table, renderer } from "./shared.ts";
import { mountPacks, skillDetail, removeSkill } from "./artifacts-skills.ts";
export type Data = Record<string, any>;
export type Context = Record<string, any>;
type Row = {
  name: unknown;
  preview?: unknown;
  time?: unknown;
  href?: string;
  target?: string;
  cls?: string;
  icon?: unknown;
};
const empty = (text: string) => html`<p class="empty">${text}</p>`;
export const badge = (text: unknown, tone = "muted") => html`<span class=${"badge " + tone}>${text}</span>`;
const queries = new Map<string, string>();
export function dense(items: Data[], rowOf: (item: Data) => Row, open: (item: Data) => void, message: string) {
  if (!items.length) return empty(message);
  return html`<div class="dense-list">
    ${repeat(
      items,
      (item) => item.id || item.scopeId || item,
      (item) => {
        const r = rowOf(item);
        const content = html`${r.icon ? html`<span class="dense-icon">${r.icon}</span>` : nothing}<span
            class="dense-name"
            >${r.name}</span
          ><span class="dense-preview">${r.preview ?? ""}</span
          >${r.time != null ? html`<span class="dense-time">${r.time}</span>` : nothing}`;
        const click = (e: MouseEvent) => {
          if (r.href && (r.target || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return;
          if (r.href) e.preventDefault();
          open(item);
        };
        return r.href
          ? html`<a
              class=${"dense-row" + (r.cls ? " " + r.cls : "")}
              href=${r.href}
              target=${ifDefined(r.target)}
              rel=${ifDefined(r.target ? "noopener" : undefined)}
              @click=${click}
              >${content}</a
            >`
          : html`<div
              class=${"dense-row" + (r.cls ? " " + r.cls : "")}
              tabindex="0"
              role="button"
              @click=${click}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") open(item);
              }}
            >
              ${content}
            </div>`;
      },
    )}
  </div>`;
}
function scopeList(items: Data[], c: Context, noun: string, latest: (r: Data) => number, message: string) {
  const groups = new Map<string, Data>();
  for (const item of items) {
    const id = item.ownerScopeId || item.scopeId;
    const group = groups.get(id) || { scopeId: id, count: 0, latest: 0 };
    group.count++;
    group.latest = Math.max(group.latest, latest(item));
    groups.set(id, group);
  }
  return dense(
    [...groups.values()].sort((a, b) => b.latest - a.latest),
    (g) => ({
      name: c.shortName(g.scopeId),
      preview: c.plural(g.count, noun),
      time: c.relTime(g.latest),
      href: c.stateToUrl({ view: c.view, scope: g.scopeId, ...(c.scopeKind(g.scopeId) === "org" ? { own: "1" } : {}) }),
    }),
    (g) => c.openScopeRow(g.scopeId, c.view === "crons" ? { cron: null } : {}),
    message,
  );
}
function searchShell(c: Context, key: string, shell: Data, placeholder: string, draw: (q: string) => void) {
  const id = [key, c.scope, c.own].join("\0");
  const q = queries.get(id) || "";
  const active = document.activeElement as HTMLInputElement | null;
  const focus = !!active?.closest(".shell-search");
  const caret = focus ? active?.selectionStart : null;
  c.pageShell({
    ...shell,
    search: {
      placeholder,
      onInput: (value: string) => {
        queries.set(id, value);
        draw(value.trim().toLowerCase());
      },
    },
  });
  const input = document.querySelector<HTMLInputElement>("#shellbar .shell-search input");
  if (input) {
    input.value = q;
    if (focus) {
      input.focus();
      const pos = Math.min(caret ?? q.length, q.length);
      input.setSelectionRange(pos, pos);
    }
  }
  return q.trim().toLowerCase();
}
const listShell = (c: Context, title: string, count: string) => ({
  ...(c.index
    ? {}
    : {
        back: {
          label: "← " + title,
          onClick: () => c.go({ view: c.view, scope: "org:" + c.orgId, own: null, session: null, page: 1 }),
        },
      }),
  title: c.index ? title : c.shortName(c.scope),
  count,
});
export function files(root: HTMLElement, d: Data, c: Context) {
  const render = renderer(root);
  const all = [...(d.files || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const items = c.own ? all.filter((f) => c.scopeKind(f.scopeId) === "org") : all;
  const capped = all.length >= 2000;
  let query = "",
    remote: Data[] | null = null,
    request = 0,
    timer: ReturnType<typeof setTimeout>;
  const failedImages = new Set<string>();
  const row = (f: Data): Row => {
    const kind = c.fileKind(f.name || f.path);
    const image = f.openable && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(f.mimetype || "");
    const large = image && f.size > 200 * 1024;
    return {
      icon: html`<span
        class="file-thumb"
        title=${ifDefined(large ? "Large image. Click to preview full size" : undefined)}
        >${(() => {
          if (large) return "img";
          return kind === "file" ? "" : kind.slice(1);
        })()}${
          image && !large && !failedImages.has(f.id)
            ? html`<img
                loading="lazy"
                decoding="async"
                alt=""
                src=${c.apiBase + "/api/files/download?id=" + encodeURIComponent(f.id)}
                @error=${() => {
                  failedImages.add(f.id);
                  draw();
                }}
              />`
            : nothing
        }</span
      >`,
      name: f.name || c.fileName(f.path),
      preview: c.index ? c.shortName(f.scopeId) : "",
      time: c.fmtBytes(f.size || 0) + " · " + c.relTime(f.createdAt),
    };
  };
  const draw = () => {
    const local = items.filter((f) => !query || (f.name || c.fileName(f.path)).toLowerCase().includes(query));
    render(
      bareCard(
        html`${c.index ? html`<div class=${"file-scope-index" + (query ? " hidden" : "")}>${scopeList(all, c, "file", (f) => f.createdAt || 0, "No documents saved yet.")}${capped ? empty("Only the newest 2,000 files are indexed, so a scope with only older files won't appear.") : nothing}</div>` : nothing}
          <div class=${c.index && !query ? "hidden" : ""}>
            ${dense(remote ?? local, row, c.downloadFile, query ? "No files match." : "No documents saved yet.")}
          </div>`,
      ),
    );
  };
  const onQuery = (q: string) => {
    query = q;
    remote = null;
    request++;
    clearTimeout(timer);
    draw();
    if (!capped || !q) return;
    const token = request;
    timer = setTimeout(async () => {
      const response = await c
        .api("GET", "/api/files?scope=" + encodeURIComponent(c.scope) + "&q=" + encodeURIComponent(q))
        .catch(() => null);
      if (token !== request || !root.isConnected) return;
      if (response?.ok) {
        remote = [...(response.data?.files || [])]
          .filter((f) => !c.own || c.scopeKind(f.scopeId) === "org")
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      }
      draw();
    }, 250);
  };
  query = searchShell(
    c,
    "files",
    { ...listShell(c, "Files", items.length ? c.plural(items.length, "file") : ""), actions: [uploadBox(c)] },
    c.index ? "Search all files…" : "Search files…",
    onQuery,
  );
  onQuery(query);
}
export function uploadBox(c: Context) {
  let busy = false,
    dragging = false,
    message = "",
    tone = "muted";
  const holder = document.createDocumentFragment();

  const upload = async (files: FileList | File[]) => {
    const picked = [...files].filter((f) => f && f.size >= 0);
    if (!picked.length || busy) return;
    busy = true;
    message = "Uploading " + c.plural(picked.length, "file") + "...";
    tone = "saving";
    draw();
    let uploaded = 0;
    try {
      for (const file of picked) {
        const response = await fetch(c.apiBase + "/api/files/upload?scope=" + encodeURIComponent(c.scope), {
          method: "POST",
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-file-name": encodeURIComponent(file.name || "file"),
            "x-content-sha256": await c.fileSha256(file),
          },
          body: file,
        });
        if (!response.ok)
          throw new Error(c.uploadErrorMessage(await response.text(), "Upload failed (" + response.status + ")."));
        uploaded++;
      }
      message = "Uploaded " + c.plural(picked.length, "file") + ".";
      tone = "ok";
      c.invalidate();
      await c.reload();
    } catch (error) {
      message =
        (uploaded ? "Uploaded " + uploaded + " of " + picked.length + " before failure. " : "") +
        (error instanceof Error ? error.message : "Upload failed.");
      tone = "err";
      if (uploaded) {
        c.invalidate();
        await c.reload();
      }
    } finally {
      busy = false;
      dragging = false;
      input.value = "";
      draw();
    }
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
  const draw = () =>
    render(
      html`<div
        class=${"file-upload" + (dragging ? " dragging" : "")}
        @dragenter=${(e: DragEvent) => {
          if (hasFiles(e)) {
            e.preventDefault();
            dragging = true;
            draw();
          }
        }}
        @dragover=${(e: DragEvent) => {
          if (hasFiles(e)) e.preventDefault();
        }}
        @dragleave=${(e: DragEvent) => {
          if (!(e.relatedTarget instanceof Node) || !(e.currentTarget as Node).contains(e.relatedTarget)) {
            dragging = false;
            draw();
          }
        }}
        @drop=${(e: DragEvent) => {
          if (hasFiles(e)) {
            e.preventDefault();
            dragging = false;
            void upload(e.dataTransfer?.files || []);
          }
        }}
      >
        <div class="file-upload-actions">
          <span class=${"status " + tone}>${message}</span
          ><button type="button" class="primary upload-button" ?disabled=${busy} @click=${() => input.click()}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"></path></svg
            ><span>Upload</span></button
          ><input
            type="file"
            multiple
            class="hidden"
            @change=${(e: Event) => upload((e.target as HTMLInputElement).files || [])}
          />
        </div>
      </div>`,
      holder,
    );
  draw();
  const input = holder.querySelector("input")!;
  return holder.firstElementChild;
}
export function deployments(root: HTMLElement, d: Data, c: Context) {
  const render = renderer(root);
  const all = [...(d.deployments || [])].sort(
    (a, b) => (b.lastAccessAt || b.createdAt || 0) - (a.lastAccessAt || a.createdAt || 0),
  );
  const items = c.own ? all.filter((r) => c.scopeKind(r.ownerScopeId) === "org") : all;
  const row = (r: Data) => ({
    name: r.name || r.id,
    preview: [
      c.titleCase(r.status || "unknown"),
      r.currentVersion || "",
      c.index ? c.shortName(r.ownerScopeId) : "",
      r.createdBy || "",
    ]
      .filter(Boolean)
      .join(" · "),
    time: c.relTime(r.lastAccessAt || r.createdAt),
    href: c.deploymentHref(r) || undefined,
    target: "_blank",
  });
  const draw = (q: string) =>
    render(
      bareCard(
        html`${c.index ? html`<div class=${q ? "hidden" : ""}>${scopeList(all, c, "app", (r) => r.lastAccessAt || r.createdAt || 0, "No apps yet.")}</div>` : nothing}
          <div class=${c.index && !q ? "hidden" : ""}>
            ${dense(
              items.filter((r) => !q || (r.name || r.id).toLowerCase().includes(q)),
              row,
              (r) => {
                const href = c.deploymentHref(r);
                if (href) window.open(href, "_blank", "noopener,noreferrer");
              },
              (() => {
                if (q) return "No apps match.";
                return c.index ? "No apps yet." : "No apps in this scope.";
              })(),
            )}
          </div>`,
      ),
    );
  draw(
    searchShell(
      c,
      "deployments",
      listShell(c, "Apps", c.plural(items.length, "app")),
      c.index ? "Search all apps…" : "Search apps…",
      draw,
    ),
  );
}
export function memory(root: HTMLElement, d: Data, c: Context) {
  const render = renderer(root);
  if (Array.isArray(d.scopes)) return memoryIndex(root, d, c);
  if (c.scopeDir)
    c.pageShell({
      back: { label: "← Memory", onClick: () => c.go({ view: "memory", scope: "org:" + c.orgId, session: null }) },
      title: c.orgWide ? "Org-wide" : c.shortName(c.scope),
    });
  let baseline = d.content || "";
  let draft = c.memoryDraft() ?? baseline;
  let saving = false,
    message = draft !== baseline ? "Unsaved changes" : "",
    tone = "";
  const save = async () => {
    if (saving) return;
    saving = true;
    const submitted = draft;
    draw();
    try {
      const response = await c.api("PUT", "/api/memory?scope=" + encodeURIComponent(c.scope), { content: submitted });
      if (response.ok) {
        baseline = submitted;
        c.setMemoryDraft(draft === submitted ? null : draft);
        message = draft === submitted ? "Saved ✓" : "Unsaved changes";
        tone = draft === submitted ? "ok" : "";
      } else {
        message =
          response.status === 403 ? "You don't administer this scope." : response.data?.message || "Save failed.";
        tone = "err";
      }
    } catch {
      message = "Save failed.";
      tone = "err";
    } finally {
      saving = false;
      draw();
    }
  };
  const draw = () =>
    render(
      html`<section class="card memory-editor">
        <div class="head">
          <h2>Notebook</h2>
          <p>What the agent remembers in this scope. Changes apply when you save.</p>
        </div>
        <div class="body">
          <div>
            <label for="memory-text">Notebook contents</label
            ><textarea
              id="memory-text"
              spellcheck="false"
              aria-label="Notebook contents"
              style="min-height:340px;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;font-size:12px"
              placeholder="No memory stored for this scope yet. Anything you write here, the agent will remember."
              .value=${draft}
              @input=${(e: Event) => {
                draft = (e.target as HTMLTextAreaElement).value;
                c.setMemoryDraft(draft);
                message = draft !== baseline ? "Unsaved changes" : "";
                tone = "";
                draw();
              }}
            ></textarea>
            <div class="foot">
              <button class="primary" ?disabled=${saving} @click=${save}>Save</button
              ><span class=${"status" + (tone ? " " + tone : "")} id="st-memory" role="status">${message}</span>
            </div>
          </div>
        </div>
      </section>`,
    );
  draw();
}
function memoryIndex(root: HTMLElement, d: Data, c: Context) {
  const render = renderer(root);
  const scopes = (d.scopes || []).filter((s: Data) => s.hasMemory || c.scopeKind(s.scopeId) === "org");
  const written = scopes.filter((s: Data) => s.hasMemory);
  const hasTimestamps = written.some((s: Data) => s.updatedAt);
  scopes.sort((a: Data, b: Data) =>
    hasTimestamps
      ? (b.updatedAt || 0) - (a.updatedAt || 0) || (b.bytes || 0) - (a.bytes || 0)
      : (b.bytes || 0) - (a.bytes || 0),
  );
  const state = (s: Data) => ({
    view: "memory",
    scope: s.scopeId,
    session: null,
    ...(c.scopeKind(s.scopeId) === "org" ? { mem: "edit" } : {}),
  });
  const draw = (q: string) =>
    render(
      html`<div class="memory-notebooks">
        <div class="memory-columns"><span>Notebook</span><span>Size</span><span>Last updated</span></div>
        ${dense(
          scopes.filter(
            (s: Data) => !q || [s.label, c.shortName(s.scopeId), s.scopeId].join(" ").toLowerCase().includes(q),
          ),
          (s) => ({
            name: c.scopeKind(s.scopeId) === "org" ? "org" : s.label || c.shortName(s.scopeId),
            preview: s.hasMemory ? c.fmtBytes(s.bytes || 0) : "empty",
            time: s.updatedAt ? c.relTime(s.updatedAt) : "Never",
            href: c.stateToUrl(state(s)),
          }),
          (s) => c.go(state(s)),
          q ? "No notebooks match your search." : "No notebooks yet. The agent hasn't remembered anything.",
        )}
      </div>`,
    );
  c.pageShell({
    title: "Memory",
    count: c.plural(written.length, "notebook"),
    search: { placeholder: "Search notebooks…", onInput: (value: string) => draw(value.trim().toLowerCase()) },
    context: written.length && !hasTimestamps ? "sorted by size (this backend keeps no edit history)" : "",
  });
  draw("");
}
export function skills(root: HTMLElement, d: Data, c: Context) {
  const render = renderer(root);
  const lastUse = (s: Data) => s.lastUsedAt || s.updatedAt || s.createdAt || 0;
  const all = (d.skills || [])
    .filter((s: Data) => s.status !== "archived")
    .sort((a: Data, b: Data) => lastUse(b) - lastUse(a) || (a.name || "").localeCompare(b.name || ""));
  const items = c.own ? all.filter((s: Data) => c.scopeKind(s.ownerScopeId) === "org") : all;
  const count =
    c.plural(items.length, "skill") +
    (c.index && items.length ? " · " + c.plural(new Set(items.map((s: Data) => s.ownerScopeId)).size, "scope") : "");
  const packs = document.createElement("div"),
    detail = document.createElement("div");
  const identity = (s: Data) => (s.name || s.id) + "\0" + (s.createdBy || "");
  const open = (s: Data) =>
    skillDetail(
      detail,
      s,
      all.filter((r: Data) => identity(r) === identity(s)),
      c,
    );
  const pending = new Set<string>();
  let query = "";
  const draw = (q = query) => {
    query = q;
    const shown = items.filter(
      (s: Data) => !q || ((s.name || s.id) + " " + (s.description || "")).toLowerCase().includes(q),
    );
    const rows = shown.map((s: Data) => [
      {
        node: html`<div>
          <div class="primaryline">${s.name || s.id}</div>
          <div class="subline">${s.description || c.shortId(s.id)}</div>
        </div>`,
      },
      ...(c.index ? [{ text: c.shortName(s.ownerScopeId), cls: "mono" }] : []),
      { text: c.titleCase(s.status || "unknown"), cls: "subline" },
      c.createdByCell(s),
      {
        text: (() => {
          if (s.lastUsedAt) return c.fmtHistoryTime(s.lastUsedAt);
          return lastUse(s) ? "never · imported " + c.fmtHistoryTime(lastUse(s)) : "never";
        })(),
        cls: s.lastUsedAt ? "num" : "num subline",
      },
      {
        node: html`<button
          type="button"
          class="rowbtn danger"
          ?disabled=${pending.has(s.id)}
          @click=${async (e: Event) => {
            e.stopPropagation();
            if (pending.has(s.id)) return;
            pending.add(s.id);
            draw();
            try {
              await removeSkill(s, c);
            } finally {
              pending.delete(s.id);
              draw();
            }
          }}
        >
          Remove
        </button>`,
      },
    ]);
    render(
      html`${c.index ? packs : nothing}${card(
        "Installed skills",
        "",
        html`${c.index ? html`<div class=${q ? "hidden" : ""}>${scopeList(all, c, "skill", lastUse, "No skills yet.")}</div>` : nothing}
          <div class=${c.index && !q ? "hidden" : ""}>
            ${table(
              ["Skill", ...(c.index ? ["Scope"] : []), "Status", "Created by", "Last used", ""],
              rows,
              (() => {
                if (q) return "No skills match.";
                return c.index ? "No skills yet." : "No skills in this scope.";
              })(),
              (i: number) => open(shown[i]),
              { className: "skills-table" },
            )}
          </div>`,
      )}${detail}`,
    );
  };
  query = searchShell(
    c,
    "skills",
    listShell(c, "Skills", count),
    c.index ? "Search all skills…" : "Search skills…",
    draw,
  );
  draw();
  if (c.index) void mountPacks(packs, c);
}
const cronStatus = (c: Data) =>
  (() => {
    if (c.archived) return "archived";
    return c.enabled === false ? "disabled" : "enabled";
  })();
export function crons(root: HTMLElement, d: Data, c: Context) {
  const render = renderer(root);
  const all = d.crons || [];
  if (c.cron)
    return cronDetail(
      root,
      all.find((row: Data) => row.id === c.cron),
      c.cron,
      c,
    );
  const items = c.own ? all.filter((r: Data) => c.scopeKind(r.ownerScopeId) === "org") : all;
  const sorted = [...items].sort((a, b) => (b.lastFiredAt || b.createdAt || 0) - (a.lastFiredAt || a.createdAt || 0));
  const disabled = items.filter((r: Data) => !r.archived && r.enabled === false).length;
  const archived = items.filter((r: Data) => r.archived).length;
  const row = (r: Data) => ({
    name: c.firstLine(c.cronName(r, true), 72),
    preview: [
      c.index ? c.shortName(r.ownerScopeId) : "",
      cronStatus(r) === "enabled" ? "" : cronStatus(r),
      c.firstLine(
        (() => {
          if (r.title) return r.action || r.message || "";
          return r.action && r.message ? r.action : "";
        })(),
        200,
      ),
    ]
      .filter(Boolean)
      .join(" · "),
    time: c.shortSchedule(r.schedule) + " · " + (r.lastFiredAt ? c.relTime(r.lastFiredAt) : "never fired"),
    cls: cronStatus(r) === "enabled" ? "" : "dim",
    href: c.stateToUrl({ view: "crons", scope: c.scope, cron: r.id }),
  });
  const draw = (q: string) =>
    render(
      bareCard(
        html`${c.index ? html`<div class=${q ? "hidden" : ""}>${scopeList(all, c, "cron", (r) => r.lastFiredAt || r.createdAt || 0, "No crons yet.")}</div>` : nothing}
          <div class=${c.index && !q ? "hidden" : ""}>
            ${dense(
              sorted.filter(
                (r) => !q || (c.cronName(r, true) + " " + (r.action || r.message || "")).toLowerCase().includes(q),
              ),
              row,
              (r) => c.go({ view: "crons", scope: c.scope, session: null, cron: r.id, page: 1 }),
              (() => {
                if (q) return "No crons match.";
                return c.index ? "No crons yet." : "No crons in this scope.";
              })(),
            )}
          </div>`,
      ),
    );
  draw(
    searchShell(
      c,
      "crons",
      {
        ...listShell(c, "Crons", c.plural(items.length, "cron")),
        stats: [...(disabled ? [[disabled, "disabled"]] : []), ...(archived ? [[archived, "archived"]] : [])],
      },
      c.index ? "Search all crons…" : "Search crons…",
      draw,
    ),
  );
}
function cronDetail(root: HTMLElement, cron: Data | undefined, id: string, c: Context) {
  const render = renderer(root);
  c.pageShell({
    back: {
      label: "← Crons",
      onClick: () => c.go({ view: "crons", scope: c.scope, session: null, cron: null, page: 1 }),
    },
    title: cron ? c.firstLine(c.cronName(cron, true), 90) : "Cron",
    context: cron ? c.shortName(cron.ownerScopeId) : "",
  });
  if (!cron) {
    render(empty("Cron " + c.shortId(id) + " isn't in this scope."));
    return;
  }
  let editing = false,
    saving = false,
    expanded = false,
    needsToggle = true;
  let fires: Data[] | null = null,
    error = "",
    total = 0;
  const draft = {
    type: cron.destination?.type === "principal" ? "principal" : "slack",
    target: cron.destination?.target || "",
    audienceScopeId: cron.destination?.audienceScopeId || "",
    onBehalfOf: cron.destination?.onBehalfOf || "",
  };
  const change = (key: keyof typeof draft) => (e: Event) => {
    draft[key] = (e.target as HTMLInputElement).value;
    draw();
  };
  const save = async (clear = false) => {
    if (saving) return;
    if (!clear && !draft.target.trim()) {
      root.querySelector<HTMLInputElement>('input[name="cron-target"]')?.focus();
      alert("Target is required.");
      return;
    }
    const destination = clear
      ? null
      : {
          type: draft.type,
          target: draft.target.trim(),
          ...(draft.audienceScopeId.trim() ? { audienceScopeId: draft.audienceScopeId.trim() } : {}),
          ...(draft.type === "principal" && draft.onBehalfOf.trim() ? { onBehalfOf: draft.onBehalfOf.trim() } : {}),
        };
    const submitted = JSON.stringify(draft);
    saving = true;
    draw();
    try {
      const response = await c.api(
        "PUT",
        "/api/crons/" + encodeURIComponent(id) + "/destination?scope=" + encodeURIComponent(c.scope),
        { destination },
      );
      if (!response.ok) {
        alert(response.data?.message || "Could not update destination.");
        return;
      }
      cron.destination = destination;
      c.invalidate();
      if (JSON.stringify(draft) === submitted) {
        editing = false;
        c.setCronEditing(null);
        await c.reload();
      }
    } catch {
      alert("Could not update destination.");
    } finally {
      saving = false;
      if (root.isConnected) draw();
    }
  };
  const prompt = cron.action || cron.message || "";
  const facts = () => [
    ["Schedule", c.fmtSchedule(cron.schedule)],
    [
      "Destination",
      html`<span
        >${c.destinationSummary(cron.destination) + (c.destinationDetails(cron.destination) && cron.destination ? " · " + c.destinationDetails(cron.destination) : "")}</span
      >`,
    ],
    ["Owner", cron.owner || cron.createdBy || "None"],
    ["Status", cronStatus(cron)],
    ["Created", c.fmtTime(cron.createdAt)],
    ["Last fired", cron.lastFiredAt ? c.relTime(cron.lastFiredAt) : "never fired"],
    ["Id", cron.id],
  ];
  const draw = () =>
    render(
      html`${
          editing
            ? card(
                "Edit cron destination",
                cron.title || cron.action || cron.message || cron.id,
                html`<div>
                  <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));gap:10px">
                    <label
                      >Type<select .value=${draft.type} @change=${change("type")}>
                        <option value="slack" .selected=${draft.type === "slack"}>slack</option>
                        <option value="principal" .selected=${draft.type === "principal"}>principal</option>
                      </select></label
                    ><label
                      >Target<input
                        name="cron-target"
                        type="text"
                        .value=${draft.target}
                        placeholder=${draft.type === "principal" ? "principal id" : "Slack channel/thread id"}
                        @input=${change("target")} /></label
                    ><label
                      >Audience scope<input
                        type="text"
                        .value=${draft.audienceScopeId}
                        placeholder=${draft.type === "principal" ? "personal:U123" : "channel:C123"}
                        @input=${change("audienceScopeId")} /></label
                    ><label
                      >On behalf of<input
                        type="text"
                        .value=${draft.onBehalfOf}
                        ?disabled=${draft.type !== "principal"}
                        @input=${change("onBehalfOf")}
                    /></label>
                  </div>
                  <div class="foot">
                    <button type="button" class="primary" ?disabled=${saving} @click=${() => save()}>
                      Save destination</button
                    ><button
                      type="button"
                      ?disabled=${saving}
                      @click=${() => {
                        editing = false;
                        c.setCronEditing(null);
                        draw();
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>`,
              )
            : nothing
        }
        <div class="factlist">
          ${facts()
            .filter(([, value]) => value != null && value !== "")
            .map(
              ([label, value]) =>
                html`<div class="fk">${label}</div>
                  <div class="fv">${value}</div>`,
            )}
        </div>
        <div class="credential-actions" style="margin:0 0 18px">
          <button
            type="button"
            class="rowbtn"
            ?disabled=${saving}
            @click=${() => {
              Object.assign(draft, {
                type: cron.destination?.type === "principal" ? "principal" : "slack",
                target: cron.destination?.target || "",
                audienceScopeId: cron.destination?.audienceScopeId || "",
                onBehalfOf: cron.destination?.onBehalfOf || "",
              });
              editing = true;
              c.setCronEditing(id);
              draw();
            }}
          >
            Edit destination</button
          ><button
            type="button"
            class="rowbtn danger"
            ?disabled=${saving || !cron.destination}
            @click=${() => save(true)}
          >
            Clear destination
          </button>
        </div>
        ${
          prompt
            ? card(
                cron.action ? "Prompt" : "Message",
                cron.action ? "Re-run as a fresh prompt at every fire." : "Delivered as-is at every fire.",
                html`<div>
                  <p class=${"prompt-body" + (expanded ? "" : " clamped")}>${prompt}</p>
                  ${
                    needsToggle
                      ? html`<button
                          type="button"
                          class="prompt-toggle"
                          @click=${() => {
                            expanded = !expanded;
                            draw();
                          }}
                        >
                          ${expanded ? "Show less" : "Show more"}
                        </button>`
                      : nothing
                  }
                </div>`,
              )
            : nothing
        }${card(
          "Recent fires",
          "Each fire is a session. Click one to read its transcript. Dimmed fires delivered nothing.",
          html`<div>
            ${(() => {
              if (error) return empty(error);
              return fires === null
                ? html`<div class="loadingline">Loading fires...</div>`
                : dense(
                    fires,
                    (s) => ({
                      name: c.relTime(s.createdAt || s.lastActivity),
                      preview: [
                        (() => {
                          if (typeof s.delivered === "number")
                            return s.delivered ? "delivered" + (s.delivered > 1 ? " ×" + s.delivered : "") : "silent";
                          return "";
                        })(),
                        c.plural(s.turns || 0, "turn"),
                        s.result || "(no messages)",
                      ]
                        .filter(Boolean)
                        .join(" · "),
                      time: c.plural(s.messages || 0, "entry", "entries"),
                      cls: typeof s.delivered === "number" && !s.delivered ? "dim" : "",
                      href: c.stateToUrl({ view: "history", scope: s.scopeId || c.scope, session: s.id }),
                    }),
                    (s) => c.go({ view: "history", scope: s.scopeId || c.scope, session: s.id }),
                    "This cron has never fired.",
                  );
            })()}${total > 25 ? html`<button type="button" class="prompt-toggle" @click=${() => c.go({ view: "history", scope: c.scope, session: null, page: 1, historyKind: "cron", cron: id })}>${"All " + c.plural(total, "fire") + " →"}</button>` : nothing}
          </div>`,
        )}`,
    );
  draw();
  requestAnimationFrame(() => {
    const p = root.querySelector<HTMLElement>(".prompt-body");
    if (p && p.scrollHeight > 0 && p.scrollHeight <= p.clientHeight + 1) {
      needsToggle = false;
      draw();
    }
  });
  void c
    .api(
      "GET",
      `/api/sessions?scope=${encodeURIComponent(c.scope)}&limit=25&offset=0&category=background&origin=cron&cron=${encodeURIComponent(id)}`,
    )
    .then((response: Data) => {
      if (!root.isConnected) return;
      if (response.ok) {
        fires = response.data.sessions || [];
        total = response.data.total || fires!.length;
      } else error = response.data?.message || `Failed to load fires (${response.status}).`;
      draw();
    })
    .catch(() => {
      if (root.isConnected) {
        error = "Failed to load fires.";
        draw();
      }
    });
}
const kpis = (items: unknown[][]) =>
  html`<div class="kpis">
    ${items.map(
      ([value, label]) =>
        html`<div class="kpi">
          <div class="n">${value}</div>
          <div class="k">${label}</div>
        </div>`,
    )}
  </div>`;
export function retention(root: HTMLElement, d: Data) {
  const render = renderer(root);
  const a = d.active || {},
    nvr = d.newVsReturning || {},
    pu = d.perUser || {};
  const retentionCell = (p: number) => ({
    node: badge(
      p + "%",
      (() => {
        if (p >= 40) return "ok";
        return p >= 15 ? "warn" : "muted";
      })(),
    ),
    cls: "num",
  });
  render(
    html`${kpis([
        [a.dau ?? 0, "DAU"],
        [a.wau ?? 0, "WAU"],
        [a.mau ?? 0, "MAU"],
        [(a.stickiness ?? 0) + "%", "Stickiness (DAU/MAU)"],
      ])}
      <div class="metric-note">
        Stickiness${badge(
          String(a.stickiness ?? 0) + "%",
          (() => {
            if ((a.stickiness ?? 0) >= 30) return "ok";
            return (a.stickiness ?? 0) >= 10 ? "warn" : "muted";
          })(),
        )}
      </div>
      ${card(
        "New vs returning",
        `Distinct active users in the trailing ${nvr.window || "30d"}.`,
        table(
          ["New", "Returning"],
          [
            [
              { text: String(nvr.newUsers ?? 0), cls: "num" },
              { text: String(nvr.returning ?? 0), cls: "num" },
            ],
          ],
          "No activity yet.",
        ),
      )}${card(
        "Weekly retention cohorts",
        "Of users first active in a week, the share active in following weeks. Channel attribution is approximate.",
        table(
          ["Cohort (week of)", "Users", "W0", "W1", "W2", "W3", "W4"],
          (d.cohorts || []).map((r: Data) => [
            r.week,
            { text: String(r.size), cls: "num" },
            ...(r.retained || []).map(retentionCell),
          ]),
          "No cohorts yet.",
        ),
      )}${card(
        "Per-user distribution",
        `${d.totals?.users ?? 0} users · ${d.totals?.sessions ?? 0} sessions. ${d.attribution || ""}`,
        table(
          ["Metric", "p50", "p95"],
          [
            [
              "Sessions / user",
              { text: String(pu.sessions?.p50 ?? 0), cls: "num" },
              { text: String(pu.sessions?.p95 ?? 0), cls: "num" },
            ],
            [
              "Turns / user",
              { text: String(pu.turns?.p50 ?? 0), cls: "num" },
              { text: String(pu.turns?.p95 ?? 0), cls: "num" },
            ],
          ],
          "No users yet.",
        ),
      )}`,
  );
}
export function live(root: HTMLElement, d: Data, c: Context) {
  const render = renderer(root);
  const runs = d.runs || [];
  render(
    html`${kpis([
      [d.active ?? 0, "Active now"],
      [runs.length, "Recent runs"],
      [runs.filter((r: Data) => r.status === "failed").length, "Failed"],
      [runs.filter((r: Data) => r.status === "done").length, "Done"],
    ])}${bareCard(
      table(
        ["Run", "Status", "Scope", "Type", "Attempts", "Worker", "Duration", "Lease", "Started"],
        runs.map((r: Data) => [
          { node: c.stacked("Run " + c.shortId(r.id), r.threadRef || "no thread"), cls: "mono" },
          { node: c.statusBadge(r.status) },
          r.sessionScope ? c.scopeCell(r.sessionScope) : { text: "-", cls: "mono" },
          { node: c.typeBadge(r.sessionType) },
          {
            node: badge(`${r.attempts}/${r.maxAttempts}`, r.status === "failed" || r.attempts > 1 ? "warn" : "muted"),
            cls: "num",
          },
          { text: r.workerId || "-", cls: "mono" },
          { text: c.fmtDuration(r.startedAt || r.createdAt, r.finishedAt), cls: "num" },
          {
            text:
              r.leaseExpiresAt && (r.status === "running" || r.status === "pending")
                ? c.fmtTime(r.leaseExpiresAt)
                : "-",
            cls: "num",
          },
          { text: r.startedAt ? c.fmtTime(r.startedAt) : "-", cls: "num" },
        ]),
        "No runs.",
      ),
    )}`,
  );
}
