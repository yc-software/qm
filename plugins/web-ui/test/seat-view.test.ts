import assert from "node:assert/strict";
import test, { after } from "node:test";
import { browserEnv } from "./browser-env.ts";

const step = {
  id: "st1",
  sessionId: "s1",
  sessionTitle: "Fix the build",
  createdAt: Date.now() - 5000,
  request: {
    model: "claude-test",
    max_tokens: 4096,
    system: [{ type: "text", text: "You are QM, a helpful assistant." }],
    tools: [
      {
        name: "execute",
        description: "Run a shell command.",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    ],
    messages: [{ role: "user", content: "Why is CI red?" }],
  },
};

type Reply = { status: number; body: unknown };
let replies: Record<string, Reply> = {};
const posts: Array<{ path: string; body: unknown }> = [];

const { vite, close } = await browserEnv({
  dom: { url: "http://localhost/seat" },
  fetch: (input, init) => {
    const path = String(input);
    if (init?.method === "POST") posts.push({ path, body: JSON.parse(String(init.body)) });
    const reply = replies[`${init?.method ?? "GET"} ${path}`] ?? { status: 404, body: { error: "not_found" } };
    return Promise.resolve(Response.json(reply.body, { status: reply.status }));
  },
});
after(close);

const { mountSeat } = await vite.ssrLoadModule("/src/seat.ts");

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check());
}

function mount(): HTMLElement {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.append(host);
  mountSeat(host);
  return host;
}

function type(el: HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;

test("with nothing waiting the view says how to start", async () => {
  replies = { "GET /api/seat/steps": { status: 200, body: { steps: [] } } };
  const host = mount();
  await until(() => Boolean(host.querySelector(".seat-empty")?.textContent?.includes("Nothing to play yet.")));
});

test("without the feature the view shows the server's reason", async () => {
  replies = {
    "GET /api/seat/steps": { status: 403, body: { error: "feature_disabled", message: "Agent Seat is off for you." } },
  };
  const host = mount();
  await until(() => host.querySelector(".seat-empty")?.textContent === "Agent Seat is off for you.");
});

test("the oldest step opens with its request text, and a tool call move is sent", async () => {
  posts.length = 0;
  replies = {
    "GET /api/seat/steps": { status: 200, body: { steps: [step] } },
    "GET /api/seat/steps/st1": { status: 200, body: { step } },
    "POST /api/seat/steps/st1/move": { status: 200, body: { ok: true } },
  };
  const host = mount();
  await until(() => Boolean(host.querySelector(".seat-request")));
  const text = host.querySelector(".seat-request")!.textContent!;
  assert.match(text, /You are QM, a helpful assistant\./);
  assert.match(text, /Why is CI red\?/);
  assert.match(text, /Run a shell command\./);
  button(host, "Add tool call").click();
  await until(() => Boolean(host.querySelector(".seat-call select")));
  const select = host.querySelector<HTMLSelectElement>(".seat-call select")!;
  select.value = "execute";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  const args = () => host.querySelectorAll<HTMLTextAreaElement>(".seat-call textarea")[0]!;
  await until(() => args().value.includes('"command": ""'));
  type(args(), "{ not json");
  button(host, "Make move").click();
  await until(() => Boolean(host.querySelector(".seat-error")?.textContent?.includes("not valid JSON")));
  assert.equal(posts.length, 0);
  type(args(), '{"command":"git log -1"}');
  replies["GET /api/seat/steps"] = { status: 200, body: { steps: [] } };
  button(host, "Make move").click();
  await until(() => posts.length === 1);
  assert.deepEqual(posts[0], {
    path: "/api/seat/steps/st1/move",
    body: { content: [{ type: "tool_use", name: "execute", input: { command: "git log -1" } }] },
  });
  await until(() => !host.querySelector(".seat-request"));
});

test("asking the model loads its move as a draft, and a closed step says so", async () => {
  replies = {
    "GET /api/seat/steps": { status: 200, body: { steps: [step] } },
    "GET /api/seat/steps/st1": { status: 200, body: { step } },
    "POST /api/seat/steps/st1/ask": {
      status: 200,
      body: {
        model: "claude-real",
        stopReason: "tool_use",
        content: [
          { type: "text", text: "Checking the log." },
          { type: "tool_use", name: "execute", input: { command: "gh run list" } },
        ],
      },
    },
    "POST /api/seat/steps/st1/move": {
      status: 409,
      body: { error: "step_closed", message: "That step already closed." },
    },
  };
  const host = mount();
  await until(() => Boolean(host.querySelector(".seat-request")));
  button(host, "Ask model").click();
  await until(() => Boolean(host.querySelector(".seat-draft-note")));
  assert.match(host.querySelector(".seat-draft-note")!.textContent!, /claude-real/);
  const areas = host.querySelectorAll<HTMLTextAreaElement>(".seat-move textarea");
  assert.equal(areas[0]!.value, "Checking the log.");
  assert.deepEqual(JSON.parse(areas[1]!.value), { command: "gh run list" });
  button(host, "Make move").click();
  await until(() => host.querySelector(".seat-error")?.textContent === "That step already closed.");
});

test("a step that closed before it opened is skipped for the next one", async () => {
  const next = { ...step, id: "st2", sessionTitle: "Next one" };
  replies = {
    "GET /api/seat/steps": { status: 200, body: { steps: [step, next] } },
    "GET /api/seat/steps/st1": { status: 409, body: { error: "step_closed", message: "That step already closed." } },
    "GET /api/seat/steps/st2": { status: 200, body: { step: next } },
  };
  const host = mount();
  await until(() => host.querySelector(".seat-step.active")?.textContent?.includes("Next one") === true);
  await until(() => Boolean(host.querySelector(".seat-request")));
  assert.equal(host.querySelector(".seat-error"), null);
  assert.deepEqual(
    [...host.querySelectorAll(".seat-step-title")].map((t) => t.textContent),
    ["Next one"],
  );
});

test("an error from a closed step does not follow onto the next step", async () => {
  const next = { ...step, id: "st3", sessionTitle: "Fresh step" };
  replies = {
    "GET /api/seat/steps": { status: 200, body: { steps: [step] } },
    "GET /api/seat/steps/st1": { status: 200, body: { step } },
    "GET /api/seat/steps/st3": { status: 200, body: { step: next } },
    "POST /api/seat/steps/st1/move": {
      status: 409,
      body: { error: "step_closed", message: "That step already closed." },
    },
  };
  const host = mount();
  await until(() => Boolean(host.querySelector(".seat-request")));
  type(host.querySelector<HTMLTextAreaElement>(".seat-move textarea")!, "Late reply");
  button(host, "Make move").click();
  await until(() => host.querySelector(".seat-error")?.textContent === "That step already closed.");
  replies["GET /api/seat/steps"] = { status: 200, body: { steps: [next] } };
  await until(() => host.querySelector(".seat-step.active")?.textContent?.includes("Fresh step") === true);
  await until(() => Boolean(host.querySelector(".seat-request")));
  assert.equal(host.querySelector(".seat-error"), null);
});

test("the raw request is only built once its fold is opened", async () => {
  replies = {
    "GET /api/seat/steps": { status: 200, body: { steps: [step] } },
    "GET /api/seat/steps/st1": { status: 200, body: { step } },
  };
  const host = mount();
  await until(() => Boolean(host.querySelector(".seat-request")));
  const raw = [...host.querySelectorAll<HTMLDetailsElement>("details.seat-fold")].find(
    (d) => d.querySelector("summary")?.textContent?.trim() === "raw request",
  )!;
  assert.equal(raw.querySelector("pre"), null);
  raw.open = true;
  raw.dispatchEvent(new window.Event("toggle"));
  await until(() => Boolean(raw.querySelector("pre")));
  assert.equal(JSON.parse(raw.querySelector("pre")!.textContent!).model, "claude-test");
  assert.equal(raw.open, true);
});
