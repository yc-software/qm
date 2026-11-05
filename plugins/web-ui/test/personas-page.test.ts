import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { browserEnv } from "./browser-env.ts";

const persona = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: `${name} description`,
  instructions: `${name} instructions`,
  createdBy: "u-1",
  createdAt: 1,
  updatedAt: 1,
  role,
  ...extra,
});

const personas = [
  persona("p-ada", "Ada", "owner", { icon: { kind: "emoji", value: "🧮" } }),
  persona("p-bo", "Bo", "write"),
  persona("p-cy", "Cy", "read"),
];

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];
let disabled = false;
let accessError = false;

const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));

const { vite, dom, close } = await browserEnv({
  dom: { url: "http://localhost/personas" },
  fetch: (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (path === "/api/personas" && method === "GET")
      return disabled
        ? json({ error: "personas_disabled", message: "personas are not enabled for you" }, 404)
        : json({ personas });
    if (path === "/api/personas" && method === "POST")
      return json({ persona: { ...persona("p-fork", String(calls.at(-1)!.body!.name), "owner") } }, 201);
    if (path.startsWith("/api/personas/") && path.endsWith("/access"))
      return accessError
        ? json({ error: "invalid", message: "a persona must keep at least one owner" }, 400)
        : json({ access: [] });
    if (path.startsWith("/api/personas/")) {
      const id = decodeURIComponent(path.split("/")[3]!);
      const found = personas.find((p) => p.id === id) ?? persona(id, "Ada (fork)", "owner");
      return json({
        persona: {
          ...found,
          access: [{ scopeId: "personal:tester", role: "owner" }],
          credentials: [{ grantId: "g-1", service: "github", ownerId: "tester" }],
        },
      });
    }
    if (path === "/api/contexts")
      return json({ contexts: [{ scopeId: "personal:tester", kind: "personal", name: null, sessionCount: 0 }] });
    if (path === "/api/sessions" && method === "POST")
      return json(
        { session: { id: "s-new", type: "dm", scopeId: "personal:tester", threadRef: "web:tester:new", createdAt: 1 } },
        201,
      );
    if (path.includes("/persona")) return json({ persona: null });
    if (path.startsWith("/api/sessions/s-new"))
      return json({
        session: { id: "s-new", type: "dm", scopeId: "personal:tester", threadRef: "web:tester:new", createdAt: 1 },
        items: [],
      });
    if (path.startsWith("/api/runtime-config"))
      return json({
        scopeId: new URL(path, "http://localhost").searchParams.get("scopeId") ?? "personal:tester",
        models: [],
        modelCatalog: {},
        orgDefault: { modelId: null, revision: 0 },
        effective: {},
        scopeOverride: null,
      });
    return json({});
  },
});
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
after(close);

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function mountPage() {
  const main = document.querySelector("main")!;
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  const personasModule = await vite.ssrLoadModule("/src/personas.ts");
  appState.currentView = "personas";
  appState.mainEl = main;
  appState.me = { user: "tester", org: "acme", companyName: "Acme" };
  await personasModule.renderPersonasPage();
  return { main, personasModule };
}

function button(root: ParentNode, text: string, within?: string): HTMLButtonElement {
  const scope = within
    ? [...root.querySelectorAll<HTMLElement>(".persona-row")].find((row) => row.textContent?.includes(within))!
    : root;
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `no "${text}" button${within ? ` on ${within}` : ""}`);
  return found;
}

beforeEach(() => {
  calls = [];
  disabled = false;
  accessError = false;
  document.body.innerHTML = '<div id="app"></div><main></main>';
});

test("personas are grouped by the person's role, with edit and share only where the role allows", async () => {
  const { main } = await mountPage();
  const groups = [...main.querySelectorAll(".list-group")].map((group) => ({
    label: group.querySelector("h2")?.textContent?.trim(),
    rows: [...group.querySelectorAll(".persona-row")].map((row) => ({
      name: row.querySelector(".list-row-title")?.textContent?.trim(),
      description: row.querySelector(".persona-row-description")?.textContent?.trim(),
      actions: [...row.querySelectorAll(".persona-row-actions button")].map((b) => b.textContent?.trim()),
    })),
  }));
  assert.deepEqual(groups, [
    {
      label: "Owner",
      rows: [{ name: "Ada", description: "Ada description", actions: ["Chat", "Fork", "Edit", "Share"] }],
    },
    { label: "Can edit", rows: [{ name: "Bo", description: "Bo description", actions: ["Chat", "Fork", "Edit"] }] },
    { label: "Can chat", rows: [{ name: "Cy", description: "Cy description", actions: ["Chat", "Fork"] }] },
  ]);
});

test("when personas are off for the person, Browse has no Personas entry and the page offers nothing", async () => {
  disabled = true;
  const { main } = await mountPage();
  const { destinations } = await vite.ssrLoadModule("/src/browse.ts");
  assert.equal(
    destinations().some((d: { label: string }) => d.label === "Personas"),
    false,
  );
  assert.equal(main.querySelector(".list-page-action"), null);
  assert.equal(main.querySelectorAll(".persona-row").length, 0);
  assert.match(main.textContent ?? "", /Personas aren't turned on for you/);

  disabled = false;
  await mountPage();
  assert.equal(
    destinations().some((d: { label: string }) => d.label === "Personas"),
    true,
  );
});

test("Chat starts a conversation and sets its persona before anything is sent", async () => {
  const { main } = await mountPage();
  calls = [];
  button(main, "Chat", "Cy").click();
  await settle();
  const writes = calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body]);
  assert.deepEqual(writes.slice(0, 2), [
    ["POST", "/api/sessions", { scopeId: "personal:tester" }],
    ["PUT", "/api/sessions/s-new/persona", { personaId: "p-cy" }],
  ]);
  assert.equal(
    calls.some((c) => c.path === "/api/turn"),
    false,
  );
  const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
  assert.equal(sessionsState.list.find((s: { id: string }) => s.id === "s-new")?.personaId, "p-cy");
});

test("Fork creates an owned copy named after the source and opens it", async () => {
  const { main } = await mountPage();
  calls = [];
  button(main, "Fork", "Ada").click();
  await settle();
  const create = calls.find((c) => c.method === "POST" && c.path === "/api/personas");
  assert.deepEqual(create?.body, {
    name: "Ada (fork)",
    description: "Ada description",
    instructions: "Ada instructions",
    icon: { kind: "emoji", value: "🧮" },
    forkedFromId: "p-ada",
  });
  assert.equal(main.querySelector(".persona-heading")?.textContent?.trim(), "Ada (fork)");
  assert.match(main.textContent ?? "", /Credentials aren't copied/);
});

test("a reader sees a read-only summary with credential names and who has access", async () => {
  const { main } = await mountPage();
  main.querySelector<HTMLButtonElement>('button[aria-label="Open Cy"]')!.click();
  await settle();
  assert.equal(main.querySelector("form.persona-form"), null);
  assert.match(main.textContent ?? "", /Cy instructions/);
  assert.deepEqual(
    [...main.querySelectorAll(".persona-credentials .badge")].map((b) => b.textContent),
    ["github"],
  );
  assert.match(main.querySelector(".persona-access-list")?.textContent ?? "", /You\s+Owner/);
});

test("an editor saves name, description and instructions with PATCH", async () => {
  const { main } = await mountPage();
  button(main, "Edit", "Bo").click();
  await settle();
  const form = main.querySelector<HTMLFormElement>("form.persona-form")!;
  form.querySelector<HTMLInputElement>('input[name="name"]')!.value = "Bo 2";
  form.querySelector<HTMLTextAreaElement>('textarea[name="instructions"]')!.value = "Be brief.";
  calls = [];
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  const patch = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch && [patch.path, patch.body], [
    "/api/personas/p-bo",
    { name: "Bo 2", description: "Bo description", instructions: "Be brief." },
  ]);
});

test("sharing stages grants and shows the server's reason when the last owner is removed", async () => {
  const { main } = await mountPage();
  button(main, "Share", "Ada").click();
  await settle();
  const dialog = document.querySelector<HTMLDialogElement>("dialog.persona-share-dialog")!;
  assert.ok(dialog.open);
  button(dialog, "Everyone").click();
  button(dialog, "Add everyone at acme").click();
  assert.deepEqual(
    [...dialog.querySelectorAll(".permission-row .permission-person-label")].map((l) => l.textContent?.trim()),
    ["You", "Everyone at Acme"],
  );
  calls = [];
  button(dialog, "Save").click();
  await settle();
  assert.deepEqual(calls.find((c) => c.method === "PUT")?.body, {
    access: [
      { scopeId: "personal:tester", role: "owner" },
      { scopeId: "org:acme", role: "read" },
    ],
  });
  assert.equal(dialog.isConnected, false);

  accessError = true;
  button(main, "Share", "Ada").click();
  await settle();
  const again = document.querySelector<HTMLDialogElement>("dialog.persona-share-dialog")!;
  button(again, "Save").click();
  await settle();
  assert.equal(again.querySelector('[role="alert"]')?.textContent?.trim(), "a persona must keep at least one owner");
  assert.ok(again.isConnected);
});

test("the conversation shows its persona, and clearing it unsets the session's persona", async () => {
  const { personasModule } = await mountPage();
  const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
  const { render } = await vite.ssrLoadModule("lit");
  sessionsState.list = [
    { id: "s-1", type: "dm", scopeId: "personal:tester", threadRef: "web:tester:1", createdAt: 1, personaId: "p-ada" },
  ];
  const host = document.createElement("div");
  let redraws = 0;
  const draw = () =>
    render(
      personasModule.sessionPersonaChip(sessionsState.list[0], () => (redraws++, draw())),
      host,
    );
  draw();
  assert.equal(host.textContent?.trim(), "🧮Ada");
  calls = [];
  host.querySelector<HTMLButtonElement>('button[aria-label="Stop using Ada"]')!.click();
  await settle();
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.body]),
    [["PUT", "/api/sessions/s-1/persona", { personaId: null }]],
  );
  assert.equal(sessionsState.list[0].personaId, undefined);
  assert.equal(redraws, 1);
  assert.equal(host.querySelector(".session-persona-badge"), null);
});
