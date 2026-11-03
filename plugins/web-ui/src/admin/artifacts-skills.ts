import { html, nothing } from "lit";
import { badge, card, empty, stacked, table, type Header } from "./shared.ts";
import type { AdminPage } from "./sections.ts";
import { load, orgWide, plural, scopeName, scopeRows, scopeSelect } from "./activity.ts";
import { searchPage } from "./artifacts.ts";

type Row = Record<string, any>;
const repo = (url: string) =>
  (url || "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean)
    .slice(-2)
    .join("/") || url;
const enc = encodeURIComponent;

export async function mount(page: AdminPage) {
  const rows = await scopeRows(page);
  if (!page.current()) return;
  const header: Header = { actions: scopeSelect(page, rows) };
  const data = await load(page, "/api/skills?scope=" + enc(page.scope), header);
  if (!data) return;
  const all = orgWide(page);
  const lastUse = (s: Row) => s.lastUsedAt || s.updatedAt || s.createdAt || 0;
  const skills: Row[] = (data.skills || [])
    .filter((s: Row) => s.status !== "archived")
    .sort((a: Row, b: Row) => lastUse(b) - lastUse(a) || (a.name || "").localeCompare(b.name || ""));
  const pending = new Set<string>();
  let detail: unknown = nothing;
  let packs: Row[] | null = null;
  const reload = () => page.current() && mount(page);
  const remove = async (s: Row) => {
    if (pending.has(s.id)) return;
    const where = scopeName(s.ownerScopeId);
    if (!confirm(`Remove '${s.name || s.id}' from ${where}? It stops being available to agents (kept for audit).`))
      return;
    pending.add(s.id);
    paint();
    const response = await page.api("DELETE", `/api/skills/${enc(s.id)}?scope=${enc(s.ownerScopeId || page.scope)}`);
    pending.delete(s.id);
    if (response.ok) return reload();
    alert(response.status ? response.data?.message || "1 scope(s) could not be removed." : "Could not remove skill.");
    paint();
  };
  const open = async (s: Row) => {
    detail = html`<div class="loadingline">${"Loading " + (s.name || s.id) + "…"}</div>`;
    paint();
    const response = await page.api("GET", `/api/skills/${enc(s.id)}?scope=${enc(s.ownerScopeId || page.scope)}`);
    const group = skills.filter((r) => (r.name || r.id) === (s.name || s.id) && r.createdBy === s.createdBy);
    detail =
      response.ok && response.data
        ? skillCard(response.data, group, remove)
        : empty(response.status === 403 ? "You don't administer this skill's scope." : "Couldn't load this skill.");
    paint();
  };
  const createdBy = (s: Row) =>
    (s.pack && repo(s.pack.url)) || (s.createdBy?.startsWith("system:") ? "built-in" : s.createdBy || "None");
  const count = plural(skills.length, "skill");
  const paint = searchPage(page, { ...header, count }, (q) => {
    const shown = skills.filter((s) => !q || [s.name || s.id, s.description].join(" ").toLowerCase().includes(q));
    const rowsOf = shown.map((s) => [
      { node: stacked(s.name || s.id, s.description || s.id) },
      ...(all ? [{ text: scopeName(s.ownerScopeId), cls: "mono" }] : []),
      { text: s.status || "unknown", cls: "subline" },
      { text: createdBy(s), cls: "mono" },
      { text: s.lastUsedAt ? new Date(s.lastUsedAt).toLocaleString() : "never", cls: "num" },
      {
        node: html`<button
          type="button"
          class="btn compact rowbtn danger"
          ?disabled=${pending.has(s.id)}
          @click=${(e: Event) => (e.stopPropagation(), remove(s))}
        >
          Remove
        </button>`,
      },
    ]);
    return html`${packs ? packCard(page, packs, reload, paint) : nothing}${card(
      "Installed skills",
      "",
      table(
        ["Skill", ...(all ? ["Scope"] : []), "Status", "Created by", "Last used", ""],
        rowsOf,
        q ? "No skills match." : "No skills yet.",
        (i) => open(shown[i]!),
        { className: "skills-table" },
      ),
    )}${detail}`;
  });
  packState.browse = nothing;
  if (!all) return;
  const response = await page.api("GET", "/api/skill-packs");
  if (!page.current()) return;
  packs = (response.ok && response.data?.packs) || [];
  paint();
}

function skillCard(k: Row, group: Row[], remove: (s: Row) => void) {
  const granted = k.grantedCapabilities || [];
  const by =
    (k.pack && "from " + repo(k.pack.url)) ||
    (k.createdBy?.startsWith("system:") ? "built-in" : "by " + (k.createdBy || "None"));
  return card(
    k.name || k.id,
    "",
    html`<div class="badges">
        ${badge(k.status || "unknown")}${badge("v" + k.version, "muted")}${badge(by, "muted")}
      </div>
      ${k.description ? html`<p class="metric-note">${k.description}</p>` : nothing}
      ${card(
        "Scopes (" + group.length + ")",
        "Every scope this skill is installed in. Remove takes it out of that scope only.",
        table(
          ["Scope", "Status", "Version", ""],
          group.map((g) => [
            { text: scopeName(g.ownerScopeId), cls: "mono" },
            g.status || "unknown",
            { text: g.version != null ? "v" + g.version : "None", cls: "num" },
            {
              node: html`<button type="button" class="btn compact rowbtn danger" @click=${() => remove(g)}>
                Remove
              </button>`,
            },
          ]),
          "None",
        ),
      )}
      ${card(
        "Capabilities",
        "What the skill is allowed to reach. Granted at review time.",
        table(
          ["Capability", "Status"],
          (k.requiredCapabilities || []).map((cap: string) => [
            { text: cap, cls: "mono" },
            { node: granted.includes(cap) ? badge("granted", "ok") : badge("not granted", "warn") },
          ]),
          "Requires no capabilities.",
        ),
      )}
      ${
        k.approvals?.length
          ? card(
              "Approvals",
              "Reviewers who signed off on this skill.",
              html`<p class="mono">${k.approvals.join(", ")}</p>`,
            )
          : nothing
      }
      ${card(
        "Instructions",
        "The SKILL.md the agent reads when this skill is in play.",
        html`<pre class="skillbody">${k.body || "(empty)"}</pre>`,
      )}`,
  );
}

const draft = { url: "", ref: "", exclude: "", slug: "", tier: "third-party" };
const packState = { message: "", tone: "", busy: false, statuses: new Map<string, Row>(), browse: nothing as unknown };

function packCard(page: AdminPage, packs: Row[], reload: () => void, paint: () => void) {
  const s = packState;
  const input = (key: keyof typeof draft, placeholder: string) =>
    html`<input
      type="text"
      placeholder=${placeholder}
      aria-label=${placeholder}
      .value=${draft[key]}
      @input=${(e: Event) => (draft[key] = (e.target as HTMLInputElement).value)}
    />`;
  const register = async () => {
    if (s.busy) return;
    if (!draft.url.trim()) return (Object.assign(s, { message: "A repo URL is required.", tone: "err" }), paint());
    const excluded = draft.exclude.split(",").flatMap((x) => x.trim() || []);
    Object.assign(s, { busy: true, message: "Registering…", tone: "" });
    paint();
    const response = await page.api("POST", "/api/skill-packs", {
      url: draft.url.trim(),
      ...(draft.ref.trim() ? { ref: draft.ref.trim() } : {}),
      ...(excluded.length ? { config: { exclude: excluded } } : {}),
      ...(draft.slug.trim() ? { authCredentialSlug: draft.slug.trim() } : {}),
      ...(draft.tier !== "third-party" ? { trustTier: draft.tier } : {}),
    });
    s.busy = false;
    if (!response.ok)
      return (
        Object.assign(s, { message: response.data?.message || `Failed (${response.status}).`, tone: "err" }),
        paint()
      );
    Object.assign(draft, { url: "", ref: "", exclude: "", slug: "", tier: "third-party" });
    Object.assign(s, { message: "", tone: "" });
    reload();
  };
  const act = async (p: Row, action: "sync" | "track" | "remove") => {
    if (action === "remove" && !confirm("Remove this pack and archive its imported skills?")) return;
    const sync = action === "sync";
    if (sync) s.statuses.set(p.id, { text: "syncing…", tone: "saving" });
    paint();
    const syncMode = p.syncMode === "tracked" ? "pinned" : "tracked";
    const [method, body] = ({ remove: ["DELETE"], sync: ["POST", {}], track: ["PATCH", { syncMode }] } as Row)[action];
    const response = await page.api(method, `/api/skill-packs/${enc(p.id)}${sync ? "/sync" : ""}`, body);
    if (!response.ok) {
      s.statuses.set(p.id, {
        text: (sync ? "sync failed: " : "Failed: ") + (response.data?.message || response.status),
        tone: "err",
      });
      return paint();
    }
    if (!sync) return reload();
    const [n, u, a] = ["imported", "updated", "archived"].map((k) => (response.data?.[k] || []).length);
    const text =
      n || u || a ? `✓ ${n} new${u ? " · " + u + " updated" : ""}${a ? " · " + a + " removed" : ""}` : "✓ up to date";
    s.statuses.set(p.id, { text, tone: "ok" });
    paint();
  };
  const status = (p: Row) =>
    s.statuses.get(p.id) ||
    (p.lastImport?.status === "error" && { text: "error: " + (p.lastImport.error || "sync failed"), tone: "err" }) ||
    (p.updateAvailable && { text: "update available", tone: "dirty" }) || {
      text: p.lastImport ? "up to date" : "not imported",
      tone: "muted",
    };
  const rows = packs.map((p) => {
    const st = status(p);
    return [
      {
        node: html`<span class="pack-name" title=${p.url}
          ><strong>${repo(p.url)}</strong
          >${p.ref ? html`<span class="subline"> @ ${p.ref.slice(0, 10)}</span>` : nothing}</span
        >`,
      },
      { text: p.available != null ? (p.importedCount || 0) + " of " + p.available : "n/a", cls: "num" },
      { text: p.trustTier + (p.syncMode === "tracked" ? " · auto-sync" : ""), cls: "subline" },
      { node: html`<span class=${"status " + st.tone}>${st.text}</span>` },
      {
        node: html`<button type="button" class="btn compact rowbtn" @click=${() => browse(page, p, reload, paint)}>
            Browse skills…</button
          ><button type="button" class="btn compact rowbtn" @click=${() => act(p, "sync")}>Sync now</button
          ><button type="button" class="btn compact rowbtn" @click=${() => act(p, "track")}>
            ${p.syncMode === "tracked" ? "Turn off auto-sync" : "Turn on auto-sync"}</button
          ><button type="button" class="btn compact rowbtn danger" @click=${() => act(p, "remove")}>
            Remove pack
          </button>`,
        cls: "num",
      },
    ];
  });
  return html`${card(
    "Skill packs",
    "Register a repository, then choose which skills to import into each scope.",
    html`<div class="pack-register">
        ${input("url", "Register a pack: paste a git repo URL of SKILL.md files, then Browse it into scopes")}<button
          type="button"
          class="btn primary"
          ?disabled=${s.busy}
          @click=${register}
        >
          Register</button
        ><span class=${"status " + s.tone}>${s.message}</span>
      </div>
      <details>
        <summary>Advanced</summary>
        <div class="pack-adv">
          ${input("ref", "ref (branch or SHA)")}${input("exclude", "exclude globs, comma-separated")}${input(
            "slug",
            "deploy-token slug",
          )}<select title="Trust tier" @change=${(e: Event) => (draft.tier = (e.target as HTMLSelectElement).value)}>
            <option value="third-party" ?selected=${draft.tier === "third-party"}>trust: third-party</option>
            <option value="internal" ?selected=${draft.tier === "internal"}>trust: internal</option>
          </select>
        </div>
      </details>
      ${table(["Pack", "Skills", "Trust", "Status", ""], rows, "No packs yet. Register one above.")}`,
  )}${s.browse}`;
}

async function browse(page: AdminPage, pack: Row, reload: () => void, paint: () => void) {
  const s = packState;
  s.browse = html`<div class="loadingline">${"Fetching " + pack.url + "…"}</div>`;
  paint();
  const response = await page.api("GET", `/api/skill-packs/${enc(pack.id)}/catalog`);
  if (!response.ok || !response.data) {
    s.browse = empty(response.data?.message || `Couldn't browse (${response.status}).`);
    return paint();
  }
  const candidates: Row[] = response.data.candidates || [];
  const scopes = await scopeRows(page);
  let targets = [page.orgScope];
  let [busy, message, tone] = [false, "", ""];
  const imported = (r: Row) => targets.every((t) => (r.importedScopes || []).includes(t));
  const eligible = (r: Row) => r.eligible && !imported(r);
  const selected = new Set(candidates.filter((r) => r.eligible).map((r) => r.upstreamName));
  const run = async () => {
    if (busy) return;
    const names = candidates.filter((r) => eligible(r) && selected.has(r.upstreamName)).map((r) => r.upstreamName);
    if (!targets.length || !names.length) {
      [message, tone] = [
        !targets.length ? "Pick at least one scope to add skills to." : "Select at least one skill.",
        "err",
      ];
      return draw();
    }
    [busy, message, tone] = [true, "Importing…", ""];
    draw();
    const result = await page.api("POST", `/api/skill-packs/${enc(pack.id)}/import`, {
      selected: names.length === candidates.filter(eligible).length ? "all" : names,
      scopeIds: targets,
    });
    busy = false;
    if (!result.ok) [message, tone] = [result.data?.message || `Import failed (${result.status}).`, "err"];
    else {
      const added = result.data.imported?.length ?? 0;
      const across = targets.length > 1 ? " across " + targets.length + " scopes" : "";
      [message, tone] = [`✓ ${added} skill${added === 1 ? "" : "s"} added${across}`, "ok"];
      setTimeout(reload, 1500);
    }
    draw();
  };
  const rowBadge = (r: Row) =>
    (imported(r) && badge("imported", "info")) ||
    (r.eligible ? badge("eligible", "ok") : badge(r.excludeReason || "excluded", "warn"));
  const draw = () => {
    s.browse = card(
      "Browse: " + pack.url,
      "Choose target scopes, then import. Eligible skills are added to every selected scope; excluded skills show why. They appear on the Skills page once imported.",
      html`<label
          >Add to scopes:
          <select
            multiple
            @change=${(e: Event) => {
              targets = [...(e.target as HTMLSelectElement).selectedOptions].map((o) => o.value);
              draw();
            }}
          >
            ${[{ scopeId: page.orgScope }, ...scopes.filter((r) => !r.scopeId.startsWith("org:"))].map(
              (r) =>
                html`<option value=${r.scopeId} ?selected=${targets.includes(r.scopeId)}>
                  ${r.scopeId.startsWith("org:") ? "org-wide" : scopeName(r.scopeId)}
                </option>`,
            )}
          </select></label
        >
        ${table(
          ["", "Skill", ""],
          candidates.map((r) => [
            {
              node: html`<input
                type="checkbox"
                data-name=${r.upstreamName}
                .checked=${eligible(r) && selected.has(r.upstreamName)}
                ?disabled=${!eligible(r)}
                @change=${(e: Event) => selected[(e.target as HTMLInputElement).checked ? "add" : "delete"](r.upstreamName)}
              />`,
            },
            { node: stacked(r.upstreamName, r.normalized?.manifest?.description || "") },
            { node: rowBadge(r) },
          ]),
          "No skills found in this pack.",
        )}
        <button type="button" class="btn primary" ?disabled=${busy} @click=${run}>Import selected</button
        ><span class=${"status " + tone}>${message}</span>
        <button class="btn" type="button" @click=${() => ((s.browse = nothing), paint())}>Close</button>`,
    );
    paint();
  };
  draw();
}
