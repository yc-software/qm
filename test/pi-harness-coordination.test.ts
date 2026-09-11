import assert from "node:assert/strict";
import { test, mock } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
import type { HarnessTurnInput } from "../src/harness/harness.ts";

let resources: ConstructorParameters<typeof pi.DefaultResourceLoader>[0] | undefined;
let sessionOptions: Record<string, unknown> | undefined;
const stopped = new Error("session construction inspected");

mock.module("@earendil-works/pi-coding-agent", {
  namedExports: {
    ...pi,
    DefaultResourceLoader: class extends pi.DefaultResourceLoader {
      constructor(options: ConstructorParameters<typeof pi.DefaultResourceLoader>[0]) {
        super(options);
        resources = options;
      }
    },
    async createAgentSession(options: Record<string, unknown>) {
      sessionOptions = options;
      throw stopped;
    },
  },
});

const { createPiHarness } = await import("../src/harness/pi-harness.ts");

test("Pi exposes only QM tools and disables automatic extension loading for agent turns", async () => {
  const harness = createPiHarness({ resolveProviderKeys: async () => ({}) });
  const turn: HarnessTurnInput = {
    session: { id: "coordination-policy" } as HarnessTurnInput["session"],
    input: "Work",
    systemPrompt: "Use QM coordination for delegation.",
    history: [],
    tools: {} as HarnessTurnInput["tools"],
    scopeLabel: "personal:owner",
    orgScopeId: "org:test",
    emit: async (entry) => ({ ...entry, seq: 1 }) as Awaited<ReturnType<HarnessTurnInput["emit"]>>,
    recordModelCall() {},
  };
  await assert.rejects(harness.turns.runTurn(turn), (error) => error === stopped);
  assert.ok(resources);
  assert.equal(resources.noExtensions, true);
  assert.equal(resources.noSkills, true);
  assert.equal(resources.noContextFiles, true);
  assert.equal(resources.noPromptTemplates, true);
  assert.ok(sessionOptions);
  assert.equal(sessionOptions.noTools, "builtin");
  const names = (sessionOptions.customTools as Array<{ name: string }>).map((tool) => tool.name);
  assert.ok(names.includes("execute"));
  for (const name of ["Agent", "Task", "task", "spawn_agent", "spawnAgent", "subagent", "bash"])
    assert.equal(names.includes(name), false, `Unexpected native tool: ${name}`);
});
