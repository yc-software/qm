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

const versions = [
  { version: 3, name: "Ada", description: "", instructions: "Count.\nShow work.", editedBy: "bo", editedAt: 3 },
  { version: 2, name: "Ada", description: "", instructions: "Count.", editedBy: "tester", editedAt: 2 },
  { version: 1, name: "Ada", description: "", instructions: "Ada instructions", editedBy: "tester", editedAt: 1 },
];

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
    if (path.startsWith("/api/skills")) return json({ skills: [] });
    if (path === "/api/keychain/overview")
      return json({
        credentials: [
          { id: "cred-gh", service: "github", accountLabel: "octo" },
          { id: "cred-lin", service: "linear" },
        ],
      });
    const versionsPath = /\/versions\?limit=20(?:&before=(\d+))?$/.exec(path);
    if (versionsPath && method === "GET") {
      const before = Number(versionsPath[1] ?? Infinity);
      const page = versions.filter((v) => v.version < before);
      return json({ versions: page.slice(0, 2), more: page.length > 2 });
    }
    if (path.includes("/versions/") && method === "POST")
      return json({ persona: { ...personas[0], instructions: "Ada instructions", version: 4 } });
    if (path.includes("/credentials")) return json({ credential: { grantId: "g-2" } });
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
          access: [
            { scopeId: "personal:tester", role: "owner" },
            { scopeId: "channel:C9", role: "read", label: "design" },
          ],
          version: 3,
          credentials: [{ grantId: "g-1", service: "github", ownerId: "tester" }],
        },
      });
    }
    if (path.startsWith("/api/directory/resolve"))
      return json({ matches: [{ principalId: "bo@acme.com", displayName: "Bo Person", type: "internal" }] });
    if (path.startsWith("/api/directory/channels"))
      return json({ channels: [{ scopeId: "channel:C1", channelId: "C1", name: "eng-launch", isPrivate: false }] });
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
dom.window.confirm = () => true;
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

test("Fork hands off to QM in a new chat instead of copying on the page", async () => {
  const { main } = await mountPage();
  const { storedDraft, newChatDraftKey } = await vite.ssrLoadModule("/src/drafts.ts");
  calls = [];
  button(main, "Fork", "Ada").click();
  await settle();
  assert.equal(storedDraft(newChatDraftKey("tester")), "Fork the Ada persona for me.");
  assert.equal(
    calls.some((c) => c.method === "POST" && c.path === "/api/personas"),
    false,
  );
});

const sections = (root: ParentNode) =>
  Object.fromEntries(
    [...root.querySelectorAll(".persona-section")].map((section) => [
      section.querySelector("h3")?.textContent?.trim(),
      {
        actions: [...section.querySelectorAll(".persona-section-actions button")].map((b) => b.textContent?.trim()),
        items: [...section.querySelectorAll(".persona-item .persona-skill-name, .permission-person-label")].map((n) =>
          n.textContent?.trim(),
        ),
      },
    ]),
  );

async function openPersonaPage(name: string) {
  const mounted = await mountPage();
  mounted.main.querySelector<HTMLButtonElement>(`button[aria-label="Open ${name}"]`)!.click();
  await settle();
  return mounted;
}

test("a reader sees each part of the persona with nothing to add or remove", async () => {
  const { main } = await openPersonaPage("Cy");
  assert.equal(main.querySelector("form.persona-form"), null);
  assert.match(main.textContent ?? "", /Cy instructions/);
  assert.deepEqual(sections(main), {
    Skills: { actions: [], items: [] },
    Crons: { actions: ["New cron"], items: [] },
    Credentials: { actions: [], items: ["github"] },
    "Slack channels": { actions: [], items: ["design"] },
    "Who has access": { actions: [], items: ["You"] },
    History: { actions: ["Show 3 versions"], items: [] },
  });
  assert.equal(main.querySelector(".persona-item-remove"), null);
});

test("Add channel opens the share dialog, and a channel added there gets read access", async () => {
  const { main } = await openPersonaPage("Ada");
  button(main, "Add channel").click();
  const dialog = document.querySelector<HTMLDialogElement>("dialog.persona-share-dialog")!;
  const input = dialog.querySelector<HTMLInputElement>('input[aria-label="Add people or Slack channels"]')!;
  input.value = "eng";
  input.dispatchEvent(new window.Event("input"));
  input.closest("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  [...dialog.querySelectorAll<HTMLButtonElement>(".project-member-result")].at(-1)!.click();
  calls = [];
  button(dialog, "Save").click();
  await settle();
  assert.deepEqual(calls.find((c) => c.method === "PUT")?.body, {
    access: [
      { scopeId: "personal:tester", role: "owner" },
      { scopeId: "channel:C9", role: "read" },
      { scopeId: "channel:C1", role: "read" },
    ],
  });
  assert.equal(dialog.isConnected, false);

  calls = [];
  main.querySelector<HTMLButtonElement>('button[aria-label="Remove design"]')!.click();
  await settle();
  assert.deepEqual(calls.find((c) => c.method === "PUT")?.body, {
    access: [{ scopeId: "personal:tester", role: "owner" }],
  });
});

test("an owner attaches one of their credentials and detaches one", async () => {
  const { main } = await openPersonaPage("Ada");
  button(main, "Attach").click();
  await settle();
  const dialog = document.querySelector<HTMLDialogElement>("dialog.persona-picker-dialog")!;
  const choices = [...dialog.querySelectorAll<HTMLButtonElement>(".project-member-result")];
  assert.deepEqual(
    choices.map((c) => [c.querySelector(".project-member-name")?.textContent?.replace(/\s+/g, " ").trim(), c.disabled]),
    [
      ["github octo", true],
      ["linear", false],
    ],
  );
  calls = [];
  choices[1]!.click();
  await settle();
  assert.deepEqual(
    calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body]),
    [["POST", "/api/personas/p-ada/credentials", { credentialId: "cred-lin" }]],
  );
  calls = [];
  main.querySelector<HTMLButtonElement>('button[aria-label="Detach github"]')!.click();
  await settle();
  assert.deepEqual(
    calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path]),
    [["DELETE", "/api/personas/p-ada/credentials/g-1"]],
  );
});

test("New cron and Ask QM open a chat wearing the persona with the request started", async () => {
  const { main } = await openPersonaPage("Ada");
  const { storedDraft } = await vite.ssrLoadModule("/src/drafts.ts");
  calls = [];
  button(main, "New cron").click();
  await settle();
  assert.deepEqual(
    calls
      .filter((c) => c.method !== "GET")
      .slice(0, 2)
      .map((c) => [c.method, c.path, c.body]),
    [
      ["POST", "/api/sessions", { scopeId: "personal:tester" }],
      ["PUT", "/api/sessions/s-new/persona", { personaId: "p-ada" }],
    ],
  );
  assert.equal(storedDraft("web:tester:new"), "Set up a cron that ");
});

test("history lists versions on demand, shows what changed, and rolls back as a new version", async () => {
  const { main } = await openPersonaPage("Ada");
  assert.equal(
    calls.some((c) => c.path.endsWith("/versions")),
    false,
  );
  button(main, "Show 3 versions").click();
  await settle();
  button(main, "Show older").click();
  await settle();
  const rows = [...main.querySelectorAll(".persona-version-row")];
  assert.deepEqual(
    rows.map((row) => [
      row.querySelector("strong")?.textContent,
      row.querySelector(".persona-version-open")?.textContent?.includes("created"),
      [...row.querySelectorAll("button.persona-action")].map((b) => b.textContent?.trim()),
    ]),
    [
      ["v3", false, []],
      ["v2", false, ["Roll back"]],
      ["v1", true, ["Roll back"]],
    ],
  );
  assert.equal(
    [...main.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Show older"),
    false,
  );
  assert.deepEqual(
    calls.filter((c) => c.path.includes("/versions")).map((c) => c.path),
    ["/api/personas/p-ada/versions?limit=20", "/api/personas/p-ada/versions?limit=20&before=2"],
  );
  rows[0]!.querySelector<HTMLButtonElement>(".persona-version-open")!.click();
  await settle();
  assert.deepEqual(
    [...main.querySelectorAll(".persona-version-field b")].map((label) => label.textContent),
    ["Name", "Icon", "Description", "Instructions"],
  );
  assert.equal(main.querySelector(".persona-version-text")?.textContent, "Count.\nShow work.");
  calls = [];
  button(rows[2]!, "Roll back").click();
  await settle();
  assert.deepEqual(
    calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path]),
    [["POST", "/api/personas/p-ada/versions/1/restore"]],
  );
  assert.match(main.querySelector(".action-notice")?.textContent ?? "", /Rolled back to version 1/);
});

test("a Slack channel can only be given chat access in the share dialog", async () => {
  const { main } = await mountPage();
  button(main, "Share", "Ada").click();
  await settle();
  const dialog = document.querySelector<HTMLDialogElement>("dialog.persona-share-dialog")!;
  const channelRow = dialog.querySelector<HTMLElement>('.permission-row[data-scope="channel:C9"]')!;
  channelRow.querySelector<HTMLButtonElement>("button")!.click();
  await settle();
  assert.deepEqual(
    [...channelRow.querySelectorAll('[role="menuitemradio"]')].map((o) => o.textContent?.trim()),
    ["Can chat", "Remove access"],
  );
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
  button(dialog, "Add everyone at acme").click();
  assert.deepEqual(
    [...dialog.querySelectorAll(".permission-row .permission-person-label")].map((l) => l.textContent?.trim()),
    ["You", "design", "Everyone at Acme"],
  );
  calls = [];
  button(dialog, "Save").click();
  await settle();
  assert.deepEqual(calls.find((c) => c.method === "PUT")?.body, {
    access: [
      { scopeId: "personal:tester", role: "owner" },
      { scopeId: "channel:C9", role: "read" },
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

test("one search finds people and Slack channels, and either can be added", async () => {
  const { main } = await mountPage();
  button(main, "Share", "Ada").click();
  await settle();
  const dialog = document.querySelector<HTMLDialogElement>("dialog.persona-share-dialog")!;
  const input = dialog.querySelector<HTMLInputElement>('input[aria-label="Add people or Slack channels"]')!;
  input.value = "b";
  input.dispatchEvent(new window.Event("input"));
  input.closest("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.deepEqual(
    [...dialog.querySelectorAll(".project-member-result .project-member-name")].map((n) => n.textContent?.trim()),
    ["Bo Person", "eng-launch"],
  );
  [...dialog.querySelectorAll<HTMLButtonElement>(".project-member-result")].at(-1)!.click();
  assert.deepEqual(
    [...dialog.querySelectorAll(".permission-row .permission-person-label")].map((l) => l.textContent?.trim()),
    ["You", "design", "#eng-launch"],
  );
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

test("a persona has its own link, so /personas/<id> opens it and its page keeps the address", async () => {
  const main = document.querySelector("main")!;
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  const personasModule = await vite.ssrLoadModule("/src/personas.ts");
  appState.currentView = "personas";
  appState.mainEl = main;
  appState.me = { user: "tester", org: "acme", companyName: "Acme" };
  personasModule.openPersonaById("p-bo");
  await personasModule.renderPersonasPage();
  await settle();
  assert.equal(main.querySelector(".persona-heading")?.textContent?.trim(), "Bo");
  assert.equal(window.location.pathname, "/personas/p-bo");
  button(main, "Personas").click();
  await settle();
  assert.equal(window.location.pathname, "/personas");
});

test("New skill opens the skill editor already set to the persona", async () => {
  const { main } = await openPersonaPage("Ada");
  button(main, "New skill").click();
  await settle();
  await settle();
  const select = document.querySelector<HTMLSelectElement>(".skill-scope-select select")!;
  assert.ok(select, "the skill editor opened");
  assert.equal(select.selectedOptions[0]?.textContent, "Ada");
  assert.equal(select.value, "persona:p-ada");
});
