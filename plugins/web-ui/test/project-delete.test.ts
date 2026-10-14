import assert from "node:assert/strict";
import test from "node:test";
import type { CoreContext } from "../src/core-bridge.ts";
import { harness, type Harness } from "./deep-link-boot-fixture.ts";

const PROJECT_SCOPE = "group:web-project-p1";

function contexts(ownerId = "tester"): CoreContext[] {
  return [
    { scopeId: "personal:tester", kind: "personal", name: "Personal", sessionCount: 0, lastActivityAt: null },
    {
      scopeId: PROJECT_SCOPE,
      kind: "group",
      name: "Launch",
      sessionCount: 0,
      lastActivityAt: null,
      project: {
        id: "p1",
        name: "Launch",
        ownerId,
        memberIds: ["tester"],
        scopeId: PROJECT_SCOPE,
        members: [{ principalId: "tester", displayName: "Tester" }],
      },
    },
  ];
}

interface ProjectsPage {
  h: Harness;
  deletes: string[];
  main: Element;
  sidebar: Element;
  settle: () => Promise<void>;
  holdContexts: () => void;
  releaseContexts: () => void;
  failDeletes: (message: string) => void;
}

async function projectsPage(confirmed: boolean, ownerId?: string): Promise<ProjectsPage> {
  const h = await harness({ path: "/projects", contexts: contexts(ownerId) });
  await h.boot();
  h.releaseSessions();
  await h.sessionsReady();
  const deletes: string[] = [];
  const inner = globalThis.fetch;
  let held: Promise<void> | null = null;
  let release = (): void => {};
  let failure: string | null = null;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    if (init?.method === "DELETE") {
      deletes.push(path);
      return failure === null ? Response.json({}) : Response.json({ message: failure }, { status: 500 });
    }
    if (path === "/api/contexts" && held) await held;
    return inner(input, init);
  };
  window.confirm = () => confirmed;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settle();
  return {
    h,
    deletes,
    settle,
    holdContexts: () => {
      held = new Promise<void>((resolve) => (release = resolve));
    },
    releaseContexts: () => {
      held = null;
      release();
    },
    failDeletes: (message: string) => (failure = message),
    main: document.querySelector(".main")!,
    sidebar: document.querySelector("#sidebar-body")!,
  };
}

const rowTitles = (main: Element): string[] =>
  [...main.querySelectorAll(".context-row-title")].map((el) => el.textContent?.trim() ?? "");

test("a confirmed delete clears the project from the Projects list", async () => {
  const page = await projectsPage(true);
  try {
    const remove = page.main.querySelector<HTMLButtonElement>('[aria-label="Delete Launch"]');
    assert.ok(remove, "the Projects page offers no delete control on an owned project row");
    assert.deepEqual(rowTitles(page.main), ["Personal", "Launch"]);

    remove.click();
    await page.settle();

    assert.deepEqual(page.deletes, ["/api/projects/p1"]);
    assert.deepEqual(rowTitles(page.main), ["Personal"]);
  } finally {
    await page.h.close();
  }
});

test("a confirmed delete clears the project from the sidebar", async () => {
  const page = await projectsPage(true);
  try {
    assert.ok(page.sidebar.querySelector('[aria-label="Launch project"]'), "the sidebar never showed the project");

    page.main.querySelector<HTMLButtonElement>('[aria-label="Delete Launch"]')!.click();
    await page.settle();

    assert.deepEqual(page.deletes, ["/api/projects/p1"]);
    assert.equal(page.sidebar.querySelector('[aria-label="Launch project"]'), null);
  } finally {
    await page.h.close();
  }
});

test("declining the delete confirmation leaves the project in place instead of deleting it", async () => {
  const page = await projectsPage(false);
  try {
    page.main.querySelector<HTMLButtonElement>('[aria-label="Delete Launch"]')!.click();
    await page.settle();

    assert.deepEqual(page.deletes, []);
    assert.deepEqual(rowTitles(page.main), ["Personal", "Launch"]);
    assert.ok(page.sidebar.querySelector('[aria-label="Launch project"]'));
  } finally {
    await page.h.close();
  }
});

test("a project owned by someone else offers no delete control that could only fail", async () => {
  const page = await projectsPage(true, "someone-else");
  try {
    assert.deepEqual(rowTitles(page.main), ["Personal", "Launch"]);
    assert.equal(page.main.querySelector('[aria-label="Delete Launch"]'), null);
  } finally {
    await page.h.close();
  }
});

test("a failed delete keeps the project and reports the failure instead of clearing it anyway", async () => {
  const page = await projectsPage(true);
  try {
    page.failDeletes("the project is busy");

    page.main.querySelector<HTMLButtonElement>('[aria-label="Delete Launch"]')!.click();
    await page.settle();

    assert.deepEqual(page.deletes, ["/api/projects/p1"]);
    assert.deepEqual(rowTitles(page.main), ["Personal", "Launch"]);
    assert.equal(page.main.querySelector(".status")?.textContent?.trim(), "the project is busy");
  } finally {
    await page.h.close();
  }
});

test("a contexts response already in flight cannot bring the deleted project back", async () => {
  const page = await projectsPage(true);
  try {
    page.holdContexts();
    (page.h.switchView as (view: string) => void)("contexts");
    await page.settle();

    page.main.querySelector<HTMLButtonElement>('[aria-label="Delete Launch"]')!.click();
    await page.settle();
    assert.deepEqual(rowTitles(page.main), ["Personal"]);

    page.releaseContexts();
    await page.settle();

    assert.deepEqual(rowTitles(page.main), ["Personal"]);
    assert.equal(page.sidebar.querySelector('[aria-label="Launch project"]'), null);
  } finally {
    page.releaseContexts();
    await page.h.close();
  }
});

test("a second click while the delete is in flight cannot send a second delete request", async () => {
  const page = await projectsPage(true);
  try {
    const remove = (): HTMLButtonElement | null =>
      page.main.querySelector<HTMLButtonElement>('[aria-label="Delete Launch"]');

    remove()!.click();
    remove()?.click();
    await page.settle();

    assert.deepEqual(page.deletes, ["/api/projects/p1"]);
  } finally {
    await page.h.close();
  }
});
