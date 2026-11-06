import { html, nothing, render } from "lit";
import { formatBytes, relTime } from "../ui.ts";
import { cronScheduleDetail, cronScheduleSummary } from "../cron-format.ts";
import { bareCard, card, denseList as dense, empty, pageHeader, type Header } from "./shared.ts";
import { VIEW_TITLE, type AdminPage } from "./sections.ts";
import { load, orgWide, plural, scopeName, scopeRows, scopeSelect, when } from "./activity.ts";

type Row = Record<string, any>;
const queries = new Map<string, string>();
const dot = (...parts: unknown[]) => parts.filter(Boolean).join(" · ");
const hit = (q: string, ...parts: unknown[]) => !q || parts.join(" ").toLowerCase().includes(q);
const newest = (key: (r: Row) => number) => (a: Row, b: Row) => key(b) - key(a);
const scoped = (page: AdminPage, path: string) => `/api/${path}?scope=${encodeURIComponent(page.scope)}`;

export function searchPage(page: AdminPage, header: Header, body: (q: string) => unknown) {
  const paint = () => {
    const value = queries.get(page.view) ?? "";
    const search = {
      placeholder: "Search " + (VIEW_TITLE[page.view] || page.view).toLowerCase() + "…",
      value,
      onInput: (next: string) => {
        queries.set(page.view, next);
        paint();
      },
    };
    if (page.current())
      render(html`${pageHeader({ ...header, search })}${body(value.trim().toLowerCase())}`, page.host);
  };
  paint();
  return paint;
}

export async function mount(page: AdminPage) {
  const rows = await scopeRows(page);
  if (!page.current()) return;
  const header: Header = { actions: scopeSelect(page, rows) };
  if (page.view === "memory") return memory(page);
  const id = page.view === "crons" ? page.params.get("cron") : null;
  const data = await load(page, scoped(page, page.view), id ? { back: back(page) } : header);
  if (!data) return;
  if (id) return cronDetail(page, data.crons || [], id);
  (({ files, deployments, crons }) as Record<string, typeof files>)[page.view]!(page, data, header);
}

const back = (page: AdminPage, view = page.view, params: Row = { scope: page.scope }) => ({
  label: VIEW_TITLE[view]!,
  href: page.href(view, params),
});

function files(page: AdminPage, data: Row, header: Header) {
  const all = [...(data.files || [])].sort(newest((f) => f.createdAt || 0));
  const capped = all.length >= 2000;
  let [asked, remote, timer] = ["", null as Row[] | null, 0 as unknown as ReturnType<typeof setTimeout>];
  const remoteSearch = (q: string) => {
    if (q === asked) return;
    [asked, remote] = [q, null];
    clearTimeout(timer);
    if (capped && q)
      timer = setTimeout(async () => {
        const r = await page.api("GET", scoped(page, "files") + "&q=" + encodeURIComponent(q));
        if (q !== asked || !r.ok) return;
        remote = [...(r.data?.files || [])].sort(newest((f) => f.createdAt || 0));
        paint();
      }, 250);
  };
  const row = (f: Row) => {
    const name =
      f.name ||
      String(f.path || "")
        .split("/")
        .pop() ||
      "download";
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    return {
      icon: html`<span class="file-thumb">${ext}</span>`,
      name,
      preview: orgWide(page) ? scopeName(f.scopeId) : "",
      time: formatBytes(f.size || 0) + " · " + relTime(f.createdAt),
    };
  };
  const status = { text: "", tone: "muted" };
  const actions = html`${header.actions}<span class=${"status " + status.tone}>${status.text}</span
    ><label class="btn primary"
      >Upload<input class="hidden" type="file" multiple @change=${(e: Event) => upload(page, e, status, paint)}
    /></label>`;
  const paint = searchPage(page, { ...header, count: all.length ? plural(all.length, "file") : "", actions }, (q) => {
    remoteSearch(q);
    const shown = remote ?? all.filter((f) => hit(q, f.name || f.path));
    return bareCard(dense(shown, row, (f) => download(page, f), q ? "No files match." : "No documents saved yet."));
  });
}

function uploadError(text: string) {
  try {
    return JSON.parse(text).message || JSON.parse(text).error;
  } catch {
    return text.trim();
  }
}

async function upload(page: AdminPage, e: Event, status: Row, paint: () => void) {
  const input = e.target as HTMLInputElement;
  const picked = [...(input.files || [])];
  if (!picked.length) return;
  Object.assign(status, { text: "Uploading " + plural(picked.length, "file") + "...", tone: "saving" });
  paint();
  let uploaded = 0;
  try {
    for (const file of picked) {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const query = new URLSearchParams({ scope: page.scope, sha, name: file.name || "file" });
      const response = await fetch(page.apiBase + "/files/upload?" + query, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!response.ok) throw new Error(uploadError(await response.text()) || `Upload failed (${response.status}).`);
      uploaded++;
    }
    return void (await mount(page));
  } catch (error) {
    const done = uploaded ? `Uploaded ${uploaded} of ${picked.length} before failure. ` : "";
    Object.assign(status, { text: done + (error as Error).message, tone: "err" });
  }
  input.value = "";
  paint();
}

async function download(page: AdminPage, f: Row) {
  if (!f.openable) return;
  const check = await page.api("GET", "/api/files/read?id=" + encodeURIComponent(f.id));
  if (!check.ok) return alert(check.data?.message || `Couldn't open file (${check.status}).`);
  const href = page.apiBase + "/files/download?id=" + encodeURIComponent(f.id);
  const mime = (f.mimetype || "").split(";")[0].trim().toLowerCase();
  if (/^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain)$/.test(mime))
    return void window.open(href, "_blank", "noreferrer");
  const a = Object.assign(document.createElement("a"), { href, download: f.name || "download", rel: "noreferrer" });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function deployments(page: AdminPage, data: Row, header: Header) {
  const latest = (r: Row) => r.lastAccessAt || r.createdAt || 0;
  const all = [...(data.deployments || [])].sort(newest(latest));
  const row = (r: Row) => ({
    name: r.name || r.id,
    preview: dot(r.status || "unknown", r.currentVersion, orgWide(page) && scopeName(r.ownerScopeId), r.createdBy),
    time: relTime(latest(r)),
    href: r.publicUrl || undefined,
    target: "_blank",
  });
  searchPage(page, { ...header, count: plural(all.length, "app") }, (q) =>
    bareCard(
      dense(
        all.filter((r) => hit(q, r.name || r.id)),
        row,
        () => {},
        q ? "No apps match." : "No apps yet.",
      ),
    ),
  );
}

const cronName = (c: Row) =>
  c.title ||
  c.message ||
  String(c.action || "")
    .split("\n")[0]
    .slice(0, 96) ||
  "Cron " + c.id;
const cronStatus = (c: Row) => (c.archived && "archived") || (c.enabled === false ? "disabled" : "enabled");

function crons(page: AdminPage, data: Row, header: Header) {
  const latest = (r: Row) => r.lastFiredAt || r.createdAt || 0;
  const all = [...(data.crons || [])].sort(newest(latest));
  const row = (r: Row) => ({
    name: cronName(r),
    preview: dot(
      orgWide(page) && scopeName(r.ownerScopeId),
      cronStatus(r) !== "enabled" && cronStatus(r),
      (r.title ? r.action || r.message : r.message && r.action)?.split("\n")[0].slice(0, 200),
    ),
    time: cronScheduleSummary(r as never) + " · " + (r.lastFiredAt ? relTime(r.lastFiredAt) : "never fired"),
    cls: cronStatus(r) === "enabled" ? "" : "dim",
    href: page.href("crons", { scope: page.scope, cron: r.id }),
  });
  searchPage(page, { ...header, count: plural(all.length, "cron") }, (q) =>
    bareCard(
      dense(
        all.filter((r) => hit(q, cronName(r), r.action || r.message)),
        row,
        (r) => page.go(page.href("crons", { scope: page.scope, cron: r.id })),
        q ? "No crons match." : "No crons yet.",
      ),
    ),
  );
}

function cronDetail(page: AdminPage, all: Row[], id: string) {
  const cron = all.find((row) => row.id === id);
  const header = {
    back: back(page),
    title: cron ? cronName(cron) : "Cron",
    context: cron ? scopeName(cron.ownerScopeId) : "",
  };
  const paint = (body: unknown) => page.current() && render(html`${pageHeader(header)}${body}`, page.host);
  if (!cron) return paint(empty("Cron " + id + " isn't in this scope."));
  const current = () => ({
    type: cron.destination?.type === "principal" ? "principal" : "slack",
    target: cron.destination?.target || "",
    audienceScopeId: cron.destination?.audienceScopeId || "",
    onBehalfOf: cron.destination?.onBehalfOf || "",
  });
  const draft = current();
  let [editing, saving, fires, error, total] = [false, false, null as Row[] | null, "", 0];
  const field = (key: keyof typeof draft) => (e: Event) => {
    draft[key] = (e.target as HTMLInputElement).value;
    draw();
  };
  const save = async (clear = false) => {
    if (saving) return;
    if (!clear && !draft.target.trim()) return alert("Target is required.");
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
    const path = `/api/crons/${encodeURIComponent(id)}/destination?scope=${encodeURIComponent(page.scope)}`;
    const response = await page.api("PUT", path, { destination });
    saving = false;
    if (!response.ok) alert(response.data?.message || "Could not update destination.");
    else {
      cron.destination = destination;
      if (JSON.stringify(draft) === submitted) editing = false;
    }
    draw();
  };
  const dest = cron.destination;
  const facts = () => [
    ["Schedule", cronScheduleDetail(cron as never)],
    [
      "Destination",
      dest
        ? dot(
            `${dest.type} -> ${dest.target}`,
            dest.audienceScopeId,
            dest.onBehalfOf && "on behalf of " + dest.onBehalfOf,
          )
        : "None",
    ],
    ["Owner", cron.owner || cron.createdBy || "None"],
    ["Status", cronStatus(cron)],
    ["Created", cron.createdAt ? new Date(cron.createdAt).toLocaleString() : ""],
    ["Last fired", cron.lastFiredAt ? when(cron.lastFiredAt) : "never fired"],
    ["Id", cron.id],
  ];
  const editor = () =>
    card(
      "Edit cron destination",
      cronName(cron),
      html`<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(160px, 1fr));gap:10px">
          <label
            >Type<select @change=${field("type")}>
              <option value="slack" ?selected=${draft.type === "slack"}>slack</option>
              <option value="principal" ?selected=${draft.type === "principal"}>principal</option>
            </select></label
          ><label
            >Target<input
              name="cron-target"
              .value=${draft.target}
              placeholder=${draft.type === "principal" ? "principal id" : "Slack channel/thread id"}
              @input=${field("target")} /></label
          ><label
            >Audience scope<input
              .value=${draft.audienceScopeId}
              placeholder=${draft.type === "principal" ? "personal:U123" : "channel:C123"}
              @input=${field("audienceScopeId")} /></label
          ><label
            >On behalf of<input
              .value=${draft.onBehalfOf}
              ?disabled=${draft.type !== "principal"}
              @input=${field("onBehalfOf")}
          /></label>
        </div>
        <div class="foot">
          <button type="button" class="btn primary" ?disabled=${saving} @click=${() => save()}>Save destination</button
          ><button class="btn" type="button" ?disabled=${saving} @click=${() => ((editing = false), draw())}>
            Cancel
          </button>
        </div>`,
    );
  const prompt = cron.action || cron.message || "";
  const fireRow = (s: Row) => ({
    name: relTime(s.createdAt || s.lastActivity),
    preview: dot(
      typeof s.delivered === "number" &&
        (s.delivered ? "delivered" + (s.delivered > 1 ? " ×" + s.delivered : "") : "silent"),
      plural(s.turns || 0, "turn"),
      s.result || "(no messages)",
    ),
    time: plural(s.messages || 0, "entry", "entries"),
    cls: typeof s.delivered === "number" && !s.delivered ? "dim" : "",
    href: page.href("history", { scope: s.scopeId || page.scope, session: s.id }),
  });
  const draw = () =>
    paint(
      html`${editing ? editor() : nothing}
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
            class="btn compact rowbtn"
            ?disabled=${saving}
            @click=${() => ((editing = true), Object.assign(draft, current()), draw())}
          >
            Edit destination</button
          ><button
            type="button"
            class="btn compact rowbtn danger"
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
                html`<p class="prompt-body">${prompt}</p>`,
              )
            : nothing
        }
        ${card(
          "Recent fires",
          "Each fire is a session. Click one to read its transcript. Dimmed fires delivered nothing.",
          html`${
            (error && empty(error)) ||
            (fires === null
              ? html`<div class="loadingline">Loading fires...</div>`
              : dense(fires, fireRow, (s) => page.go(fireRow(s).href), "This cron has never fired."))
          }
          ${
            total > 25
              ? html`<a href=${page.href("history", { scope: page.scope, historyKind: "cron", cron: id })}
                  >${"All " + plural(total, "fire") + " →"}</a
                >`
              : nothing
          }`,
        )}`,
    );
  draw();
  const query = `scope=${encodeURIComponent(page.scope)}&limit=25&category=background&origin=cron&cron=${encodeURIComponent(id)}`;
  void page.api("GET", "/api/sessions?" + query).then((response) => {
    if (response.ok) [fires, total] = [response.data.sessions || [], response.data.total || 0];
    else error = response.data?.message || `Failed to load fires (${response.status}).`;
    total ||= fires?.length || 0;
    draw();
  });
}

async function memory(page: AdminPage) {
  if (orgWide(page) && page.params.get("mem") !== "edit") return memoryIndex(page);
  const header = { back: back(page, "memory", {}), title: orgWide(page) ? "Org-wide" : scopeName(page.scope) };
  const data = await load(page, scoped(page, "memory"), header);
  if (!data) return;
  let facts: Row[] = data.facts || [];
  let editing: Row | null = null;
  let [draft, saving, message, tone] = ["", false, "", ""];
  const change = async (method: "POST" | "PATCH" | "DELETE", body: object) => {
    if (saving) return;
    saving = true;
    draw();
    const response = await page.api(method, scoped(page, "memory"), body);
    saving = false;
    if (response.ok) {
      facts = response.data?.facts || [];
      editing = null;
      if (method === "POST") draft = "";
      [message, tone] = ["Saved ✓", "ok"];
    } else {
      const denied = response.status === 403 && "You don't administer this scope.";
      [message, tone] = [denied || response.data?.message || "Save failed.", "err"];
    }
    draw();
  };
  const row = (fact: Row) =>
    editing?.id === fact.id
      ? html`<li>
          <textarea
            aria-label="Fact text"
            .value=${editing!.text}
            @input=${(e: Event) => (editing = { id: fact.id, text: (e.target as HTMLTextAreaElement).value })}
          ></textarea>
          <button class="btn primary" ?disabled=${saving} @click=${() => change("PATCH", { facts: [editing] })}>
            Save</button
          ><button class="btn" @click=${() => ((editing = null), draw())}>Cancel</button>
        </li>`
      : html`<li>
          <span>${fact.text}</span>
          <button class="btn" @click=${() => ((editing = { ...fact }), draw())}>Edit</button
          ><button class="btn" ?disabled=${saving} @click=${() => change("DELETE", { ids: [fact.id] })}>Forget</button>
        </li>`;
  const draw = () =>
    page.current() &&
    render(
      html`${pageHeader(header)}${card(
        "Notebook",
        "What the agent remembers in this scope, one fact per row.",
        html`${
            facts.length
              ? html`<ul class="memory-facts">
                  ${facts.map(row)}
                </ul>`
              : empty("No memory stored for this scope yet.")
          }
          <div class="memory-add">
            <textarea
              aria-label="New fact"
              placeholder="Add a fact"
              .value=${draft}
              @input=${(e: Event) => ((draft = (e.target as HTMLTextAreaElement).value), draw())}
            ></textarea>
            <button
              class="btn primary"
              ?disabled=${saving || !draft.trim()}
              @click=${() => change("POST", { facts: [draft] })}
            >
              Add
            </button>
          </div>
          <span class=${"status " + tone} role="status">${message}</span>`,
      )}`,
      page.host,
    );
  draw();
}

async function memoryIndex(page: AdminPage) {
  const header = {};
  const data = await load(page, "/api/memory/scopes", header);
  if (!data) return;
  const org = (s: Row) => s.scopeId.startsWith("org:");
  const scopes = (data.scopes || [])
    .filter((s: Row) => s.hasMemory || org(s))
    .sort((a: Row, b: Row) => (b.updatedAt || 0) - (a.updatedAt || 0) || (b.bytes || 0) - (a.bytes || 0));
  const href = (s: Row) => page.href("memory", { scope: s.scopeId, mem: org(s) ? "edit" : null });
  const row = (s: Row) => ({
    name: org(s) ? "org" : s.label || scopeName(s.scopeId),
    preview: s.hasMemory ? formatBytes(s.bytes || 0) : "empty",
    time: s.updatedAt ? relTime(s.updatedAt) : "Never",
    href: href(s),
  });
  const count = plural(scopes.filter((s: Row) => s.hasMemory).length, "notebook");
  searchPage(
    page,
    { ...header, count },
    (q) =>
      html`<div class="memory-notebooks">
        <div class="memory-columns"><span>Notebook</span><span>Size</span><span>Last updated</span></div>
        ${dense(
          scopes.filter((s: Row) => hit(q, s.label, s.scopeId)),
          row,
          (s) => page.go(href(s)),
          q ? "No notebooks match your search." : "No notebooks yet. The agent hasn't remembered anything.",
        )}
      </div>`,
  );
}
