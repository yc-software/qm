import { countTokens } from "../../src/util/tokens.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { documentBlocks, nativeDocumentFormat, withDocumentInputs } from "../../src/harness/document-inputs.ts";
import { documentTokenCharges, estimateDocumentTokens, isDocumentAttachment } from "../../src/core/document-kinds.ts";
import {
  documentFallbackText,
  documentText,
  historicalDocumentMetas,
  loadDocumentInputs,
  type DocumentInput,
} from "../../src/core/document-inputs.ts";
import { guardOutputBudget, trimPayloadToByteBudget } from "../../src/harness/pi-payload.ts";
import { mimeFromName } from "../../src/core/attachments.ts";
import type { AttachmentMeta } from "../../src/types.ts";
import { storedItem, type NewItem } from "../../src/sessions/items.ts";
import type { FileArtifact, FileArtifactStore } from "../../src/files/file-artifact-store.ts";

const openai = { api: "openai-responses", provider: "openai", input: ["text", "image"] };
const anthropic = { api: "anthropic-messages", provider: "anthropic", input: ["text", "image"] };
async function fixture(ext: string): Promise<DocumentInput> {
  return {
    name: `sample.${ext}`,
    mimeType: mimeFromName(`sample.${ext}`),
    dataBase64: (await readFile(new URL(`../fixtures/documents/sample.${ext}`, import.meta.url))).toString("base64"),
  };
}

for (const ext of [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "doc",
  "xls",
  "ppt",
  "odt",
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "xml",
  "html",
  "yaml",
  "py",
  "js",
  "ts",
  "css",
  "sql",
  "eml",
  "ics",
  "vcf",
  "srt",
  "vtt",
]) {
  test(`Responses sends original ${ext} bytes as native file input`, async () => {
    const document = await fixture(ext);
    const payload = (await withDocumentInputs(
      { model: "test", input: [{ role: "user", content: [{ type: "input_text", text: "Summarize" }] }] },
      openai,
      [document],
    )) as { input: { content: Record<string, unknown>[] }[] };
    const block = payload.input[0]!.content.at(-1)!;
    assert.equal(block.type, "input_file");
    assert.equal(block.filename, document.name);
    assert.equal(String(block.file_data).split(",")[1], document.dataBase64);
  });
}

for (const ext of [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "txt",
  "md",
  "csv",
  "tsv",
  "json",
  "xml",
  "html",
  "yaml",
  "py",
  "js",
  "ts",
  "css",
  "sql",
  "eml",
  "ics",
  "vcf",
  "srt",
  "vtt",
]) {
  test(`automatic ${ext} fallback extracts the fixture's verification code`, async () => {
    const document = await fixture(ext);
    const text = await documentFallbackText(document);
    assert.ok(text.includes(`${ext.toUpperCase()}-QUARTZ-731`));
    assert.match(text, /extracted text only/);
    assert.match(text, /not instructions/);
  });
}

test("Anthropic receives PDF document bytes and text document content", async () => {
  const pdf = await fixture("pdf");
  const blocks = await documentBlocks([pdf, await fixture("txt")], anthropic);
  assert.deepEqual(blocks[0], {
    type: "document",
    title: pdf.name,
    source: { type: "base64", media_type: "application/pdf", data: pdf.dataBase64 },
  });
  assert.equal(blocks[1]!.type, "document");
  assert.match(JSON.stringify(blocks[1]), /QUARTZ-731/);
});

test("unsupported routes use extraction instead of unsupported wire types", async () => {
  for (const model of [
    { ...openai, provider: "custom:test" },
    { ...openai, api: "openai-codex-responses" },
  ]) {
    const blocks = await documentBlocks([await fixture("pdf")], model);
    assert.equal(blocks[0]!.type, "input_text");
    assert.match(String(blocks[0]!.text), /QUARTZ-731/);
  }
  assert.equal(nativeDocumentFormat({ ...openai, input: ["text"] }, await fixture("pdf")), undefined);
});

test("OpenRouter uses native PDF processing without silently selecting an OCR service", async () => {
  const payload = (await withDocumentInputs(
    { messages: [{ role: "user", content: "Summarize" }] },
    { api: "openai-completions", provider: "openrouter", id: "anthropic/claude-sonnet", input: ["image"] },
    [await fixture("pdf")],
  )) as { plugins: unknown[]; messages: { content: { type: string }[] }[] };
  assert.deepEqual(payload.plugins, [{ id: "file-parser", pdf: { engine: "native" } }]);
  assert.equal(payload.messages[0]!.content.at(-1)!.type, "file");
});

test("Google document parts preserve PDFs and use text for office files", async () => {
  const payload = (await withDocumentInputs(
    { contents: [{ role: "user", parts: [{ text: "Summarize" }] }] },
    { api: "google-generative-ai", input: ["image"] },
    [await fixture("pdf"), await fixture("docx")],
  )) as { contents: { parts: Record<string, unknown>[] }[] };
  assert.ok(payload.contents[0]!.parts.some((part) => part.inlineData));
  assert.match(String(payload.contents[0]!.parts.at(-1)!.text), /QUARTZ-731/);
});

test("invalid binary documents and empty scans never masquerade as read documents", async () => {
  const document = await fixture("pdf");
  document.dataBase64 = Buffer.from("not a PDF").toString("base64");
  assert.match(await documentFallbackText(document), /could not be included/);
  assert.match(await documentFallbackText(await fixture("doc")), /Do not summarize it from another file/);
});

test("request byte budgets replace all native document wire formats with explicit notices", async () => {
  for (const [model, payload] of [
    [openai, { input: [{ role: "user", content: [] }] }],
    [anthropic, { messages: [{ role: "user", content: [] }] }],
    [
      { api: "openai-completions", provider: "openai", input: ["image"] },
      { messages: [{ role: "user", content: [] }] },
    ],
    [{ api: "google-generative-ai", input: ["image"] }, { contents: [{ role: "user", parts: [] }] }],
  ] as const) {
    const encoded = await withDocumentInputs(payload, model, [await fixture("pdf")]);
    const trimmed = trimPayloadToByteBudget(encoded, 1000);
    assert.match(JSON.stringify(trimmed), /Document omitted/);
    assert.doesNotMatch(JSON.stringify(trimmed), /JVBER/);
  }
});

function storeFor(data = Buffer.from("QUARTZ-731")) {
  const artifact = {
    id: "doc1",
    name: "sample.txt",
    mimetype: "text/plain",
    sizeBytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    ownerScopeId: "user:owner",
    enabled: true,
  } as FileArtifact;
  let opens = 0;
  const store = {
    get: async () => artifact,
    open: async () => {
      opens++;
      return { artifact, sizeBytes: data.length, stream: Readable.from(data) };
    },
  } as unknown as FileArtifactStore;
  const meta = {
    name: artifact.name,
    mimetype: artifact.mimetype,
    artifactId: artifact.id,
    sizeBytes: artifact.sizeBytes,
    direction: "in",
  } as AttachmentMeta;
  return { artifact, store, meta, opens: () => opens };
}

const items = (list: NewItem[]) => list.map((item, seq) => storedItem(item, { sessionId: "s", seq, createdAt: seq }));

test("restores stopped/restarted turns from durable document metadata and deduplicates retries", async () => {
  const { store, meta, opens } = storeFor();
  const history = items([
    { kind: "UserMessage", body: { attachments: [meta] } },
    { kind: "AgentMessage", text: "stopped" },
  ]);
  const inputs = await loadDocumentInputs(store, [...historicalDocumentMetas(history), meta], () => true);
  assert.equal(inputs.documents.length, 1);
  assert.equal(opens(), 1);
  assert.match(await documentFallbackText(inputs.documents[0]!), /QUARTZ-731/);
});

test("reuploaded identical documents consume the input budget once and retain the newest artifact", async () => {
  const { store, meta, artifact, opens } = storeFor();
  store.get = async (id) => ({ ...artifact, id });
  const open = store.open.bind(store);
  store.open = async (id) => {
    const loaded = await open(id);
    return loaded && { ...loaded, artifact: { ...loaded.artifact, id } };
  };
  const checked: string[] = [];
  const inputs = await loadDocumentInputs(
    store,
    [meta, { ...meta, artifactId: "new-upload" }],
    (file) => {
      checked.push(file.id);
      return true;
    },
    artifact.sizeBytes,
  );
  assert.equal(inputs.documents.length, 1);
  assert.equal(inputs.documents[0]!.artifactId, "new-upload");
  assert.deepEqual(inputs.notices, []);
  assert.equal(opens(), 1);
  assert.ok(checked.includes(artifact.id));
  assert.ok(checked.includes("new-upload"));
});

test("steered reuploads already in the turn do not consume another document slot or emit budget notices", async () => {
  const { store, meta, artifact, opens } = storeFor();
  const initial = await loadDocumentInputs(store, [meta], () => true);
  store.get = async (id) => ({ ...artifact, id });
  const checked: string[] = [];
  const steered = await loadDocumentInputs(
    store,
    [{ ...meta, artifactId: "steered-upload" }],
    (file) => {
      checked.push(file.id);
      return true;
    },
    0,
    undefined,
    0,
    initial.documents,
  );
  assert.deepEqual(steered, { documents: [], notices: [], tokens: 0 });
  assert.deepEqual(checked, ["steered-upload"]);
  assert.equal(opens(), 1);
});

test("document replay follows compaction boundaries", () => {
  const { meta } = storeFor();
  const recent = { ...meta, artifactId: "recent" };
  const history = items([
    { kind: "UserMessage", body: { attachments: [meta] } },
    { kind: "UserMessage", body: { attachments: [recent] } },
    { kind: "ContextCompaction", text: "Prior upload", throughSeq: 0 },
  ]);
  assert.deepEqual(historicalDocumentMetas(history), [recent]);
  assert.deepEqual(history[0]!.body.attachments, [meta]);
});

test("document restoration checks current access and budgets before opening bytes", async () => {
  const { store, meta, opens } = storeFor();
  assert.equal((await loadDocumentInputs(store, [meta], () => false)).documents.length, 0);
  assert.equal(opens(), 0);
  const result = await loadDocumentInputs(store, [meta], () => true, 1);
  assert.equal(result.documents.length, 0);
  assert.match(result.notices[0]!, /not included inline/);
  assert.equal(opens(), 0);
});

test("document restoration rejects tampered bytes", async () => {
  const { store, meta, artifact } = storeFor();
  artifact.sha256 = "bad";
  const result = await loadDocumentInputs(store, [meta], () => true);
  assert.equal(result.documents.length, 0);
  assert.match(result.notices[0]!, /integrity/);
});

test("fallback text shares one token budget derived from the model's window minus its output reserve", async () => {
  const body = Array.from({ length: 20_000 }, (_, i) => `word${i}`).join(" ");
  const documents = Array.from({ length: 10 }, (_, i) => ({
    name: `large-${i}.txt`,
    mimeType: "text/plain",
    dataBase64: Buffer.from(body).toString("base64"),
  }));
  const request = { input: [{ role: "user", content: [{ type: "input_text", text: "Summarize" }] }] };
  const payload = await withDocumentInputs(
    request,
    { api: "openai-codex-responses", contextWindow: 32_000, maxTokens: 8_000 },
    documents,
  );
  const rendered = JSON.stringify(payload);
  assert.ok(countTokens(rendered) <= 32_000, `the request fits the window (${countTokens(rendered)} tokens)`);
  assert.ok(countTokens(rendered) > 20_000, "the whole budget past the output reserve is used for documents");
  assert.match(rendered, /truncated to fit/);
  const unbounded = JSON.stringify(await withDocumentInputs(request, { api: "openai-codex-responses" }, documents));
  assert.doesNotMatch(unbounded, /truncated to fit/, "a model without a known window gets every document whole");
});

test("document text is extracted whole; fitting it to the model is the request builder's job", async () => {
  const text = (body: string, name = "notes.txt") => ({
    name,
    mimeType: name.endsWith(".rtf") ? "application/rtf" : "text/plain",
    dataBase64: Buffer.from(body).toString("base64"),
  });
  assert.equal(await documentText(text("x".repeat(200_001))), "x".repeat(200_001));
  const office = await documentText(text(`{\\rtf1 ${"y".repeat(200_100)}}`, "long.rtf"));
  assert.equal(office.length, 200_100);
  assert.doesNotMatch(office, /truncated/);
});

test("a large text attachment is charged only what is left of the document budget, so it is fitted rather than stubbed", async () => {
  const csv = Buffer.from(Array.from({ length: 12_000 }, (_, i) => `${i},${"v".repeat(24)}`).join("\n"));
  assert.ok(csv.length > 300_000);
  const { store, meta, artifact } = storeFor(csv);
  artifact.name = "big.csv";
  artifact.mimetype = "text/csv";
  meta.name = "big.csv";
  meta.mimetype = "text/csv";
  assert.equal(estimateDocumentTokens(artifact), Math.ceil(csv.length / 4));
  const loaded = await loadDocumentInputs(
    store,
    [meta],
    () => true,
    undefined,
    undefined,
    undefined,
    undefined,
    30_000,
  );
  assert.equal(loaded.documents.length, 1, "the document is inlined, not reduced to a stub");
  assert.deepEqual(loaded.notices, []);
  const payload = await withDocumentInputs(
    { input: [{ role: "user", content: [{ type: "input_text", text: "Summarize" }] }] },
    { api: "openai-codex-responses", contextWindow: 200_000 },
    loaded.documents,
  );
  const rendered = JSON.stringify(payload);
  assert.match(rendered, /0,vvvv/);
});

test("Pi proxy and Bedrock fallback use their actual provider request shapes", async () => {
  const documents = [await fixture("txt")];
  const proxy = await withDocumentInputs(
    { context: { messages: [{ role: "user", content: "Summarize" }] } },
    { api: "pi-messages" },
    documents,
  );
  assert.match(JSON.stringify(proxy), /QUARTZ-731/);
  const bedrock = (await withDocumentInputs(
    { messages: [{ role: "user", content: [{ text: "Summarize" }] }] },
    { api: "bedrock-converse-stream" },
    documents,
  )) as { messages: { content: Record<string, unknown>[] }[] };
  assert.equal(bedrock.messages[0]!.content.at(-1)!.type, undefined);
  assert.match(String(bedrock.messages[0]!.content.at(-1)!.text), /QUARTZ-731/);
});

test("one failed historical document does not prevent loading another document", async () => {
  const { store, meta } = storeFor();
  const get = store.get.bind(store);
  store.get = async (id) => {
    if (id === "broken") throw new Error("storage unavailable");
    return get(id);
  };
  const result = await loadDocumentInputs(store, [meta, { ...meta, artifactId: "broken" }], () => true);
  assert.equal(result.documents.length, 1);
  assert.match(result.notices[0]!, /unavailable/);
});

test("document loading aborts active streams promptly", async () => {
  const { store, meta, artifact } = storeFor();
  const stream = new Readable({ read() {} });
  store.open = async () => ({ artifact, sizeBytes: artifact.sizeBytes, stream });
  const controller = new AbortController();
  const pending = loadDocumentInputs(store, [meta], () => true, undefined, controller.signal);
  setTimeout(() => controller.abort(new Error("cancelled")), 10);
  await assert.rejects(pending, /cancelled/);
  assert.equal(stream.destroyed, true);
});

test("extensionless documents use their MIME type for native and fallback input", async () => {
  const pdf = { ...(await fixture("pdf")), name: "download" };
  assert.equal(isDocumentAttachment({ name: pdf.name, mimetype: pdf.mimeType }), true);
  assert.equal(nativeDocumentFormat(anthropic, pdf), "anthropic");
  assert.match(await documentFallbackText(pdf), /PDF-QUARTZ-731/);
  const blocks = await documentBlocks([pdf], openai);
  assert.equal(blocks.at(-1)?.filename, "download.pdf");
  const txt = {
    name: "download",
    mimeType: "text/plain; charset=utf-8",
    dataBase64: Buffer.from("mime-only-text").toString("base64"),
  };
  assert.match(await documentFallbackText(txt), /mime-only-text/);
});

test("scanned PDFs explicitly report unavailable text on a text-only route", async () => {
  const dataBase64 = (await readFile(new URL("../fixtures/documents/scanned.pdf", import.meta.url))).toString("base64");
  assert.match(
    await documentFallbackText({ name: "scan.pdf", mimeType: "application/pdf", dataBase64 }),
    /No extractable text/,
  );
});

test("native file inputs normalize text MIME types rejected by the provider", async () => {
  for (const ext of ["xml", "ts", "yaml"]) {
    const blocks = await documentBlocks([await fixture(ext)], openai);
    assert.match(String(blocks.at(-1)?.file_data), /^data:text\/plain;base64,/);
  }
});

test("unknown vision gateways do not assume native PDF support", async () => {
  assert.equal(
    nativeDocumentFormat({ api: "openai-completions", provider: "qm:gateway", input: ["image"] }, await fixture("pdf")),
    undefined,
  );
});

test("RTF uses reliable text extraction on Responses routes", async () => {
  const blocks = await documentBlocks([await fixture("rtf")], openai);
  assert.equal(blocks[0]?.type, "input_text");
  assert.match(String(blocks[0]?.text), /RTF-QUARTZ-731/);
});

test("encrypted PDFs do not expose content through text fallback", async () => {
  const dataBase64 = (await readFile(new URL("../fixtures/documents/encrypted.pdf", import.meta.url))).toString(
    "base64",
  );
  const text = await documentFallbackText({ name: "encrypted.pdf", mimeType: "application/pdf", dataBase64 });
  assert.match(text, /could not be included/);
  assert.doesNotMatch(text, /QUARTZ-731/);
});

for (const model of [
  openai,
  anthropic,
  { api: "google-generative-ai", provider: "google", input: ["text", "image"] },
  { api: "openai-completions", provider: "openai", input: ["text", "image"] },
]) {
  test(`${model.api} isolates invalid documents while retaining scanned native PDFs`, async () => {
    const documents = await Promise.all(
      ["scanned", "malformed", "encrypted"].map(async (name) => ({
        name: `${name}.pdf`,
        mimeType: "application/pdf",
        dataBase64: (await readFile(new URL(`../fixtures/documents/${name}.pdf`, import.meta.url))).toString("base64"),
      })),
    );
    for (let turn = 0; turn < 2; turn++) {
      const blocks = JSON.stringify(
        await documentBlocks(
          documents.map((document) => ({ ...document })),
          model,
        ),
      );
      assert.ok(blocks.includes(documents[0]!.dataBase64));
      for (const document of documents.slice(1)) {
        assert.ok(!blocks.includes(document.dataBase64));
        assert.ok(blocks.includes(document.name));
      }
      assert.equal((blocks.match(/could not be included/g) ?? []).length, 2);
    }
  });
}

test("output budgeting does not count native document base64 as text tokens", () => {
  const data = "a".repeat(1_200_000);
  for (const content of [
    { type: "input_file", file_data: `data:application/pdf;base64,${data}` },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
    { type: "file", file: { file_data: `data:application/pdf;base64,${data}` } },
    { inlineData: { mimeType: "application/pdf", data } },
  ]) {
    const payload = { max_tokens: 1, messages: [{ role: "user", content: [content] }] };
    const result = guardOutputBudget(payload, { contextWindow: 200_000, maxTokens: 8192 });
    assert.equal(result.kind, "raised");
    if (result.kind === "raised") assert.ok(result.estimatedPromptTokens < 2000);
  }
});

test("text documents split the token budget fairly, so one large file does not stub the others", async () => {
  const text = (name: string, sizeBytes: number) => ({ name, mimetype: "text/plain", sizeBytes });
  assert.deepEqual(documentTokenCharges([text("big.txt", 400_000), text("small.txt", 4_000)], 30_000), [29_000, 1_000]);
  assert.deepEqual(
    documentTokenCharges(
      [text("a.txt", 400_000), { name: "deck.pdf", mimetype: "application/pdf", sizeBytes: 40_000 }],
      30_000,
    ),
    [20_000, 10_000],
  );
  assert.deepEqual(documentTokenCharges([text("a.txt", 400_000), text("b.txt", 400_000)], 30_000), [15_000, 15_000]);
  assert.deepEqual(documentTokenCharges([text("a.txt", 400_000)], 0), [0]);

  const big = Buffer.from("b".repeat(400_000));
  const small = Buffer.from("s".repeat(4_000));
  const artifacts = [
    { id: "big", name: "big.txt", data: big },
    { id: "small", name: "small.txt", data: small },
  ].map(({ id, name, data }) => ({
    artifact: {
      id,
      name,
      mimetype: "text/plain",
      sizeBytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      ownerScopeId: "user:owner",
      enabled: true,
    } as FileArtifact,
    data,
  }));
  const byId = new Map(artifacts.map((entry) => [entry.artifact.id, entry]));
  const store = {
    get: async (id: string) => byId.get(id)?.artifact,
    open: async (id: string) => {
      const entry = byId.get(id)!;
      return { artifact: entry.artifact, sizeBytes: entry.data.length, stream: Readable.from(entry.data) };
    },
  } as unknown as FileArtifactStore;
  const metas = artifacts.map(
    ({ artifact }) =>
      ({
        name: artifact.name,
        mimetype: artifact.mimetype,
        artifactId: artifact.id,
        sizeBytes: artifact.sizeBytes,
        direction: "in",
      }) as AttachmentMeta,
  );
  const loaded = await loadDocumentInputs(store, metas, () => true, undefined, undefined, undefined, undefined, 30_000);
  assert.deepEqual(
    loaded.documents.map((document) => document.name),
    ["big.txt", "small.txt"],
  );
  assert.deepEqual(loaded.notices, []);
  assert.equal(loaded.tokens, 30_000);
});
