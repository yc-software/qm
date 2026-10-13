import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createServer } from "../../src/api/server.ts";
import { signedHeaders, withSourceAuthNonce } from "../../plugins/chassis/src/core-client.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../plugins/chassis/src/portal-identity.ts";
import type { ModelReply, ModelRequest } from "./support/fake-gateway.ts";
import { journeyTestOptions, startJourneyApp } from "./support/journey-app.ts";

const SECRET = "journey-w2-signing-secret".repeat(2);
const ROWS = ["company,batch,stage", "Acme Rockets,W24,seed", "Beta Bakery,S23,series a", "Gamma Grid,W25,pre-seed"];
const CSV = `${ROWS.join("\n")}\n`;

type Block = { type?: string; content?: unknown };
type Step = (lastResult: Block | undefined) => ModelReply;

function lastToolResult(req: ModelRequest): Block | undefined {
  const last = req.messages.at(-1);
  if (!Array.isArray(last?.content)) return undefined;
  return (last.content as Block[]).filter((b) => b.type === "tool_result").at(-1);
}

function resultText(block: Block | undefined): string {
  if (!block) return "";
  if (typeof block.content === "string") return block.content;
  return (Array.isArray(block.content) ? (block.content as Array<{ text?: string }>) : [])
    .map((part) => part.text ?? "")
    .join("");
}

test("a data lookup in a web session produces a CSV the user can open", journeyTestOptions(120_000), async () => {
  const app = await startJourneyApp(
    { maxRequestBytes: 10 * 1024 * 1024, contextWindowTokens: 200_000, maxOutputTokens: 32_000 },
    { signingSecret: SECRET },
  );
  const server = createServer(app.built.app, { signingSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const core = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const actor = "analyst@example.com";
  const threadRef = `web:${actor}:lookup-${Date.now()}`;
  const results: Block[] = [];
  let plan: Step[] = [];
  app.gateway.respond = (req) => {
    if (JSON.stringify(req.system).includes("security boundary classifier")) return { text: '{"decision":"auto"}' };
    if (!req.tools?.length) return { text: "Company export" };
    const last = lastToolResult(req);
    if (last) results.push(last);
    const step = plan.shift();
    return step ? step(last) : { text: "done" };
  };
  const coreGet = (path: string) => {
    const signed = withSourceAuthNonce(path, SECRET);
    return fetch(`${core}${signed}`, {
      headers: {
        ...signedHeaders(SECRET, "GET", signed, ""),
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: actor, exp: Date.now() + 60_000 }, SECRET),
      },
    });
  };
  const open = (id: string) =>
    coreGet(`/v1/files/${encodeURIComponent(id)}/content?viewer=${encodeURIComponent(actor)}`);
  const turn = async (text: string, steps: Step[]) => {
    plan = steps;
    results.length = 0;
    const result = await app.webTurn(actor, threadRef, text);
    assert.equal(result.status, "ok", `turn failed: ${result.reason}`);
    assert.ok(result.reply?.trim(), "the user gets a reply");
    assert.deepEqual(plan, [], "the agent ran every planned step");
    return result;
  };
  const assertOpens = async (id: string) => {
    const res = await open(id);
    assert.equal(res.status, 200, `file ${id} opens: ${res.status === 200 ? "" : await res.text()}`);
    assert.match(res.headers.get("content-type") ?? "", /^text\/csv\b/);
    assert.match(res.headers.get("content-disposition") ?? "", /filename\*=UTF-8''companies\.csv/);
    assert.equal(await res.text(), CSV);
  };
  try {
    let sandboxId = "";
    const first = await turn("Pull the company list into a CSV I can open.", [
      () => ({ tool: "sandbox", input: { action: "create", backend: "sprites", purpose: "Computer for export" } }),
      (created) => {
        sandboxId = /"id":"([^"]+)"/.exec(resultText(created))?.[1] ?? "";
        return {
          tool: "sandbox",
          input: { action: "set_default", sandbox_id: sandboxId, purpose: "Use new computer" },
        };
      },
      () => ({
        tool: "execute",
        input: {
          command: `mkdir -p exports && printf '%s\\n' ${ROWS.map((row) => `'${row}'`).join(" ")} > exports/companies.csv && wc -l exports/companies.csv`,
          sandbox_id: sandboxId,
          purpose: "Write company CSV",
        },
      }),
      () => ({ tool: "attach", input: { files: ["exports/companies.csv"] } }),
      () => ({ text: "Here is the company export." }),
    ]);
    assert.match(resultText(results[2]), /4 exports\/companies\.csv/, "the command wrote four rows");
    assert.match(resultText(results[3]), /\[attached\] companies\.csv \(\d+ bytes, text\/csv\)/);
    const [sent] = first.attachments ?? [];
    assert.equal(first.attachments?.length, 1, "the reply carries one file");
    assert.equal(sent!.name, "companies.csv");
    assert.equal(sent!.mimetype, "text/csv");
    assert.ok(sent!.artifactId, "the attachment is a stored file the UI can link");
    await assertOpens(sent!.artifactId);
    const transcript = await coreGet(
      `/v1/sessions/${encodeURIComponent(first.sessionId!)}?viewer=${encodeURIComponent(actor)}`,
    );
    assert.equal(transcript.status, 200);
    assert.ok((await transcript.text()).includes(sent!.artifactId), "the transcript links the file chip");

    const again = await turn("Send me that CSV again please.", [
      () => ({ tool: "attach", input: { files: ["exports/companies.csv"] } }),
      () => ({ text: "Sent it again." }),
    ]);
    assert.equal(again.attachments?.length, 1, "the second reply carries the file again");
    await assertOpens(again.attachments![0]!.artifactId!);
    await assertOpens(sent!.artifactId);

    const missing = await turn("Also attach the board deck.", [
      () => ({ tool: "attach", input: { files: ["exports/board-deck.pdf"] } }),
      (failed) => ({
        text: /not attached/.test(resultText(failed)) ? "I could not find the board deck." : "Attached.",
      }),
    ]);
    assert.match(resultText(results[0]), /not attached.*board-deck\.pdf \(not found\)/, "the agent sees why");
    assert.equal(missing.reply, "I could not find the board deck.");
    assert.equal(missing.attachments?.length ?? 0, 0, "nothing is delivered for a missing path");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.stop();
  }
});
