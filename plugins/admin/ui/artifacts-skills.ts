import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { card, table, renderer } from "./shared.ts";
import type { Context, Data } from "./artifacts.ts";
const badge = (text: unknown, tone = "muted", title = "") =>
  html`<span class=${"badge " + tone} title=${ifDefined(title || undefined)}>${text}</span>`;
const stacked = (name: unknown, desc: unknown) =>
  html`<div>
    <div class="primaryline">${name}</div>
    ${desc ? html`<div class="subline">${desc}</div>` : nothing}
  </div>`;
export async function removeSkill(s: Data, c: Context) {
  if (
    !confirm(
      "Remove '" +
        (s.name || s.id) +
        "' from " +
        (c.dirLabel(s.ownerScopeId) || s.ownerScopeId) +
        "? It stops being available to agents (kept for audit).",
    )
  )
    return;
  try {
    const response = await c.api(
      "DELETE",
      "/api/skills/" + encodeURIComponent(s.id) + "?scope=" + encodeURIComponent(s.ownerScopeId || c.scope),
    );
    if (!response.ok) {
      alert(response.data?.message || "1 scope(s) could not be removed.");
      return;
    }
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
  if (!response.ok || !response.data) {
    paint(
      html`<p class="empty">
        ${response.status === 403 ? "You don't administer this skill's scope." : "Couldn't load this skill."}
      </p>`,
    );
    return;
  }
  const k = response.data;
  const by = (() => {
    if (k.pack) return "from " + (c.packRepoLabel(k.pack.url) || "pack " + c.shortId(k.pack.id, 8));
    return k.createdBy?.startsWith("system:") ? "built-in" : "by " + (k.createdBy || "None");
  })();
  paint(
    card(
      k.name || k.id,
      "",
      html`<div>
        <div class="badges">
          ${c.statusBadge(k.status)}${badge("v" + k.version)}${badge(by)}${badge("skill " + c.shortId(k.id, 16))}
        </div>
        ${k.description ? html`<p class="metric-note">${k.description}</p>` : nothing}${card(
          "Scopes (" + group.length + ")",
          "Every scope this skill is installed in. Remove takes it out of that scope only.",
          table(
            ["Scope", "Status", "Version", ""],
            [...group]
              .sort((a, b) =>
                (() => {
                  if (c.scopeKind(a.ownerScopeId) === "org") return -1;
                  return c.scopeKind(b.ownerScopeId) === "org"
                    ? 1
                    : (a.ownerScopeId || "").localeCompare(b.ownerScopeId || "");
                })(),
              )
              .map((g) => [
                c.scopeCell(g.ownerScopeId),
                { node: c.statusBadge(g.status) },
                { text: g.version != null ? "v" + g.version : "None", cls: "num" },
                {
                  node:
                    g.status === "archived"
                      ? badge("archived")
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
              {
                node: (k.grantedCapabilities || []).includes(cap)
                  ? badge("granted", "ok")
                  : badge("not granted", "warn"),
              },
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
  let advanced = false,
    registering = false,
    message = "",
    tone = "",
    menu: string | null = null,
    menuTop = 0,
    menuLeft = 0;
  const statuses = new Map<string, Data>();
  const pending = new Set<string>();
  const closeMenu = () => {
    if (menu) {
      menu = null;
      draw();
    }
  };
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
      message = "A repo URL is required.";
      tone = "err";
      draw();
      return;
    }
    const submitted = JSON.stringify(draft);
    registering = true;
    message = "Registering…";
    tone = "";
    draw();
    const excluded = draft.exclude
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    try {
      const response = await c.api("POST", "/api/skill-packs", {
        url: draft.url.trim(),
        ...(draft.ref.trim() ? { ref: draft.ref.trim() } : {}),
        ...(excluded.length ? { config: { exclude: excluded } } : {}),
        ...(draft.slug.trim() ? { authCredentialSlug: draft.slug.trim() } : {}),
        ...(draft.tier !== "third-party" ? { trustTier: draft.tier } : {}),
      });
      if (!response.ok) {
        message = response.data?.message || "Failed (" + response.status + ").";
        tone = "err";
      } else {
        c.invalidate();
        if (JSON.stringify(draft) === submitted) await c.reload();
        else {
          message = "Pack registered. Your newer changes have not been registered.";
          tone = "ok";
        }
      }
    } catch {
      message = "Registration failed.";
      tone = "err";
    } finally {
      registering = false;
      draw();
    }
  };
  const act = async (s: Data, action: string) => {
    menu = null;
    if (action === "browse") {
      draw();
      void browsePack(s, detail, c);
      return;
    }
    if (pending.has(s.id)) return;
    if (action === "remove" && !confirm("Remove this pack and archive its imported skills?")) {
      draw();
      return;
    }
    pending.add(s.id);
    if (action === "sync") statuses.set(s.id, { text: "syncing…", tone: "saving" });
    draw();
    try {
      const path = "/api/skill-packs/" + encodeURIComponent(s.id);
      const response = await c.api(
        (() => {
          if (action === "remove") return "DELETE";
          return action === "sync" ? "POST" : "PATCH";
        })(),
        path + (action === "sync" ? "/sync" : ""),
        (() => {
          if (action === "sync") return {};
          return action === "track" ? { syncMode: s.syncMode === "tracked" ? "pinned" : "tracked" } : undefined;
        })(),
      );
      if (!response.ok) {
        statuses.set(s.id, {
          text: (action === "sync" ? "sync failed: " : "Failed: ") + (response.data?.message || response.status),
          tone: "err",
        });
        return;
      }
      if (action === "sync") {
        const data = response.data || {},
          n = (data.imported || []).length,
          u = (data.updated || []).length,
          a = (data.archived || []).length;
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
              @click=${() => {
                advanced = !advanced;
                draw();
              }}
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
              const delta = li
                ? "last sync: " +
                  (counts.imported || 0) +
                  " new · " +
                  (counts.updated || 0) +
                  " updated · " +
                  (counts.skipped || 0) +
                  " skipped" +
                  (counts.archived ? " · " + counts.archived + " removed" : "")
                : "";
              const status =
                statuses.get(s.id) ||
                (() => {
                  if (li?.status === "error")
                    return { text: "error: " + (li.error || "sync failed"), tone: "err", title: li.error || "" };
                  return s.updateAvailable
                    ? {
                        text: "update available",
                        tone: "dirty",
                        title: "Upstream advanced past the imported commit. Sync now (or turn on Auto-sync) to apply.",
                      }
                    : { text: li ? "up to date" : "not imported", tone: "muted", title: delta };
                })();
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
  if (!response.ok || !response.data) {
    paint(html`<p class="empty">${response.data?.message || "Couldn't browse (" + response.status + ")."}</p>`);
    return;
  }
  const plan = response.data,
    candidates: Data[] = plan.candidates || [],
    counts = plan.counts || {};
  const selectedScopes = new Set<string>(["org:" + c.orgId]);
  const selected = new Set<string>();
  let filter = "all",
    busy = false,
    message = "",
    tone = "",
    closed = false;
  const all = (row: Data) =>
    selectedScopes.size > 0 && [...selectedScopes].every((scope) => (row.importedScopes || []).includes(scope));
  const eligible = (row: Data) => row.eligible && !all(row);
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
    scope: {
      label: "personal-scoped",
      tone: "muted",
      help: "Held back: declares a personal/owner scope, so it isn't imported as a shared pack skill.",
    },
    private: { label: "private", tone: "muted", help: "Held back: marked owner-only / agent-only." },
    collision: {
      label: "collision",
      tone: "muted",
      help: "Held back: the name matches an existing platform or seed skill.",
    },
    "binary-asset": {
      label: "binary files",
      tone: "muted",
      help: "Held back: contains binary files (import is text-only).",
    },
    malformed: { label: "malformed", tone: "muted", help: "Held back: missing or unreadable SKILL.md frontmatter." },
  };
  const choices = [
    { scopeId: "org:" + c.orgId, label: "org-wide" },
    ...c.scopeRows().map((r: Data) => ({ scopeId: r.scopeId, label: r.label || c.dirLabel(r.scopeId) || r.scopeId })),
  ];
  const picker = c.buildScopeMultiSelect(choices, selectedScopes, recompute);
  const importSelected = async () => {
    if (busy) return;
    if (!selectedScopes.size || !selected.size) {
      message = !selectedScopes.size ? "Pick at least one scope to add skills to." : "Select at least one skill.";
      tone = "err";
      draw();
      return;
    }
    busy = true;
    message = "Importing…";
    tone = "";
    draw();
    const scopes = [...selectedScopes],
      names = [...selected];
    try {
      const result = await c.api("POST", "/api/skill-packs/" + encodeURIComponent(pack.id) + "/import", {
        selected: names.length === candidates.filter(eligible).length ? "all" : names,
        scopeIds: scopes,
      });
      if (!result.ok) {
        message = result.data?.message || "Import failed (" + result.status + ").";
        tone = "err";
      } else {
        const added = result.data.imported?.length ?? 0;
        message =
          "✓ " +
          added +
          " skill" +
          (added === 1 ? "" : "s") +
          " added" +
          (scopes.length > 1 ? " across " + scopes.length + " scopes" : "");
        tone = "ok";
        c.invalidate();
        setTimeout(() => {
          if (root.isConnected && !closed) c.reload();
        }, 1500);
      }
    } catch {
      message = "Import failed.";
      tone = "err";
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
    const shown = candidates.filter(
      (r) =>
        filter === "all" ||
        (() => {
          if (all(r)) return "imported";
          return r.eligible ? "eligible" : r.excludeReason || "excluded";
        })() === filter,
    );
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
                        @click=${() => {
                          filter = key;
                          draw();
                        }}
                        >${
                          (() => {
                            if (key === "all") return candidates.length;
                            return (() => {
                              if (key === "eligible") return importable.length;
                              return key === "imported" ? candidates.filter(all).length : counts[key] || 0;
                            })();
                          })() +
                          " " +
                          reason.label
                        }</span
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
                      const on = (e.target as HTMLInputElement).checked;
                      for (const row of importable) {
                        if (on) selected.add(row.upstreamName);
                        else selected.delete(row.upstreamName);
                      }
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
                      @change=${(e: Event) => {
                        if ((e.target as HTMLInputElement).checked) selected.add(row.upstreamName);
                        else selected.delete(row.upstreamName);
                        draw();
                      }}
                    />`,
                  },
                  { node: stacked(row.upstreamName, row.normalized?.manifest?.description || "") },
                  {
                    node: (() => {
                      if (all(row))
                        return badge(
                          "imported",
                          "info",
                          "Already imported into the selected scope(s): " + (row.importedScopes || []).join(", "),
                        );
                      return row.eligible
                        ? badge(
                            "eligible",
                            "ok",
                            [...selectedScopes].some((s) => (row.importedScopes || []).includes(s))
                              ? "Imported into " +
                                  (row.importedScopes || []).join(", ") +
                                  ". Importing adds it to the other selected scope(s)."
                              : "",
                          )
                        : badge(
                            reasons[row.excludeReason]?.label || row.excludeReason || "excluded",
                            "warn",
                            reasons[row.excludeReason]?.help || "",
                          );
                    })(),
                  },
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
          @mouseenter=${(e: Event) => {
            (e.target as HTMLElement).style.opacity = "1";
          }}
          @mouseleave=${(e: Event) => {
            (e.target as HTMLElement).style.opacity = "0.55";
          }}
          @click=${() => {
            closed = true;
            paint(nothing);
          }}
        >
          ✕
        </button>
      </section>`,
    );
  };
  recompute();
  root.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
