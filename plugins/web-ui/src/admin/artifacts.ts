import { html, nothing, render } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { card, bareCard, table, renderer, empty, stacked, denseList as dense } from "./shared.ts";
import { mountPacks, skillDetail, removeSkill } from "./artifacts-skills.ts";
export type Data = Record<string, any>;
export type Context = Record<string, any>;
type Fact = { id: string; text: string };
const queries = new Map<string, string>();
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
const none = (c: Context, q: string, noun: string) =>
  q ? `No ${noun} match.` : `No ${noun} ${c.index ? "yet" : "in this scope"}.`;
const dot = (...parts: unknown[]) => parts.filter(Boolean).join(" · ");
const hit = (q: string, ...parts: unknown[]) => !q || parts.join(" ").toLowerCase().includes(q);
const indexed = (c: Context, q: string, index: unknown, list: unknown, cls = "") =>
  html`${c.index ? html`<div class=${[cls, q ? "hidden" : ""].join(" ").trim()}>${index}</div>` : nothing}
    <div class=${c.index && !q ? "hidden" : ""}>${list}</div>`;
function searchShell(c: Context, key: string, shell: Data, nouns: string, draw: (q: string) => void) {
  const id = [key, c.scope, c.own].join("\0");
  const q = queries.get(id) || "";
  const active = document.activeElement as HTMLInputElement | null;
  const focus = !!active?.closest(".shell-search");
  const caret = focus ? active?.selectionStart : null;
  c.pageShell({
    ...shell,
    search: {
      placeholder: "Search " + (c.index ? "all " : "") + nouns + "…",
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
  back: c.index
    ? undefined
    : {
        label: "← " + title,
        onClick: () => c.go({ view: c.view, scope: "org:" + c.orgId, own: null, session: null, page: 1 }),
      },
  title: c.index ? title : c.shortName(c.scope),
  count,
});
export function files(root: HTMLElement, d: Data, c: Context) {
  const render = renderer(root);
  const all = [...(d.files || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const items = c.own ? all.filter((f) => c.scopeKind(f.scopeId) === "org") : all;
  const capped = all.length >= 2000;
  let [query, remote, request] = ["", null as Data[] | null, 0];
  let timer: ReturnType<typeof setTimeout>;
  const failedImages = new Set<string>();
  const row = (f: Data) => {
    const kind = c.fileKind(f.name || f.path);
    const image = f.openable && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(f.mimetype || "");
    const large = image && f.size > 200 * 1024;
    return {
      icon: html`<span
        class="file-thumb"
        title=${ifDefined(large ? "Large image. Click to preview full size" : undefined)}
        >${(large && "img") || (kind !== "file" && kind.slice(1)) || ""}${
          image && !large && !failedImages.has(f.id)
            ? html`<img
                loading="lazy"
                decoding="async"
                alt=""
                src=${c.apiBase + "/files/download?id=" + encodeURIComponent(f.id)}
                @error=${() => (failedImages.add(f.id), draw())}
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
    const local = items.filter((f) => hit(query, f.name || c.fileName(f.path)));
    render(
      bareCard(
        indexed(
          c,
          query,
          html`${scopeList(all, c, "file", (f) => f.createdAt || 0, "No documents saved yet.")}${capped ? empty("Only the newest 2,000 files are indexed, so a scope with only older files won't appear.") : nothing}`,
          dense(remote ?? local, row, c.downloadFile, query ? "No files match." : "No documents saved yet."),
          "file-scope-index",
        ),
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
    "files",
    onQuery,
  );
  onQuery(query);
}
export function uploadBox(c: Context) {
  let [busy, dragging, message, tone] = [false, false, "", "muted"];
  const holder = document.createDocumentFragment();

  const upload = async (files: FileList | File[]) => {
    const picked = [...files].filter((f) => f && f.size >= 0);
    if (!picked.length || busy) return;
    [busy, message, tone] = [true, "Uploading " + c.plural(picked.length, "file") + "...", "saving"];
    draw();
    let uploaded = 0;
    try {
      for (const file of picked) {
        const sha = await c.fileSha256(file);
        const query = new URLSearchParams({ scope: c.scope, sha, name: file.name || "file" });
        const response = await fetch(c.apiBase + "/files/upload?" + query.toString(), {
          method: "POST",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!response.ok)
          throw new Error(c.uploadErrorMessage(await response.text(), "Upload failed (" + response.status + ")."));
        uploaded++;
      }
      [message, tone] = ["Uploaded " + c.plural(picked.length, "file") + ".", "ok"];
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
      [busy, dragging] = [false, false];
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
        @dragover=${(e: DragEvent) => hasFiles(e) && e.preventDefault()}
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
function listPage(root: HTMLElement, c: Context, key: string, noun: string, all: Data[], items: Data[], o: Data) {
  const render = renderer(root);
  const draw = (q: string) => {
    const shown = items.filter((r) => hit(q, o.text(r)));
    const list = dense(shown, o.row, o.open, none(c, q, noun + "s"));
    render(bareCard(indexed(c, q, scopeList(all, c, noun, o.latest, `No ${noun}s yet.`), list)));
  };
  draw(searchShell(c, key, o.shell, noun + "s", draw));
}
export function deployments(root: HTMLElement, d: Data, c: Context) {
  const latest = (r: Data) => r.lastAccessAt || r.createdAt || 0;
  const all = [...(d.deployments || [])].sort((a, b) => latest(b) - latest(a));
  const items = c.own ? all.filter((r) => c.scopeKind(r.ownerScopeId) === "org") : all;
  const row = (r: Data) => ({
    name: r.name || r.id,
    preview: dot(
      c.titleCase(r.status || "unknown"),
      r.currentVersion || "",
      c.index ? c.shortName(r.ownerScopeId) : "",
      r.createdBy || "",
    ),
    time: c.relTime(r.lastAccessAt || r.createdAt),
    href: c.deploymentHref(r) || undefined,
    target: "_blank",
  });
  listPage(root, c, "deployments", "app", all, items, {
    shell: listShell(c, "Apps", c.plural(items.length, "app")),
    latest,
    text: (r: Data) => r.name || r.id,
    row,
    open: (r: Data) => {
      const href = c.deploymentHref(r);
      if (href) window.open(href, "_blank", "noopener,noreferrer");
    },
  });
}
export function memory(root: HTMLElement, d: Data, c: Context) {
  const render = renderer(root);
  if (Array.isArray(d.scopes)) return memoryIndex(root, d, c);
  if (c.scopeDir)
    c.pageShell({
      back: { label: "← Memory", onClick: () => c.go({ view: "memory", scope: "org:" + c.orgId, session: null }) },
      title: c.orgWide ? "Org-wide" : c.shortName(c.scope),
    });
  let facts: Fact[] = d.facts || [];
  let editing: Fact | null = null;
  let [draft, saving, message, tone] = ["", false, "", ""];
  const change = async (method: "POST" | "PATCH" | "DELETE", body: object) => {
    if (saving) return;
    saving = true;
    draw();
    try {
      const response = await c.api(method, "/api/memory?scope=" + encodeURIComponent(c.scope), body);
      if (response.ok) {
        facts = response.data?.facts || [];
        editing = null;
        if (method === "POST") draft = "";
        [message, tone] = ["Saved ✓", "ok"];
      } else {
        message =
          response.status === 403 ? "You don't administer this scope." : response.data?.message || "Save failed.";
        tone = "err";
      }
    } catch {
      [message, tone] = ["Save failed.", "err"];
    } finally {
      saving = false;
      draw();
    }
  };
  const row = (fact: Fact) =>
    editing?.id === fact.id
      ? html`<li>
          <textarea
            aria-label="Fact text"
            .value=${editing.text}
            @input=${(e: Event) => (editing = { id: fact.id, text: (e.target as HTMLTextAreaElement).value })}
          ></textarea>
          <button class="primary" ?disabled=${saving} @click=${() => change("PATCH", { facts: [editing] })}>Save</button
          ><button
            @click=${() => {
              editing = null;
              draw();
            }}
          >
            Cancel
          </button>
        </li>`
      : html`<li>
          <span>${fact.text}</span>
          <button
            @click=${() => {
              editing = { id: fact.id, text: fact.text };
              draw();
            }}
          >
            Edit</button
          ><button ?disabled=${saving} @click=${() => change("DELETE", { ids: [fact.id] })}>Forget</button>
        </li>`;
  const draw = () =>
    render(
      html`<section class="card memory-editor">
        <div class="head">
          <h2>Notebook</h2>
          <p>What the agent remembers in this scope, one fact per row.</p>
        </div>
        <div class="body">
          ${
            facts.length
              ? html`<ul class="memory-facts">
                  ${facts.map(row)}
                </ul>`
              : html`<p class="empty">No memory stored for this scope yet.</p>`
          }
          <div class="memory-add">
            <textarea
              aria-label="New fact"
              placeholder="Add a fact"
              .value=${draft}
              @input=${(e: Event) => ((draft = (e.target as HTMLTextAreaElement).value), draw())}
            ></textarea>
            <button
              class="primary"
              ?disabled=${saving || !draft.trim()}
              @click=${() => change("POST", { facts: [draft] })}
            >
              Add
            </button>
          </div>
          <span class=${"status" + (tone ? " " + tone : "")} id="st-memory" role="status">${message}</span>
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
  scopes.sort(
    (a: Data, b: Data) => (hasTimestamps && (b.updatedAt || 0) - (a.updatedAt || 0)) || (b.bytes || 0) - (a.bytes || 0),
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
          scopes.filter((s: Data) => hit(q, s.label, c.shortName(s.scopeId), s.scopeId)),
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
  const group = (s: Data) => all.filter((r: Data) => identity(r) === identity(s));
  const open = (s: Data) => skillDetail(detail, s, group(s), c);
  const pending = new Set<string>();
  let query = "";
  const draw = (q = query) => {
    query = q;
    const shown = items.filter((s: Data) => hit(q, s.name || s.id, s.description || ""));
    const rows = shown.map((s: Data) => [
      {
        node: stacked(s.name || s.id, s.description || c.shortId(s.id)),
      },
      ...(c.index ? [{ text: c.shortName(s.ownerScopeId), cls: "mono" }] : []),
      { text: c.titleCase(s.status || "unknown"), cls: "subline" },
      c.createdByCell(s),
      {
        text: s.lastUsedAt
          ? c.fmtHistoryTime(s.lastUsedAt)
          : (lastUse(s) && "never · imported " + c.fmtHistoryTime(lastUse(s))) || "never",
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
        indexed(
          c,
          q,
          scopeList(all, c, "skill", lastUse, "No skills yet."),
          table(
            ["Skill", ...(c.index ? ["Scope"] : []), "Status", "Created by", "Last used", ""],
            rows,
            none(c, q, "skills"),
            (i: number) => open(shown[i]),
            { className: "skills-table" },
          ),
        ),
      )}${detail}`,
    );
  };
  query = searchShell(c, "skills", listShell(c, "Skills", count), "skills", draw);
  draw();
  if (c.index) void mountPacks(packs, c);
}
const cronStatus = (c: Data) => (c.archived && "archived") || (c.enabled === false ? "disabled" : "enabled");
export function crons(root: HTMLElement, d: Data, c: Context) {
  const all = d.crons || [];
  if (c.cron) return cronDetail(root, all, c.cron, c);
  const items = c.own ? all.filter((r: Data) => c.scopeKind(r.ownerScopeId) === "org") : all;
  const latest = (r: Data) => r.lastFiredAt || r.createdAt || 0;
  const sorted = [...items].sort((a, b) => latest(b) - latest(a));
  const disabled = items.filter((r: Data) => !r.archived && r.enabled === false).length;
  const archived = items.filter((r: Data) => r.archived).length;
  const row = (r: Data) => ({
    name: c.firstLine(c.cronName(r, true), 72),
    preview: dot(
      c.index ? c.shortName(r.ownerScopeId) : "",
      cronStatus(r) === "enabled" ? "" : cronStatus(r),
      c.firstLine(r.title ? r.action || r.message || "" : (r.message && r.action) || "", 200),
    ),
    time: c.shortSchedule(r.schedule) + " · " + (r.lastFiredAt ? c.relTime(r.lastFiredAt) : "never fired"),
    cls: cronStatus(r) === "enabled" ? "" : "dim",
    href: c.stateToUrl({ view: "crons", scope: c.scope, cron: r.id }),
  });
  listPage(root, c, "crons", "cron", all, sorted, {
    shell: {
      ...listShell(c, "Crons", c.plural(items.length, "cron")),
      stats: [...(disabled ? [[disabled, "disabled"]] : []), ...(archived ? [[archived, "archived"]] : [])],
    },
    latest,
    text: (r: Data) => c.cronName(r, true) + " " + (r.action || r.message || ""),
    row,
    open: (r: Data) => c.go({ view: "crons", scope: c.scope, session: null, cron: r.id, page: 1 }),
  });
}
function cronDetail(root: HTMLElement, all: Data[], id: string, c: Context) {
  const render = renderer(root);
  const cron = all.find((row) => row.id === id);
  c.pageShell({
    back: {
      label: "← Crons",
      onClick: () => c.go({ view: "crons", scope: c.scope, session: null, cron: null, page: 1 }),
    },
    title: cron ? c.firstLine(c.cronName(cron, true), 90) : "Cron",
    context: cron ? c.shortName(cron.ownerScopeId) : "",
  });
  if (!cron) return render(empty("Cron " + c.shortId(id) + " isn't in this scope."));
  let [editing, saving, expanded, needsToggle] = [false, false, false, true];
  let [fires, error, total] = [null as Data[] | null, "", 0];
  const current = () => ({
    type: cron.destination?.type === "principal" ? "principal" : "slack",
    target: cron.destination?.target || "",
    audienceScopeId: cron.destination?.audienceScopeId || "",
    onBehalfOf: cron.destination?.onBehalfOf || "",
  });
  const draft = current();
  const change = (key: keyof typeof draft) => (e: Event) => {
    draft[key] = (e.target as HTMLInputElement).value;
    draw();
  };
  const save = async (clear = false) => {
    if (saving) return;
    if (!clear && !draft.target.trim()) {
      root.querySelector<HTMLInputElement>('input[name="cron-target"]')?.focus();
      return alert("Target is required.");
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
      if (!response.ok) return alert(response.data?.message || "Could not update destination.");
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
              Object.assign(draft, current());
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
                          @click=${() => ((expanded = !expanded), draw())}
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
            ${
              (error && empty(error)) ||
              (fires === null
                ? html`<div class="loadingline">Loading fires...</div>`
                : dense(
                    fires,
                    (s) => ({
                      name: c.relTime(s.createdAt || s.lastActivity),
                      preview: dot(
                        typeof s.delivered === "number" &&
                          (s.delivered ? "delivered" + (s.delivered > 1 ? " ×" + s.delivered : "") : "silent"),
                        c.plural(s.turns || 0, "turn"),
                        s.result || "(no messages)",
                      ),
                      time: c.plural(s.messages || 0, "entry", "entries"),
                      cls: typeof s.delivered === "number" && !s.delivered ? "dim" : "",
                      href: c.stateToUrl({ view: "history", scope: s.scopeId || c.scope, session: s.id }),
                    }),
                    (s) => c.go({ view: "history", scope: s.scopeId || c.scope, session: s.id }),
                    "This cron has never fired.",
                  ))
            }${total > 25 ? html`<button type="button" class="prompt-toggle" @click=${() => c.go({ view: "history", scope: c.scope, session: null, page: 1, historyKind: "cron", cron: id })}>${"All " + c.plural(total, "fire") + " →"}</button>` : nothing}
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
      `/api/sessions?scope=${encodeURIComponent(c.scope)}&limit=25&category=background&origin=cron&cron=${encodeURIComponent(id)}`,
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
