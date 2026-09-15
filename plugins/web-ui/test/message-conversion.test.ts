import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as ts from "typescript";
import { attachmentContent, convertMessagesToLlm } from "../src/message-conversion.ts";

const upstreamSource = readFileSync(
  new URL("../node_modules/@earendil-works/pi-web-ui/dist/components/Messages.js", import.meta.url),
  "utf8",
);
const upstreamTree = ts.createSourceFile("Messages.js", upstreamSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const upstreamNames = new Set([
  "convertAttachments",
  "isUserMessageWithAttachments",
  "isArtifactMessage",
  "defaultConvertToLlm",
]);
const upstreamFunctions = upstreamTree.statements
  .filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && Boolean(statement.name && upstreamNames.has(statement.name.text)),
  )
  .map((statement) => statement.getText(upstreamTree).replace(/^export\s+/, ""));
assert.equal(upstreamFunctions.length, upstreamNames.size);
const upstreamContext: { oracle?: (messages: unknown[]) => unknown[] } = {};
runInNewContext(`${upstreamFunctions.join("\n")}\nglobalThis.oracle = defaultConvertToLlm;`, upstreamContext);
const upstreamConvert = upstreamContext.oracle!;

const image = {
  id: "image-1",
  type: "image" as const,
  fileName: "diagram.png",
  mimeType: "image/png",
  size: 12,
  content: "aW1hZ2U=",
};
const documentAttachment = {
  id: "doc-1",
  type: "document" as const,
  fileName: "notes.txt",
  mimeType: "text/plain",
  size: 9,
  content: "ZG9jdW1lbnQ=",
  extractedText: "Document body",
};
const emptyDocument = {
  id: "doc-2",
  type: "document" as const,
  fileName: "empty.txt",
  mimeType: "text/plain",
  size: 0,
  content: "",
  extractedText: "",
};

const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const convert = (messages: unknown[]) => convertMessagesToLlm(messages as Parameters<typeof convertMessagesToLlm>[0]);

test("local conversion matches the installed upstream converter for every supported role", () => {
  const messages = [
    { role: "user", content: "plain user", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "assistant" }],
      timestamp: 2,
      stopReason: "stop",
      usage: { input: 1, output: 1 },
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "lookup",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 3,
    },
    { role: "artifact", action: "create", filename: "ui.txt", content: "UI only", timestamp: "4" },
    { role: "status", content: "unknown", timestamp: 5 },
    {
      role: "user-with-attachments",
      content: "attached string",
      timestamp: 6,
      attachments: [image, documentAttachment, emptyDocument],
    },
    {
      role: "user-with-attachments",
      content: [
        { type: "text", text: "array text" },
        { type: "image", data: "existing", mimeType: "image/jpeg" },
      ],
      timestamp: 7,
      attachments: [documentAttachment],
    },
  ];

  assert.deepEqual(normalize(convert(messages)), normalize(upstreamConvert(messages)));
});

test("standard LLM messages pass through by identity while UI and unknown messages are dropped", () => {
  const user = { role: "user", content: "user", timestamp: 1 };
  const assistant = { role: "assistant", content: [], timestamp: 2 };
  const toolResult = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "tool",
    content: [],
    isError: false,
    timestamp: 3,
  };
  const output = convert([
    user,
    { role: "artifact", action: "delete", filename: "old.txt", timestamp: "4" },
    assistant,
    { role: "unknown", content: "drop" },
    toolResult,
  ]);

  assert.deepEqual(output, [user, assistant, toolResult]);
  assert.equal(output[0], user);
  assert.equal(output[1], assistant);
  assert.equal(output[2], toolResult);
});

test("attachment conversion preserves string and array content and omits empty extracted documents", () => {
  assert.deepEqual(attachmentContent([image, documentAttachment, emptyDocument]), [
    { type: "image", data: image.content, mimeType: image.mimeType },
    { type: "text", text: "\n\n[Document: notes.txt]\nDocument body" },
  ]);

  const stringMessage = {
    role: "user-with-attachments",
    content: "hello",
    timestamp: 10,
    attachments: [image],
  };
  const arrayContent = [{ type: "text" as const, text: "already blocked" }];
  const arrayMessage = {
    role: "user-with-attachments",
    content: arrayContent,
    timestamp: 11,
    attachments: [documentAttachment],
  };
  const [stringResult, arrayResult] = convert([stringMessage, arrayMessage]);

  assert.deepEqual(stringResult, {
    role: "user",
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: image.content, mimeType: image.mimeType },
    ],
    timestamp: 10,
  });
  assert.deepEqual(arrayResult, {
    role: "user",
    content: [
      { type: "text", text: "already blocked" },
      { type: "text", text: "\n\n[Document: notes.txt]\nDocument body" },
    ],
    timestamp: 11,
  });
  assert.notEqual((arrayResult as { content: unknown }).content, arrayContent);
});

test("conversion never mutates messages, content arrays, or attachments", () => {
  const messages = [
    {
      role: "user-with-attachments",
      content: [{ type: "text", text: "original" }],
      timestamp: 1,
      attachments: [image, documentAttachment, emptyDocument],
    },
  ];
  const before = structuredClone(messages);

  convert(messages);

  assert.deepEqual(messages, before);
});

test("ordinary turns do not import the UI barrel while attachment parsing remains on demand", () => {
  const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
  const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");

  assert.match(chat, /convertToLlm: convertMessagesToLlm/);
  assert.doesNotMatch(chat, /import\("@earendil-works\/pi-web-ui"\)/);
  assert.doesNotMatch(shell, /@earendil-works\/pi-web-ui|warmDeferredChunks/);
  assert.match(
    composer,
    /const \{ loadAttachment \} = await import\("@earendil-works\/pi-web-ui"\);\s*return await loadAttachment\(file\);/,
  );
});
