import assert from "node:assert/strict";
import test from "node:test";
import { mountAdmin, type Route } from "./fixture.ts";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const withResolvers = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

test("settings views never start the all-scopes directory scan that history needs", async () => {
  for (const view of ["customize", "models", "credentials", "governance", "connectors", "onboarding", "history"]) {
    const admin = await mountAdmin(`/settings/${view}`, { "/scopes": { scopes: [], environments: [] } });
    await admin.settle();
    assert.equal(
      admin.requests.some((r) => r.path === "/scopes"),
      view === "history",
      view,
    );
    admin.close();
  }
});

test("a refreshed model catalog only reaches the view that asked for it", async () => {
  for (const stale of [false, true]) {
    const refresh = withResolvers<unknown>();
    const admin = await mountAdmin("/settings/models", {
      "/scopes/org:acme": ({ url }) =>
        url.searchParams.get("catalog") === "refresh"
          ? refresh.promise
          : {
              modelCatalogRefreshing: url.searchParams.get("view") === "models",
              baseModelOptions: [{ id: "configured", name: "Configured" }],
              modelsByHarness: { pi: [{ id: "configured", name: "Configured" }] },
              webuiModels: [],
            },
    });
    await admin.settle();
    if (stale) {
      admin.controller.show("customize");
      await admin.settle();
    }
    refresh.resolve({
      baseModelOptions: [{ id: "new", name: "New model" }],
      modelsByHarness: { pi: [{ id: "new", name: "New model" }] },
    });
    await admin.settle();
    const offered = [...admin.document.querySelectorAll<HTMLOptionElement>("#webui-models-options option")].map(
      (option) => option.value,
    );
    assert.equal(offered.includes("new"), !stale, stale ? "stale" : "current");
    assert.ok(offered.includes("configured"));
    admin.close();
  }
});

test("saving branding merges the saved theme and reloads only when no other draft is open", async () => {
  for (const otherDraft of [false, true]) {
    const saves: any[] = [];
    const admin = await mountAdmin("/settings/customize", {
      "/scopes/org:acme": {
        branding: { selfLabel: "Saved name", accent: "#111111", iconUrl: "https://example.com/icon.png" },
        soul: "Original SOUL",
      },
      "PUT /scopes/org:acme/branding": ({ body }) => {
        saves.push(body);
        return { ok: true };
      },
    });
    await admin.settle();
    const accent = admin.document.querySelector<HTMLInputElement>(
      '#card-branding input[type="color"], #branding-accent',
    )!;
    accent.value = "#123456";
    accent.dispatchEvent(new admin.window.Event("input", { bubbles: true }));
    accent.dispatchEvent(new admin.window.Event("change", { bubbles: true }));
    if (otherDraft) {
      const soul = admin.document.querySelector<HTMLTextAreaElement>("#card-soul textarea")!;
      soul.value = "Unsaved SOUL";
      soul.dispatchEvent(new admin.window.Event("input", { bubbles: true }));
    }
    admin.document.querySelector<HTMLButtonElement>('[data-save="branding"]')!.click();
    await admin.settle();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].selfLabel, "Saved name");
    assert.equal(saves[0].accent, "#123456");
    assert.equal(saves[0].iconUrl, "https://example.com/icon.png");
    assert.equal(admin.document.querySelector<HTMLButtonElement>('[data-save="branding"]')!.disabled, true);
    assert.equal(
      admin.document.querySelector<HTMLTextAreaElement>("#card-soul textarea")!.value,
      otherDraft ? "Unsaved SOUL" : "Original SOUL",
    );
    assert.equal(
      admin.jsdomErrors.some((message) => /navigation/i.test(message)),
      !otherDraft,
      otherDraft ? "kept the SOUL draft" : "reloaded",
    );
    admin.close();
  }
});

test("credentials show loading, then a visible retry when the read fails", async () => {
  const read = withResolvers<unknown>();
  const admin = await mountAdmin("/settings/credentials", {
    "/scopes/org:acme": () => read.promise,
    "/keychain": {},
  });
  await admin.settle();
  assert.equal(admin.document.getElementById("sc-list")!.textContent!.trim(), "Loading credentials…");
  assert.equal(admin.document.querySelector<HTMLButtonElement>("#sc-add")!.disabled, true);
  read.resolve({ status: 500, body: { message: "boom" } });
  await admin.settle();
  assert.match(admin.document.getElementById("sc-list")!.textContent!, /Could not load credentials\./);
  const reads = admin.requests.filter((r) => r.path === "/scopes/org%3Aacme").length;
  admin.document.querySelector<HTMLButtonElement>("#sc-list button")!.click();
  await admin.settle();
  assert.equal(admin.requests.filter((r) => r.path === "/scopes/org%3Aacme").length, reads + 1);
  admin.close();
});

test("credential usage fills in when it arrives, survives failure, and ignores replies for a view left behind", async () => {
  for (const outcome of ["current", "failed", "view"] as const) {
    const usage = withResolvers<unknown>();
    const admin = await mountAdmin("/settings/credentials", {
      "/scopes/org:acme": {
        serviceCredentials: [{ slug: "example", name: "Example", host: "example.com", grantees: ["org:acme"] }],
      },
      "/scopes/org:acme/credential-usage": () => usage.promise,
      "/keychain": {},
    });
    await admin.settle();
    const list = () => admin.document.getElementById("sc-list")!.textContent!;
    assert.match(list(), /Loading usage…/);
    if (outcome === "view") {
      admin.controller.show("models");
      await admin.settle();
    }
    usage.resolve(
      outcome === "failed" ? { status: 500, body: {} } : { summaries: [{ slug: "example", usageCount: 7 }] },
    );
    await admin.settle();
    assert.match(list(), /Example/, outcome);
    if (outcome === "current") assert.match(list(), /7 successful uses/);
    if (outcome === "failed") assert.match(list(), /Usage unavailable/);
    if (outcome === "view") assert.match(list(), /Loading usage…/);
    admin.close();
  }
});

test("a rejected fetch or an interrupted body becomes a visible failure", async () => {
  const interrupted = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("body interrupted"));
        },
      }),
    );
  for (const files of [
    () => {
      throw new Error("network disconnected");
    },
    interrupted,
  ]) {
    const admin = await mountAdmin("/settings/files", { "/scopes": { scopes: [] }, "/files": files });
    await admin.settle();
    assert.equal(admin.document.querySelector("#view-data .empty")!.textContent, "Network request failed.");
    admin.close();
  }
});

const meta = (id: string) => ({
  id,
  name: id,
  label: id,
  buttonLabel: id,
  provider: "openai",
  api: "openai-responses",
});

test("the models view saves runtime rows chosen in the composer picker", async () => {
  const saves: [string, unknown][] = [];
  const save: Route = ({ path, body }) => {
    saves.push([decodeURIComponent(path), body]);
    return { ok: true };
  };
  const admin = await mountAdmin("/settings/models", {
    "/scopes/org:acme": {
      baseModelDefault: "model",
      baseModelOptions: [{ id: "model" }],
      harnessOptions: ["pi"],
      modelsByHarness: { pi: [{ id: "model" }, { id: "fast" }] },
      modelCatalog: { model: meta("model"), fast: meta("fast") },
      fastModeModelIds: ["fast"],
      runtime: { harnessId: "pi", modelId: "fast", effortLevel: "auto", fastMode: false },
      cronRuntime: null,
      subagentRuntime: null,
      fallbackRuntime: null,
      memoryEmbeddingModel: null,
      memoryEmbeddingOptions: [{ id: "gateway/embed", name: "embed", provider: "qm:gateway" }],
    },
    "PUT /scopes/org:acme/runtime": save,
    "PUT /scopes/org:acme/cron-runtime": save,
    "PUT /scopes/org:acme/memory-embedding-model": save,
  });
  await admin.settle();
  const doc = admin.document;
  const row = (key: string) => doc.querySelector(`[data-runtime-row="${key}"]`)!;
  const open = (key: string) => row(key).querySelector<HTMLButtonElement>(".loadout-button")!.click();
  const recall = row("memory-embedding-model").querySelector("select")!;
  const pickRecall = (modelId: string) => {
    recall.value = modelId;
    recall.dispatchEvent(new admin.window.Event("change"));
  };
  const saveAll = async () => {
    doc.getElementById("runtimes-save")!.click();
    await admin.settle(10);
  };

  assert.equal(row("cron-runtime").querySelector(".menu-label")!.textContent, "Job's scope default");
  open("cron-runtime");
  assert.deepEqual(
    [...row("cron-runtime").querySelectorAll(".loadout-pick .loadout-name")].map((name) => name.textContent),
    ["model", "fast"],
  );
  for (const preset of ['[data-loadout-section="add"]', ".loadout-head", ".loadout-remove"])
    assert.equal(row("cron-runtime").querySelector(preset), null);
  row("cron-runtime").querySelector<HTMLButtonElement>(".loadout-pick")!.click();

  open("runtime");
  row("runtime").querySelector<HTMLButtonElement>('button[aria-label="Fast"]')!.click();
  row("runtime").querySelector<HTMLButtonElement>('[data-loadout-section="effort"]')!.click();
  [...row("runtime").querySelectorAll<HTMLButtonElement>(".loadout-effort")]
    .find((button) => button.textContent!.trim() === "High")!
    .click();
  assert.deepEqual(
    [...recall.options].map((option) => option.value),
    ["", "gateway/embed"],
  );
  pickRecall("gateway/embed");

  await saveAll();
  assert.deepEqual(plain(saves), [
    ["/scopes/org:acme/runtime", { harnessId: "pi", modelId: "fast", effortLevel: "high", fastMode: true }],
    ["/scopes/org:acme/cron-runtime", { harnessId: "pi", modelId: "model", effortLevel: "auto", fastMode: false }],
    ["/scopes/org:acme/memory-embedding-model", { modelId: "gateway/embed" }],
  ]);
  assert.equal(doc.querySelector(".dirty"), null);
  assert.equal(admin.window.localStorage.length, 0);

  open("cron-runtime");
  row("cron-runtime").querySelector<HTMLButtonElement>(".loadout-foot-btn")!.click();
  pickRecall("");
  await saveAll();
  assert.deepEqual(plain(saves.slice(3)), [
    ["/scopes/org:acme/cron-runtime", { inherit: true }],
    ["/scopes/org:acme/memory-embedding-model", { modelId: null }],
  ]);
  assert.equal(row("cron-runtime").querySelector(".menu-label")!.textContent, "Job's scope default");
  admin.close();
});
