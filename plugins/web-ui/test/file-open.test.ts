import assert from "node:assert/strict";
import test from "node:test";
import { filePreviewKind, previewFile } from "../src/file-open.ts";

test("text previews recognize extensions and MIME types without intercepting binary files", () => {
  for (const name of ["notes.md", "notes.MARKDOWN"]) assert.equal(filePreviewKind(name), "markdown");
  assert.equal(filePreviewKind("data.JSON"), "text");
  assert.equal(filePreviewKind("download", "text/markdown; charset=utf-8"), "markdown");
  assert.equal(filePreviewKind("download", "Application/JSON"), "text");
  for (const name of ["data.json", "config.yaml", "config.toml", "notes.txt", "app.ts", "server.log"])
    assert.equal(filePreviewKind(name), "text");
  assert.equal(filePreviewKind("export.csv"), "csv");
  assert.equal(filePreviewKind("export.tsv"), "tsv");
  for (const name of ["report.pdf", "image.png", "archive.zip"]) assert.equal(filePreviewKind(name), null);
  assert.equal(filePreviewKind("data", "text/plain"), "text");
});

test("modified clicks and unsupported files retain the native link behavior", () => {
  const base = { button: 0, preventDefault: () => assert.fail("should remain a native link") };
  for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) {
    previewFile({ ...base, [modifier]: true } as unknown as MouseEvent, "notes.md", "/file");
  }
  previewFile({ ...base, button: 1 } as unknown as MouseEvent, "data.json", "/file");
  previewFile(base as unknown as MouseEvent, "report.pdf", "/file");
});
