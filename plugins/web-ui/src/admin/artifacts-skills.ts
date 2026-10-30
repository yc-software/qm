import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { badge, card, table, renderer, stacked } from "./shared.ts";
import type { Context, Data } from "./artifacts.ts";
export async function removeSkill(s: Data, c: Context) {
  const where = c.dirLabel(s.ownerScopeId) || s.ownerScopeId;
  if (!confirm(`Remove '${s.name || s.id}' from ${where}? It stops being available to agents (kept for audit).`))
    return;
  try {
    const response = await c.api(
      "DELETE",
      "/api/skills/" + encodeURIComponent(s.id) + "?scope=" + encodeURIComponent(s.ownerScopeId || c.scope),
    );
    if (!response.ok) return alert(response.data?.message || "1 scope(s) could not be removed.");
    c.invalidate();
    await c.reload();
  } catch {
    alert("Could not remove skill.");
  }
}
export async function skillDetail(root: HTMLElement, rep: Data, group: Data[], c: Context) {
  root.replaceChildren();
  const paint = renderer(root);
  paint(html`<div class="loadingline">${"Loading " + (rep.name || rep.id) + "…"}</div>`);
  const response = await c.api(
    "GET",
    "/api/skills/" + encodeURIComponent(rep.id) + "?scope=" + encodeURIComponent(rep.ownerScopeId || c.scope),
  );
  if (!response.ok || !response.data)
    return paint(
      html`<p class="empty">
        ${response.status === 403 ? "You don't administer this skill's scope." : "Couldn't load this skill."}
      </p>`,
    );
  const k = response.data;
  const by =
    (k.pack && "from " + (c.packRepoLabel(k.pack.url) || "pack " + c.shortId(k.pack.id, 8))) ||
    (k.createdBy?.startsWith("system:") ? "built-in" : "by " + (k.createdBy || "None"));
  const org = (g: Data) => c.scopeKind(g.ownerScopeId) === "org";
  const granted = k.grantedCapabilities || [];
  paint(
    card(
      k.name || k.id,
      "",
      html`<div>
        <div class="badges">
          ${c.statusBadge(k.status)}${badge("v" + k.version, "muted")}${badge(by, "muted")}${badge("skill " + c.shortId(k.id, 16), "muted")}
        </div>
        ${k.description ? html`<p class="metric-note">${k.description}</p>` : nothing}${card(
          "Scopes (" + group.length + ")",
          "Every scope this skill is installed in. Remove takes it out of that scope only.",
          table(
            ["Scope", "Status", "Version", ""],
            [...group]
              .sort(
                (a, b) => (org(a) && -1) || (org(b) && 1) || (a.ownerScopeId || "").localeCompare(b.ownerScopeId || ""),
              )
              .map((g) => [
                c.scopeCell(g.ownerScopeId),
                { node: c.statusBadge(g.status) },
                { text: g.version != null ? "v" + g.version : "None", cls: "num" },
                {
                  node:
                    g.status === "archived"
                      ? badge("archived", "muted")
                      : html`<button type="button" class="rowbtn danger" @click=${() => removeSkill(g, c)}>
                          Remove
                        </button>`,
                },
              ]),
            "None",
          ),
        )}${card(
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
        )}${
          k.approvals?.length
            ? card(
                "Approvals",
                "Reviewers who signed off on this skill.",
                table(
                  ["Reviewer"],
                  k.approvals.map((a: string) => [{ text: a, cls: "mono" }]),
                  "",
                ),
              )
            : nothing
        }${card("Instructions", "The SKILL.md the agent reads when this skill is in play.", html`<pre class="skillbody" style="white-space:pre-wrap;font-family:ui-monospace, SFMono-Regular, Menlo, monospace;font-size:12px;margin:0">${k.body || "(empty)"}</pre>`)}
      </div>`,
    ),
  );
  root.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
export async function mountPacks(root: HTMLElement, c: Context) {
  const response = await c.api("GET", "/api/skill-packs");
  if (!root.isConnected) return;
  packs(root, (response.ok && response.data?.packs) || [], c);
}
export function packs(root: HTMLElement, rows: Data[], c: Context) {
  const paint = renderer(root);
  const detail = document.createElement("div");
  const draft = { url: "", ref: "", exclude: "", slug: "", tier: "third-party" };
  let [advanced, registering, message, tone] = [false, false, "", ""];
  let [menu, menuTop, menuLeft] = [null as string | null, 0, 0];
  const statuses = new Map<string, Data>();
  const pending = new Set<string>();
  const closeMenu = () => menu && ((menu = null), draw());
  const abort = new AbortController();
  document.addEventListener("click", closeMenu, { signal: abort.signal });
  document.addEventListener("scroll", closeMenu, { signal: abort.signal, capture: true });
  window.addEventListener("resize", closeMenu, { signal: abort.signal });
  const observer = new MutationObserver(() => {
    if (!root.isConnected) {
      abort.abort();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const change = (key: keyof typeof draft) => (e: Event) => {
    draft[key] = (e.target as HTMLInputElement).value;
    draw();
  };
  const register = async () => {
    if (registering) return;
    if (!draft.url.trim()) {
      [message, tone] = ["A repo URL is required.", "err"];
      return draw();
    }
    const submitted = JSON.stringify(draft);
    [registering, message, tone] = [true, "Registering…", ""];
    draw();
    const excluded = draft.exclude.split(",").flatMap((x) => x.trim() || []);
    try {
      const response = await c.api("POST", "/api/skill-packs", {
        url: draft.url.trim(),
        ...(draft.ref.trim() ? { ref: draft.ref.trim() } : {}),
        ...(excluded.length ? { config: { exclude: excluded } } : {}),
        ...(draft.slug.trim() ? { authCredentialSlug: draft.slug.trim() } : {}),
        ...(draft.tier !== "third-party" ? { trustTier: draft.tier } : {}),
      });
      if (!response.ok) [message, tone] = [response.data?.message || "Failed (" + response.status + ").", "err"];
      else {
        c.invalidate();
        if (JSON.stringify(draft) === submitted) await c.reload();
        else [message, tone] = ["Pack registered. Your newer changes have not been registered.", "ok"];
      }
    } catch {
      [message, tone] = ["Registration failed.", "err"];
    } finally {
      registering = false;
      draw();
    }
  };
  const act = async (s: Data, action: string) => {
    menu = null;
    if (action === "browse") {
      draw();
      return void browsePack(s, detail, c);
    }
    if (pending.has(s.id)) return;
    if (action === "remove" && !confirm("Remove this pack and archive its imported skills?")) return draw();
    pending.add(s.id);
    const sync = action === "sync";
    if (sync) statuses.set(s.id, { text: "syncing…", tone: "saving" });
    draw();
    try {
      const syncMode = s.syncMode === "tracked" ? "pinned" : "tracked";
      const [method, body] = ({ remove: ["DELETE"], sync: ["POST", {}], track: ["PATCH", { syncMode }] } as Data)[
        action
      ];
      const response = await c.api(
        method,
        "/api/skill-packs/" + encodeURIComponent(s.id) + (sync ? "/sync" : ""),
        body,
      );
      if (!response.ok) {
        const text = (sync ? "sync failed: " : "Failed: ") + (response.data?.message || response.status);
        return void statuses.set(s.id, { text, tone: "err" });
      }
      if (sync) {
        const [n, u, a] = ["imported", "updated", "archived"].map((k) => (response.data?.[k] || []).length);
        statuses.set(s.id, {
          text:
            n || u || a
              ? "✓ " + n + " new" + (u ? " · " + u + " updated" : "") + (a ? " · " + a + " removed" : "")
              : "✓ up to date",
          tone: "ok",
        });
        setTimeout(() => {
          c.invalidate();
          if (root.isConnected) c.reload();
        }, 1200);
      } else {
        c.invalidate();
        await c.reload();
      }
    } catch {
      statuses.set(s.id, { text: "Request failed.", tone: "err" });
    } finally {
      pending.delete(s.id);
      draw();
    }
  };
  const input = (key: keyof typeof draft, placeholder: string, title?: string) =>
    html`<input
      type="text"
      placeholder=${placeholder}
      title=${ifDefined(title)}
      aria-label=${placeholder}
      spellcheck="false"
      .value=${draft[key]}
      @input=${change(key)}
    />`;
  const draw = () =>
    paint(
      html`${card(
        "Skill packs",
        "Register a repository, then choose which skills to import into each scope.",
        html`<div>
          <div class="pack-register">
            ${input("url", "Register a pack: paste a git repo URL of SKILL.md files, then Browse it into scopes")}<button
              type="button"
              class=${"linkish" + (advanced ? " open" : "")}
              aria-expanded=${String(advanced)}
              @click=${() => ((advanced = !advanced), draw())}
            >
              ${"Advanced" + (!advanced && (draft.ref.trim() || draft.exclude.trim() || draft.slug.trim() || draft.tier !== "third-party") ? " •" : "")}</button
            ><button type="button" class="primary" ?disabled=${registering} @click=${register}>Register</button
            ><span class=${"status" + (tone ? " " + tone : "")}>${message}</span>
          </div>
          <div class=${"pack-adv" + (advanced ? "" : " hidden")}>
            ${input("ref", "ref (branch or SHA)", "Pin to a branch or full 40-hex commit SHA. Blank = the repo's default branch.")}${input("exclude", "exclude globs, comma-separated", "e.g. trusted/*")}${input("slug", "deploy-token slug", "Private-repo deploy-token credential slug. Blank = your connected GitHub account.")}<select
              title="Trust tier"
              .value=${draft.tier}
              @change=${change("tier")}
            >
              <option value="third-party">trust: third-party</option>
              <option value="internal">trust: internal</option>
            </select>
          </div>
          ${table(
            ["Pack", "Skills", "Trust", "Status", ""],
            rows.map((s) => {
              const li = s.lastImport,
                counts = li?.counts || {},
                tracked = s.syncMode === "tracked";
              const removed = counts.archived ? ` · ${counts.archived} removed` : "";
              const delta = li
                ? `last sync: ${counts.imported || 0} new · ${counts.updated || 0} updated · ${counts.skipped || 0} skipped${removed}`
                : "";
              const status =
                statuses.get(s.id) ||
                (li?.status === "error" && {
                  text: "error: " + (li.error || "sync failed"),
                  tone: "err",
                  title: li.error || "",
                }) ||
                (s.updateAvailable
                  ? {
                      text: "update available",
                      tone: "dirty",
                      title: "Upstream advanced past the imported commit. Sync now (or turn on Auto-sync) to apply.",
                    }
                  : { text: li ? "up to date" : "not imported", tone: "muted", title: delta });
              return [
                {
                  node: html`<span class="pack-name" title=${s.url + (delta ? "\n" + delta : "")}
                    ><strong>${c.packRepoLabel(s.url) || s.url}</strong
                    >${s.ref ? html`<span class="subline">${" @ " + c.shortId(s.ref, 10)}</span>` : nothing}</span
                  >`,
                },
                {
                  node: html`<span
                    title=${ifDefined(s.available != null ? (s.importedCount || 0) + " imported · " + s.available + " available (eligible) in this pack" : undefined)}
                    >${s.available != null ? (s.importedCount || 0) + " of " + s.available : "n/a"}</span
                  >`,
                  cls: "num",
                },
                { text: s.trustTier + (tracked ? " · auto-sync" : ""), cls: "subline" },
                {
                  node: html`<span class=${"status " + status.tone} title=${ifDefined(status.title || undefined)}
                    >${status.text}</span
                  >`,
                },
                {
                  node: html`<div class="ovwrap">
                    <button
                      type="button"
                      class="rowbtn"
                      aria-label="Actions"
                      aria-haspopup="menu"
                      aria-expanded=${String(menu === s.id)}
                      @click=${(e: MouseEvent) => {
                        e.stopPropagation();
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        menu = menu === s.id ? null : s.id;
                        menuTop = r.bottom + 4;
                        menuLeft = r.right;
                        draw();
                        const el = root.querySelector<HTMLElement>(".ovmenu:not(.hidden)");
                        if (el) {
                          menuLeft = Math.max(8, r.right - el.offsetWidth);
                          draw();
                        }
                      }}
                    >
                      ⋯
                    </button>
                    <div
                      class=${"ovmenu" + (menu === s.id ? "" : " hidden")}
                      role="menu"
                      style=${`top:${menuTop}px;left:${menuLeft}px`}
                    >
                      ${[
                        ["browse", "Browse skills…"],
                        ["sync", "Sync now"],
                        ["track", tracked ? "Turn off auto-sync" : "Turn on auto-sync"],
                        ["remove", "Remove pack"],
                      ].map(
                        ([action, label]) =>
                          html`<button
                            type="button"
                            class=${ifDefined(action === "remove" ? "danger" : undefined)}
                            ?disabled=${pending.has(s.id)}
                            @click=${(e: MouseEvent) => {
                              e.stopPropagation();
                              void act(s, action);
                            }}
                          >
                            ${label}
                          </button>`,
                      )}
                    </div>
                  </div>`,
                  cls: "num",
                },
              ];
            }),
            "No packs yet. Register one above.",
          )}
        </div>`,
      )}${detail}`,
    );
  draw();
}
export async function browsePack(pack: Data, root: HTMLElement, c: Context) {
  root.replaceChildren();
  const paint = renderer(root);
  paint(html`<div class="loadingline">${"Fetching " + pack.url + "…"}</div>`);
  const response = await c.api("GET", "/api/skill-packs/" + encodeURIComponent(pack.id) + "/catalog");
  if (!response.ok || !response.data)
    return paint(html`<p class="empty">${response.data?.message || "Couldn't browse (" + response.status + ")."}</p>`);
  const plan = response.data,
    candidates: Data[] = plan.candidates || [],
    counts = plan.counts || {};
  const selectedScopes = new Set<string>(["org:" + c.orgId]);
  const selected = new Set<string>();
  let [filter, busy, message, tone, closed] = ["all", false, "", "", false];
  const all = (row: Data) =>
    selectedScopes.size > 0 && [...selectedScopes].every((scope) => (row.importedScopes || []).includes(scope));
  const eligible = (row: Data) => row.eligible && !all(row);
  const state = (r: Data) => (all(r) && "imported") || (r.eligible ? "eligible" : r.excludeReason || "excluded");
  let previousEligible = new Set<string>();
  const recompute = () => {
    const next = new Set(candidates.filter(eligible).map((r) => r.upstreamName));
    for (const r of candidates) {
      if (!next.has(r.upstreamName)) selected.delete(r.upstreamName);
      else if (!previousEligible.has(r.upstreamName)) selected.add(r.upstreamName);
    }
    previousEligible = next;
    draw();
  };
  const held = (label: string, help: string) => ({ label, tone: "muted", help: "Held back: " + help });
  const reasons: Record<string, Data> = {
    all: { label: "all", tone: "muted", help: "Show every skill." },
    eligible: {
      label: "eligible",
      tone: "ok",
      help: "Eligible and not yet in the selected scope(s). Importing adds it there.",
    },
    imported: {
      label: "imported",
      tone: "info",
      help: "Already imported into the selected scope(s). Sync refreshes them; un-index to remove.",
    },
    scope: held("personal-scoped", "declares a personal/owner scope, so it isn't imported as a shared pack skill."),
    private: held("private", "marked owner-only / agent-only."),
    collision: held("collision", "the name matches an existing platform or seed skill."),
    "binary-asset": held("binary files", "contains binary files (import is text-only)."),
    malformed: held("malformed", "missing or unreadable SKILL.md frontmatter."),
  };
  const rowBadge = (row: Data) => {
    const where = (row.importedScopes || []).join(", ");
    if (all(row)) return badge("imported", "info", "Already imported into the selected scope(s): " + where);
    const reason = reasons[row.excludeReason];
    if (!row.eligible) return badge(reason?.label || row.excludeReason || "excluded", "warn", reason?.help || "");
    const partial = [...selectedScopes].some((s) => (row.importedScopes || []).includes(s));
    return badge(
      "eligible",
      "ok",
      partial ? "Imported into " + where + ". Importing adds it to the other selected scope(s)." : "",
    );
  };
  const choices = [
    { scopeId: "org:" + c.orgId, label: "org-wide" },
    ...c.scopeRows().map((r: Data) => ({ scopeId: r.scopeId, label: r.label || c.dirLabel(r.scopeId) || r.scopeId })),
  ];
  const picker = c.buildScopeMultiSelect(choices, selectedScopes, recompute);
  const importSelected = async () => {
    if (busy) return;
    if (!selectedScopes.size || !selected.size) {
      tone = "err";
      message = !selectedScopes.size ? "Pick at least one scope to add skills to." : "Select at least one skill.";
      return draw();
    }
    [busy, message, tone] = [true, "Importing…", ""];
    draw();
    const scopes = [...selectedScopes],
      names = [...selected];
    try {
      const result = await c.api("POST", "/api/skill-packs/" + encodeURIComponent(pack.id) + "/import", {
        selected: names.length === candidates.filter(eligible).length ? "all" : names,
        scopeIds: scopes,
      });
      if (!result.ok) [message, tone] = [result.data?.message || "Import failed (" + result.status + ").", "err"];
      else {
        const added = result.data.imported?.length ?? 0;
        const across = scopes.length > 1 ? " across " + scopes.length + " scopes" : "";
        [message, tone] = [`✓ ${added} skill${added === 1 ? "" : "s"} added${across}`, "ok"];
        c.invalidate();
        setTimeout(() => {
          if (root.isConnected && !closed) c.reload();
        }, 1500);
      }
    } catch {
      [message, tone] = ["Import failed.", "err"];
    } finally {
      busy = false;
      draw();
    }
  };
  const action = (bottom = false) =>
    html`<div
      style=${"display:flex;flex-direction:column;align-items:flex-start;gap:6px;" + (bottom ? "margin-top:10px" : "")}
    >
      <button type="button" class="primary" ?disabled=${busy} @click=${importSelected}>Import selected</button
      ><span class=${"status" + (tone ? " " + tone : "")}>${message}</span>
    </div>`;
  const draw = () => {
    if (closed) return;
    const importable = candidates.filter(eligible),
      selectedCount = importable.filter((r) => selected.has(r.upstreamName)).length;
    const shown = candidates.filter((r) => filter === "all" || state(r) === filter);
    const tally: Data = {
      all: candidates.length,
      eligible: importable.length,
      imported: candidates.filter(all).length,
    };
    paint(
      html`<section class="card" style="position:relative">
        <div class="head">
          <h2>${"Browse: " + pack.url}</h2>
          <p>
            Choose target scopes, then import. Eligible skills are added to every selected scope; excluded skills show
            why. They appear on the Skills page once imported.
          </p>
        </div>
        <div class="body">
          <div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:2px 0 4px">
              <span style="font-size:12px;opacity:0.7">Add to scopes:</span>${picker}
            </div>
            ${
              plan.bundlePaths?.length
                ? html`<details style="margin:8px 0">
                    <summary>
                      ${plan.bundlePaths.length + " shared pack file" + (plan.bundlePaths.length === 1 ? "" : "s") + " (contained under a pack-owned directory)"}
                    </summary>
                    <pre
                      style="max-height:180px;overflow:auto;font-size:11px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)"
                    >
${plan.bundlePaths.join("\n")}</pre>
                  </details>`
                : nothing
            }
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:10px 0 16px">
              <div class="badges" style="flex:1">
                ${Object.entries(reasons)
                  .filter(
                    ([key]) =>
                      key === "all" ||
                      key === "eligible" ||
                      (key === "imported" ? candidates.some((r) => r.importedScopes?.length) : counts[key]),
                  )
                  .map(
                    ([key, reason]) =>
                      html`<span
                        class=${"badge " + reason.tone}
                        style=${"cursor:pointer;" + (filter === key ? "background:var(--text);color:#fff;border-color:var(--text)" : "")}
                        title=${reason.help + " " + (key === "all" ? "" : "Click to show only these.")}
                        @click=${() => ((filter = key), draw())}
                        >${(tally[key] ?? (counts[key] || 0)) + " " + reason.label}</span
                      >`,
                  )}
              </div>
              ${action()}
            </div>
            <div>
              ${table(
                [
                  html`<input
                    type="checkbox"
                    title="Select / deselect all importable skills"
                    .checked=${importable.length > 0 && selectedCount === importable.length}
                    .indeterminate=${selectedCount > 0 && selectedCount < importable.length}
                    @change=${(e: Event) => {
                      const toggle = (e.target as HTMLInputElement).checked ? "add" : "delete";
                      for (const row of importable) selected[toggle](row.upstreamName);
                      draw();
                    }}
                  />`,
                  "Skill",
                  "",
                ],
                shown.map((row) => [
                  {
                    node: html`<input
                      type="checkbox"
                      data-name=${row.upstreamName}
                      .checked=${selected.has(row.upstreamName)}
                      ?disabled=${!eligible(row)}
                      @change=${(e: Event) => (selected[(e.target as HTMLInputElement).checked ? "add" : "delete"](row.upstreamName), draw())}
                    />`,
                  },
                  { node: stacked(row.upstreamName, row.normalized?.manifest?.description || "") },
                  { node: rowBadge(row) },
                ]),
                filter === "all"
                  ? "No skills found in this pack."
                  : "No " + (reasons[filter]?.label || filter) + " skills.",
              )}
            </div>
            ${action(true)}
          </div>
        </div>
        <button
          type="button"
          title="Close"
          aria-label="Close browse"
          style="position:absolute;top:10px;right:12px;border:none;background:transparent;cursor:pointer;font-size:18px;line-height:1;color:var(--text);opacity:0.55;padding:4px"
          @mouseenter=${(e: Event) => ((e.target as HTMLElement).style.opacity = "1")}
          @mouseleave=${(e: Event) => ((e.target as HTMLElement).style.opacity = "0.55")}
          @click=${() => ((closed = true), paint(nothing))}
        >
          ✕
        </button>
      </section>`,
    );
  };
  recompute();
  root.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
