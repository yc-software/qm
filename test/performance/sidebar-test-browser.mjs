export function renderClient(data, transport, contexts, surface, limit = 50, retainedIds = []) {
  const root = globalThis.document.querySelector("#sidebar-body");
  const escape = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const bounded = transport === "navigation-post";
  const activity = (row) => row.lastActivityAt ?? row.createdAt;
  const compareId = (a, b) => (a.id < b.id ? -1 : Number(a.id !== b.id));
  const ordered = (rows) => [...rows].sort((a, b) => activity(b) - activity(a) || (bounded ? compareId(a, b) : 0));
  const web = (row) =>
    row.threadRef.startsWith("web:") || (row.threadRef.startsWith("agent:main:subagent:") && row.surface === "web");
  const roots = bounded
    ? []
    : ordered(data.sessions.filter((r) => !r.parentSessionId && (surface !== "web" || web(r))));
  const allRecent = bounded ? data.recent.items : roots.filter((r) => !r.pinned && !r.archived);
  const pinned = bounded ? data.pinned.items : roots.filter((r) => r.pinned && !r.archived);
  const recent = bounded ? allRecent : allRecent.filter((r, i) => i < limit || retainedIds.includes(r.id));
  if (bounded)
    for (const reference of data.references ?? [])
      if (
        reference.session &&
        !reference.session.parentSessionId &&
        !reference.session.pinned &&
        !reference.session.archived &&
        retainedIds.includes(reference.session.id) &&
        !recent.some((r) => r.id === reference.session.id)
      )
        recent.push(reference.session);
  const groups = bounded
    ? data.groups.items
    : contexts
        .flatMap((c) => {
          const rows = allRecent.filter((r) => r.scopeId === c.scopeId);
          if (!rows.length && ["channel", "group"].includes(c.kind)) return [];
          if (rows.length && !recent.some((r) => r.scopeId === c.scopeId)) return [];
          let name = c.kind === "personal" ? "Personal" : c.name;
          if (c.project) name = c.project.name.trim();
          return [
            {
              scopeId: c.scopeId,
              name,
              kind: c.project ? "project" : c.kind,
              count: rows.length,
              lastActivityAt: rows.length ? Math.max(...rows.map(activity)) : c.lastActivityAt,
            },
          ];
        })
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const byScope = new Map(groups.map((g) => [g.scopeId, g]));
  const top = [];
  if (bounded)
    top.push(
      ...groups.map((group) => ({ group, at: group.lastActivityAt })),
      ...recent.filter((r) => !byScope.has(r.scopeId)).map((row) => ({ row, at: activity(row) })),
    );
  else {
    const seen = new Set();
    for (const row of allRecent) {
      const group = byScope.get(row.scopeId);
      if (group && !seen.has(group.scopeId)) {
        top.push({ group, at: group.lastActivityAt });
        seen.add(group.scopeId);
      } else if (!group && recent.some((r) => r.id === row.id)) top.push({ row, at: activity(row) });
    }
    for (const group of groups) if (!seen.has(group.scopeId)) top.push({ group, at: group.lastActivityAt });
  }
  top.sort((a, b) => b.at - a.at);
  const row = (r) =>
    `<div class="session-row" data-session-id="${escape(r.id)}"><a class="session"><span class="tl">${escape(r.title)}</span></a></div>`;
  const more = (section, label) => `<button ${bounded ? `data-session-page="${section}"` : ""}>${label}</button>`;
  const group = (g) =>
    `<section class="recent-project" data-scope-id="${escape(g.scopeId)}"><button class="recent-project-toggle" aria-expanded="true"><span class="recent-project-name">${escape(g.name.replace(/^#/, ""))}</span></button><div class="recent-project-menu"><span class="recent-project-count">${g.count}</span><button data-menu-id="project:${escape(g.scopeId)}">Options</button></div><div class="recent-project-children">${bounded && g.count > recent.filter((r) => r.scopeId === g.scopeId).length ? `<button data-session-page="group" data-scope-id="${escape(g.scopeId)}">Show more in ${escape(g.name)}</button>` : ""}${ordered(
      recent.filter((r) => r.scopeId === g.scopeId),
    )
      .map(row)
      .join("")}</div></section>`;
  const archivedCount = bounded ? data.archivedCount : roots.filter((r) => r.archived).length;
  const recentMore = bounded
    ? Boolean(data.recent.nextCursor)
    : allRecent.some((r, i) => i >= limit && !retainedIds.includes(r.id));
  root.innerHTML = `<div class="pinned-children">${pinned.map(row).join("")}</div>${bounded && data.pinned.nextCursor ? more("pinned", "Show more pinned conversations") : ""}${top.map((i) => (i.group ? group(i.group) : row(i.row))).join("")}${bounded && data.groups.nextCursor ? more("groups", "Show more conversation groups") : ""}${recentMore ? more("recent", "Show more conversations") : ""}${archivedCount ? `<button class="archived-toggle">Archived <span class="archived-count">${archivedCount}</span></button>` : ""}`;
  root.dataset.sessionNavigation = "ready";
  root.dataset.sessionNavigationMode = bounded ? "bounded" : "legacy";
  root.dataset.sessionNavigationPending = "";
  root.setAttribute("aria-busy", "false");
  for (const name of ["recent", "pinned", "groups"]) {
    const suffix = name[0].toUpperCase() + name.slice(1);
    root.dataset[`session${suffix}Loaded`] = String(bounded ? data[name].items.length : 0);
    root.dataset[`session${suffix}Total`] = String(bounded ? data[name].total : 0);
  }
}
