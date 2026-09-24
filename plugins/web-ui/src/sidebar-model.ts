export type SidebarSectionKind = "favorites" | "projects" | "private" | "shared" | "archived" | "custom" | "chats";
export type SidebarSort = "manual" | "name" | "recent";

export interface SidebarSection {
  id: string;
  name: string;
  kind: SidebarSectionKind;
  hidden: boolean;
  collapsed: boolean;
  sort: SidebarSort;
  projects: string[];
  tabId: string;
  icon: string;
  limit: number;
  items: string[];
  scopeId: string;
  query: string;
  status: "all" | "waiting" | "archived";
}

export interface SidebarTab {
  id: string;
  name: string;
  icon: string;
}

export interface SidebarShortcut {
  id: string;
  tabId: string;
  name: string;
  icon: string;
  target: string;
}

export interface SidebarLayout {
  version: 2;
  tabs: SidebarTab[];
  activeTab: string;
  itemIcons: Record<string, string>;
  showTabNames: boolean;
  shortcuts: SidebarShortcut[];
  sections: SidebarSection[];
  collapsedProjects: string[];
}

export function defaultSidebarLayout(): SidebarLayout {
  return {
    version: 2,
    tabs: [{ id: "home", name: "Home", icon: "⌂" }],
    activeTab: "home",
    itemIcons: {},
    showTabNames: true,
    shortcuts: [
      ["home", "Home", "⌂", "view:chats"],
      ["inbox", "Inbox", "▣", "view:inbox"],
      ["calendar", "Calendar", "▦", "view:calendar"],
      ["projects", "Projects", "▱", "view:contexts"],
      ["browse", "Browse", "⊞", "action:browse"],
      ["new-chat", "New chat", "+", "action:new-chat"],
    ].map(([id, name, icon, target]) => ({ id: id!, name: name!, icon: icon!, target: target!, tabId: "home" })),
    sections: (
      [
        ["favorites", "Favorites"],
        ["projects", "Projects"],
        ["private", "Private"],
        ["shared", "Shared"],
        ["archived", "Archived"],
      ] as const
    ).map(([kind, name]) => ({
      id: kind,
      name,
      kind,
      hidden: false,
      collapsed: kind === "archived",
      sort: "manual",
      projects: [],
      tabId: "home",
      icon: "",
      limit: 10,
      items: [],
      scopeId: "",
      query: "",
      status: "all",
    })),
    collapsedProjects: [],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 256),
        ),
      ].slice(0, 500)
    : [];
}

export function acceptsProjects(section: SidebarSection): boolean {
  return section.kind === "favorites" || section.kind === "projects" || section.kind === "custom";
}

export function normalizeSidebarLayout(value: unknown): SidebarLayout {
  const input = record(value);
  const defaults = defaultSidebarLayout();
  if (![1, 2].includes(Number(input.version)) || !Array.isArray(input.sections)) return defaults;
  const tabs: SidebarTab[] = [];
  for (const candidate of Array.isArray(input.tabs) ? input.tabs.slice(0, 12) : []) {
    const item = record(candidate);
    const id = text(item.id, 80);
    const name = text(item.name, 40);
    if (!/^[a-zA-Z0-9-]+$/.test(id) || !name || tabs.some((tab) => tab.id === id)) continue;
    tabs.push({ id, name, icon: text(item.icon, 16) || "▱" });
  }
  if (!tabs.length) tabs.push(...defaults.tabs);
  const tabId = (value: unknown) => tabs.find((tab) => tab.id === value)?.id ?? tabs[0]!.id;
  const shortcuts: SidebarShortcut[] = [];
  for (const candidate of Array.isArray(input.shortcuts) ? input.shortcuts.slice(0, 60) : defaults.shortcuts) {
    const item = record(candidate);
    const id = text(item.id, 80);
    const name = text(item.name, 64);
    const target = text(item.target, 512);
    if (
      !/^[a-zA-Z0-9-]+$/.test(id) ||
      !name ||
      !/^(view|action|project|session):.+$/.test(target) ||
      shortcuts.some((shortcut) => shortcut.id === id)
    )
      continue;
    shortcuts.push({ id, name, target, tabId: tabId(item.tabId), icon: text(item.icon, 16) || "↗" });
  }
  const sections: SidebarSection[] = [];
  const usedProjects = new Set<string>();
  for (const candidate of input.sections.slice(0, 29)) {
    const item = record(candidate);
    const builtIn = defaults.sections.find((section) => section.id === item.id);
    const id = typeof item.id === "string" && /^custom-[a-zA-Z0-9-]{1,64}$/.test(item.id) ? item.id : builtIn?.id;
    if (!id || sections.some((section) => section.id === id)) continue;
    const name = builtIn?.name ?? (typeof item.name === "string" ? item.name.trim().slice(0, 64) : "");
    if (!name) continue;
    const section: SidebarSection = {
      id,
      name,
      kind: builtIn?.kind ?? (item.kind === "chats" ? "chats" : "custom"),
      hidden: item.hidden === true,
      collapsed: item.collapsed === true,
      sort: item.sort === "name" || item.sort === "recent" ? item.sort : "manual",
      projects: [],
      tabId: tabId(item.tabId),
      icon: text(item.icon, 16),
      limit: [5, 10, 15, 20, 50, 0].includes(Number(item.limit)) ? Number(item.limit) : 10,
      items: strings(item.items),
      scopeId: text(item.scopeId, 256),
      query: text(item.query, 128),
      status: item.status === "waiting" || item.status === "archived" ? item.status : "all",
    };
    if (acceptsProjects(section)) {
      section.projects = strings(item.projects).filter((scopeId) => {
        if (section.kind === "favorites") return true;
        if (usedProjects.has(scopeId)) return false;
        usedProjects.add(scopeId);
        return true;
      });
    }
    sections.push(section);
  }
  for (const section of defaults.sections) {
    if (!sections.some((candidate) => candidate.id === section.id)) sections.push({ ...section, tabId: tabs[0]!.id });
  }
  const itemIcons = Object.fromEntries(
    Object.entries(record(input.itemIcons))
      .slice(0, 500)
      .filter(([key, value]) => key.length <= 256 && typeof value === "string")
      .map(([key, value]) => [key, text(value, 16)]),
  );
  return {
    version: 2,
    itemIcons,
    tabs,
    activeTab: tabId(input.activeTab),
    showTabNames: input.showTabNames !== false,
    shortcuts,
    sections,
    collapsedProjects: strings(input.collapsedProjects),
  };
}

export function projectSection(layout: SidebarLayout, scopeId: string): SidebarSection {
  return (
    layout.sections.find((section) => section.kind !== "favorites" && section.projects.includes(scopeId)) ??
    layout.sections.find((section) => section.kind === "projects")!
  );
}

export function moveSidebarProject(
  layout: SidebarLayout,
  scopeId: string,
  sectionId: string,
  before?: string,
): SidebarLayout {
  const target = layout.sections.find((section) => section.id === sectionId);
  if (!target || !acceptsProjects(target) || before === scopeId) return layout;
  return {
    ...layout,
    sections: layout.sections.map((section) => {
      if (target.kind === "favorites" && section.id !== sectionId) return section;
      if (section.kind === "favorites" && target.kind !== "favorites") return section;
      const projects = section.projects.filter((id) => id !== scopeId);
      if (section.id !== sectionId)
        return { ...section, projects, items: section.items.filter((id) => id !== scopeId) };
      const index = before ? projects.indexOf(before) : -1;
      projects.splice(index < 0 ? projects.length : index, 0, scopeId);
      const items = [...new Set([...section.items, ...section.projects])].filter((id) => id !== scopeId);
      const itemIndex = before ? items.indexOf(before) : -1;
      items.splice(itemIndex < 0 ? items.length : itemIndex, 0, scopeId);
      return { ...section, projects, items, hidden: false, collapsed: false, sort: "manual" };
    }),
  };
}

export function reorderSidebarSections(layout: SidebarLayout, from: string, before: string): SidebarLayout {
  if (from === before) return layout;
  const section = layout.sections.find((item) => item.id === from);
  if (!section || !layout.sections.some((item) => item.id === before)) return layout;
  const sections = layout.sections.filter((item) => item.id !== from);
  sections.splice(
    sections.findIndex((item) => item.id === before),
    0,
    section,
  );
  return { ...layout, sections };
}

export function removeSidebarSection(layout: SidebarLayout, id: string): SidebarLayout {
  return {
    ...layout,
    sections: layout.sections.filter(
      (section) => section.id !== id || (section.kind !== "custom" && section.kind !== "chats"),
    ),
  };
}

export function orderSidebarProjects<T extends { scopeId: string; name: string | null }>(
  section: SidebarSection,
  projects: readonly T[],
  activity: (project: T) => number,
): T[] {
  return [...projects].sort((a, b) => {
    if (section.sort === "recent") return activity(b) - activity(a) || (a.name ?? "").localeCompare(b.name ?? "");
    if (section.sort === "manual") {
      const rank = (id: string) => {
        const index = (section.items.length ? section.items : section.projects).indexOf(id);
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
      };
      const delta = rank(a.scopeId) - rank(b.scopeId);
      if (delta) return delta;
    }
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

export function removeSidebarTab(layout: SidebarLayout, id: string): SidebarLayout {
  if (layout.tabs.length < 2 || !layout.tabs.some((tab) => tab.id === id)) return layout;
  const tabs = layout.tabs.filter((tab) => tab.id !== id);
  const destination = tabs[0]!.id;
  return {
    ...layout,
    tabs,
    activeTab: layout.activeTab === id ? destination : layout.activeTab,
    sections: layout.sections.map((section) => (section.tabId === id ? { ...section, tabId: destination } : section)),
    shortcuts: layout.shortcuts.map((shortcut) =>
      shortcut.tabId === id ? { ...shortcut, tabId: destination } : shortcut,
    ),
  };
}

export function reorderSidebarEntries<T extends { id: string }>(entries: T[], id: string, before: string): T[] {
  const entry = entries.find((item) => item.id === id);
  if (!entry || id === before || !entries.some((item) => item.id === before)) return entries;
  const remaining = entries.filter((item) => item.id !== id);
  remaining.splice(
    remaining.findIndex((item) => item.id === before),
    0,
    entry,
  );
  return remaining;
}

export function orderSidebarItems<T extends { key: string; name: string; activity: number }>(
  section: SidebarSection,
  rows: T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (section.sort === "name") return a.name.localeCompare(b.name);
    if (section.sort === "recent") return b.activity - a.activity || a.name.localeCompare(b.name);
    const rank = (key: string) => (section.items.includes(key) ? section.items.indexOf(key) : Number.MAX_SAFE_INTEGER);
    return rank(a.key) - rank(b.key);
  });
}
