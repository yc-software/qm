import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import { snapshot, changedMessages, parseSession, turnEntries, contentParts } from "../ui/agent-seat-model.ts";

const bundle = buildSync({
  entryPoints: [new URL("../ui/agent-seat.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "seat",
}).outputFiles[0]!.text;

test("captures preserve provider instructions, message order, tool schemas and missing history", () => {
  const anthropic = snapshot({
    promptEnvelope: {
      system: "exact\n  whitespace",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "tool_use", id: "a" }] },
      ],
      tools: [{ name: "read", input_schema: { type: "object" } }],
    },
  });
  assert.equal(anthropic.blocks[0]?.value, "exact\n  whitespace");
  assert.deepEqual(
    anthropic.conversation.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(anthropic.tools[0]?.name, "read");
  const responses = snapshot({
    promptEnvelope: {
      input: [{ role: "developer", content: "instructions" }],
      tools: [{ type: "function", name: "execute", parameters: {} }],
    },
  });
  assert.equal(responses.blocks[0]?.value, "instructions");
  assert.equal(responses.conversation.length, 0);
  assert.equal(responses.tools[0]?.name, "execute");
  const gemini = snapshot({
    request: JSON.stringify({
      systemInstruction: { parts: [{ text: "system" }] },
      contents: [{ role: "user", parts: [{ text: "message" }] }],
      tools: [{ functionDeclarations: [{ name: "search" }] }],
    }),
  });
  assert.equal(gemini.tools[0]?.name, "search");
  assert.equal(gemini.conversation[0]?.role, "user");
  assert.equal(snapshot({ truncated: true, promptEnvelope: { preview: "partial" } }).truncated, true);
  assert.equal(snapshot({}).blocks.length, 0);
});

test("native Codex and Claude captures retain configuration and distinguish tool names from definitions", () => {
  const codex = snapshot({
    promptEnvelope: {
      threadStart: {
        baseInstructions: "base",
        developerInstructions: "developer",
        dynamicTools: [{ name: "execute", description: "Run a command", inputSchema: { type: "object" } }],
      },
    },
  });
  assert.deepEqual(
    codex.blocks.map((b) => b.value),
    ["base", "developer"],
  );
  assert.equal(codex.tools[0]?.name, "execute");
  assert.equal(codex.tools[0]?.nameOnly, false);
  assert.equal(codex.kind, "Harness configuration");
  const claude = snapshot({
    promptEnvelope: { system: "prompt", tools: ["Agent"], allowedTools: ["Agent", "mcp__core__read"] },
  });
  assert.deepEqual(
    claude.tools.map((t) => t.name),
    ["Agent", "mcp__core__read"],
  );
  assert.equal(claude.tools[0]?.raw, "Agent");
  assert.equal(claude.tools[0]?.nameOnly, true);
  assert.deepEqual(contentParts([{ type: "text", text: "a\n  b", cache_control: { type: "ephemeral" } }]), ["a\n  b"]);
  const midInstruction = snapshot({
    request: {
      messages: [
        { role: "user", content: "first" },
        { role: "developer", content: "later" },
      ],
    },
  });
  assert.deepEqual(
    midInstruction.conversation.map((m) => m.role),
    ["user", "developer"],
  );
});

test("message differences do not mistake compaction for appended history", () => {
  const prior = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
  ];
  assert.deepEqual([...changedMessages([...prior, { role: "user", content: "next" }], prior)], [2]);
  assert.deepEqual([...changedMessages([{ role: "user", content: "summary" }], prior)], [0]);
  assert.deepEqual([...changedMessages(prior, prior)], []);
});

test("session links and transcript boundaries do not cross into another turn", () => {
  assert.equal(parseSession("https://example.com/admin/history/s/abc?turn=2"), "abc");
  assert.equal(parseSession(" abc "), "abc");
  assert.throws(() => parseSession("https://example.com/admin/history"));
  const entries = [
    { seq: 7, type: "user" },
    { seq: 8, type: "assistant" },
    { seq: 9, type: "user" },
  ];
  assert.deepEqual(
    turnEntries(entries, 7).map((e) => e.seq),
    [7, 8],
  );
  assert.deepEqual(turnEntries(entries, 1), []);
  assert.deepEqual(turnEntries(entries, null), []);
});

function setup() {
  const dom = new JSDOM('<div id="header-controls"></div><div id="root">previous page</div>', {
    runScripts: "outside-only",
    url: "http://localhost/admin",
  });
  dom.window.eval(
    bundle +
      `;window.ui=seat;window.paths=[];window.rows=[{id:'a',turnSeq:1,step:0,createdAt:1,model:'model'},{id:'b',turnSeq:1,step:1,createdAt:2,model:'model'},{id:'c',turnSeq:5,step:0,createdAt:3,model:'model'}];window.services={scope:'org:test',current:()=>true,pageShell:()=>{},go:()=>{},stateToUrl:()=>'/transcript',api:async(method,path)=>{paths.push(path);if(path.includes('turnSeq='))return {ok:true,data:{requests:rows.map(r=>({...r,promptEnvelope:{system:'<script>unsafe</script>',tools:[{name:'read',description:'Read exact text'},{name:'search',description:'Search exact text'}]}}))}};return {ok:true,data:path.includes('/llm?')?{requests:rows}:{session:{id:'session',type:'dm',scopeId:'org:test'},entries:[{seq:1,type:'user',payload:'hello'},{seq:2,type:'assistant',payload:'response'}]}}}};`,
  );
  return dom;
}

test("viewer loads turn bodies lazily, selects tools, escapes payloads and labels capture gaps", async () => {
  const dom = setup();
  try {
    await dom.window.eval('ui.show(document.getElementById("root"),"session",services)');
    const root = dom.window.document.getElementById("root")!;
    assert.doesNotMatch(root.textContent!, /previous page/);
    assert.equal(root.querySelector("script"), null);
    assert.match(root.textContent!, /Conversation input not captured/);
    assert.equal(root.querySelector<HTMLSelectElement>('[aria-label="Model call"]')!.value, "2");
    assert.equal(dom.window.eval('paths.filter(p=>p.includes("turnSeq=")).length'), 1);
    const search = [...root.querySelectorAll<HTMLButtonElement>(".agent-seat-tool-list button")].find(
      (button) => button.textContent?.trim() === "search",
    )!;
    search.click();
    assert.match(root.querySelector(".agent-seat-tool-detail")!.textContent!, /Search exact text/);
    assert.equal(search.getAttribute("aria-pressed"), "true");
  } finally {
    dom.window.close();
  }
});

test("late request results cannot replace a departed page", async () => {
  const dom = setup();
  try {
    dom.window.eval(
      'window.resolvers=[];services.api=async()=>new Promise(r=>resolvers.push(r));window.pending=ui.show(document.getElementById("root"),"old",services)',
    );
    dom.window.eval("ui.cancel();resolvers.forEach(resolve=>resolve({ok:true,data:{requests:[]}}))");
    await dom.window.eval("pending");
    assert.match(dom.window.document.getElementById("root")!.textContent!, /Loading captured context/);
  } finally {
    dom.window.close();
  }
});

test("turn links select the requested turn instead of the latest capture", async () => {
  const dom = setup();
  try {
    dom.window.eval('services.current=(id,turn)=>id==="session"&&turn==="agent:1"');
    await dom.window.eval('ui.show(document.getElementById("root"),"session",services,"1")');
    assert.equal(dom.window.document.querySelector<HTMLSelectElement>('[aria-label="Model call"]')!.value, "0");
    assert.match(String(dom.window.eval("paths.at(-1)")), /turnSeq=1$/);
  } finally {
    dom.window.close();
  }
});

test("a missing turn capture is explicit and never silently shows the latest turn", async () => {
  const dom = setup();
  try {
    await dom.window.eval('ui.show(document.getElementById("root"),"session",services,"99")');
    assert.match(
      dom.window.document.querySelector('[role="alert"]')!.textContent!,
      /No model request was captured for turn #99/,
    );
    assert.equal(dom.window.document.querySelector(".agent-seat-layout"), null);
    assert.equal(dom.window.eval('paths.some(p=>p.includes("turnSeq="))'), false);
  } finally {
    dom.window.close();
  }
});

test("missing turn with one available call can recover through the call selector", async () => {
  const dom = setup();
  try {
    dom.window.eval("rows=rows.slice(0,1)");
    await dom.window.eval('ui.show(document.getElementById("root"),"session",services,"99")');
    const select = dom.window.document.querySelector<HTMLSelectElement>('[aria-label="Model call"]')!;
    assert.equal(select.value, "");
    select.value = "0";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(dom.window.document.querySelector(".agent-seat-layout"));
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
  } finally {
    dom.window.close();
  }
});

test("sequence links select the preceding capture and reveal the clicked event", async () => {
  const dom = setup();
  try {
    dom.window.eval(`const original=services.api;services.api=async(method,path)=>{
      const result=await original(method,path);
      if(!path.includes('/llm?'))result.data.entries=[
        {seq:1,type:'user',createdAt:1,payload:'hello'},
        {seq:2,type:'tool_call',createdAt:2,payload:'read'},
        {seq:3,type:'tool_result',createdAt:2.5,payload:'result'},
        {seq:4,type:'assistant',createdAt:3,payload:'later'}];
      return result;
    };services.current=(id,turn)=>turn==='agent:1:3';`);
    await dom.window.eval('ui.show(document.getElementById("root"),"session",services,"1:3")');
    const root = dom.window.document.getElementById("root")!;
    assert.equal(root.querySelector<HTMLSelectElement>('[aria-label="Model call"]')!.value, "1");
    assert.match(root.querySelector('[aria-current="step"]')!.textContent!, /tool_result · #3/);
    assert.equal(root.querySelectorAll(".agent-seat-transcript .agent-seat-block").length, 3);
    assert.equal(root.querySelector(".agent-seat-loader"), null);
    assert.doesNotMatch(root.textContent!, /Session ID or admin link/);
  } finally {
    dom.window.close();
  }
});

test("tool parameters show required fields, choices and nested schemas as escaped text", async () => {
  const dom = setup();
  try {
    dom.window.eval(`const original=services.api;services.api=async(method,path)=>{
      const result=await original(method,path);
      if(path.includes('turnSeq='))for(const row of result.data.requests)row.promptEnvelope.tools=[{
        type:'function',function:{name:'search',parameters:{type:'object',required:['query'],properties:{
          query:{type:'string',description:'<script>unsafe</script>'},
          mode:{type:'string',enum:['fast','deep'],default:'fast'},
          filter:{type:'object',properties:{count:{type:'integer'}}}
        }}}}];
      return result;
    };`);
    await dom.window.eval('ui.show(document.getElementById("root"),"session",services)');
    const params = dom.window.document.querySelector('[aria-label="Tool parameters"]')!;
    assert.match(params.textContent!, /query\s*string\s*Required/);
    assert.match(params.textContent!, /Choices:.*fast.*deep/s);
    assert.match(params.textContent!, /Default:.*fast/s);
    assert.match(params.textContent!, /count\s*integer\s*Optional/);
    assert.match(params.textContent!, /<script>unsafe<\/script>/);
    assert.equal(params.querySelector("script"), null);
    for (const key of ["parameters", "input_schema", "inputSchema"]) {
      assert.deepEqual(
        snapshot({ request: { tools: [{ name: "tool", [key]: { type: "object" } }] } }).tools[0]?.parameters,
        { type: "object" },
      );
    }
  } finally {
    dom.window.close();
  }
});
