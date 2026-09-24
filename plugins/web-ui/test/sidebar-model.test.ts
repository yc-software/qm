import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultSidebarLayout,
  moveSidebarProject,
  normalizeSidebarLayout,
  orderSidebarProjects,
  projectSection,
  removeSidebarSection,
  reorderSidebarSections,
  removeSidebarTab,
  orderSidebarItems,
} from "../src/sidebar-model.ts";

test("normalization restores built-ins and discards invalid or duplicate assignments", () => {
  const layout = normalizeSidebarLayout({
    version: 1,
    sections: [
      { id: "custom-team", name: "  Product  ", projects: ["p1", "p1", 4], sort: "name" },
      { id: "favorites", name: "forged", projects: ["p1", "p2"] },
      { id: "favorites", projects: ["p3"] },
      { id: "private", projects: ["p4"] },
      { id: "invalid", name: "No" },
    ],
    collapsedProjects: ["p1", "p1", null],
  });
  assert.equal(layout.sections.length, 6);
  assert.equal(layout.sections[0]?.name, "Product");
  assert.equal(layout.sections[1]?.name, "Favorites");
  assert.deepEqual(layout.sections[1]?.projects, ["p1", "p2"]);
  assert.deepEqual(layout.collapsedProjects, ["p1"]);
  assert.equal(projectSection(layout, "p1").id, "custom-team");
  assert.equal(projectSection(layout, "p4").id, "projects");
  assert.deepEqual(normalizeSidebarLayout({ version: 2 }), defaultSidebarLayout());
});

test("moving projects removes the old assignment and reveals the destination", () => {
  const initial = defaultSidebarLayout();
  initial.sections[0]!.hidden = initial.sections[0]!.collapsed = true;
  let layout = moveSidebarProject(initial, "p1", "favorites");
  layout = moveSidebarProject(layout, "p2", "favorites", "p1");
  assert.deepEqual(layout.sections[0]?.projects, ["p2", "p1"]);
  assert.equal(layout.sections[0]?.hidden, false);
  assert.equal(layout.sections[0]?.collapsed, false);
  layout = moveSidebarProject(layout, "p1", "projects");
  assert.deepEqual(layout.sections[0]?.projects, ["p2", "p1"]);
  assert.equal(projectSection(layout, "p1").id, "projects");
  assert.equal(moveSidebarProject(layout, "p1", "private"), layout);
  assert.equal(moveSidebarProject(layout, "p1", "projects", "p1"), layout);
  assert.deepEqual(initial.sections[0]?.projects, []);
});

test("removing a custom section returns its projects without removing built-ins", () => {
  const initial = normalizeSidebarLayout({
    version: 1,
    sections: [{ id: "custom-team", name: "Team", projects: ["p1"] }],
  });
  const reordered = reorderSidebarSections(initial, "private", "custom-team");
  assert.equal(reordered.sections[0]?.id, "private");
  const removed = removeSidebarSection(reordered, "custom-team");
  assert.equal(projectSection(removed, "p1").id, "projects");
  assert.equal(removeSidebarSection(removed, "private").sections.length, removed.sections.length);
});

test("manual order stays stable when activity changes, with alphabetical new projects", () => {
  const section = defaultSidebarLayout().sections[1]!;
  section.projects = ["b", "a"];
  const projects = [
    { scopeId: "a", name: "Alpha", activity: 100 },
    { scopeId: "c", name: "Charlie", activity: 300 },
    { scopeId: "b", name: "Beta", activity: 200 },
  ];
  const ids = (sort: typeof section.sort) =>
    orderSidebarProjects({ ...section, sort }, projects, (project) => project.activity).map(
      (project) => project.scopeId,
    );
  assert.deepEqual(ids("manual"), ["b", "a", "c"]);
  assert.deepEqual(ids("name"), ["a", "b", "c"]);
  assert.deepEqual(ids("recent"), ["c", "b", "a"]);
});

test("tabs preserve sections and shortcuts when removed, including migrated layouts", () => {
  const migrated = normalizeSidebarLayout({
    version: 1,
    sections: [{ id: "custom-product", name: "Product", projects: ["p1"] }],
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.sections[0]?.tabId, "home");
  migrated.tabs.push({ id: "work", name: "Work", icon: "🚀" });
  migrated.activeTab = "work";
  migrated.sections[0]!.tabId = "work";
  migrated.shortcuts[0]!.tabId = "work";
  const restored = normalizeSidebarLayout(migrated);
  assert.deepEqual(restored, migrated);
  const removed = removeSidebarTab(restored, "work");
  assert.equal(removed.activeTab, "home");
  assert.equal(removed.sections[0]?.tabId, "home");
  assert.equal(removed.shortcuts[0]?.tabId, "home");
  assert.equal(removeSidebarTab(removed, "home"), removed);
  assert.equal(projectSection(removed, "p1").id, "custom-product");
});

test("all item ordering and project moves share the same manual rank", () => {
  const layout = defaultSidebarLayout();
  const section = layout.sections.find((item) => item.id === "projects")!;
  section.projects = ["a", "b", "c"];
  section.items = ["c", "a", "b"];
  const rows = [
    { key: "a", name: "Alpha", activity: 3 },
    { key: "b", name: "Beta", activity: 2 },
    { key: "c", name: "Charlie", activity: 1 },
  ];
  assert.deepEqual(
    orderSidebarItems(section, rows).map((item) => item.key),
    ["c", "a", "b"],
  );
  const moved = moveSidebarProject(layout, "b", "projects", "c").sections.find((item) => item.id === "projects")!;
  assert.deepEqual(
    orderSidebarItems(moved, rows).map((item) => item.key),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    orderSidebarProjects(
      moved,
      rows.map((row) => ({ ...row, scopeId: row.key })),
      (row) => row.activity,
    ).map((row) => row.key),
    ["b", "c", "a"],
  );
});

test("normalization bounds customization and keeps Favorites separate from organization", () => {
  const layout = normalizeSidebarLayout({
    version: 2,
    activeTab: "missing",
    tabs: [{ id: "work", name: "Work", icon: "🚀" }],
    sections: [
      { id: "favorites", projects: ["p1"] },
      { id: "custom-product", name: "Product", projects: ["p1"], tabId: "missing", limit: 999 },
      {
        id: "custom-view",
        kind: "chats",
        name: "Waiting",
        limit: 0,
        query: "launch",
        status: "waiting",
        scopeId: "p1",
        tabId: "work",
      },
    ],
    shortcuts: [{ id: "safe", name: "Link", target: "javascript:alert(1)" }],
    itemIcons: { p1: "🚀" },
  });
  assert.equal(layout.activeTab, "work");
  assert.equal(layout.sections[1]?.limit, 10);
  assert.equal(layout.sections[1]?.tabId, "work");
  assert.equal(layout.sections[2]?.limit, 0);
  assert.equal(layout.sections[2]?.status, "waiting");
  assert.equal(layout.itemIcons.p1, "🚀");
  assert.deepEqual(layout.shortcuts, []);
  assert.equal(projectSection(layout, "p1").id, "custom-product");
  assert.deepEqual(normalizeSidebarLayout(layout), layout);
});
