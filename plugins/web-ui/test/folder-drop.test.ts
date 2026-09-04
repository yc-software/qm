import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  FolderDropError,
  folderToZipFile,
  isFolderReadError,
  splitDropItems,
  type DropEntryLike,
  type DropItemLike,
} from "../src/folder-drop.ts";

function fileEntry(name: string, contents = `contents of ${name}`): DropEntryLike {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (onOk) => onOk(new File([contents], name)),
  };
}

function dirEntry(name: string, children: DropEntryLike[], batchSize = 100): DropEntryLike {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let cursor = 0;
      return {
        readEntries: (onOk) => {
          const batch = children.slice(cursor, cursor + batchSize);
          cursor += batch.length;
          onOk(batch);
        },
      };
    },
  };
}

function dropItem(overrides: Partial<DropItemLike>): DropItemLike {
  return { kind: "file", getAsFile: () => null, ...overrides };
}

async function zipPaths(zip: File): Promise<string[]> {
  const loaded = await JSZip.loadAsync(await zip.arrayBuffer());
  return Object.keys(loaded.files)
    .filter((k) => !loaded.files[k].dir)
    .sort();
}

test("splitDropItems separates folder entries from plain files", () => {
  const folder = dirEntry("proj", []);
  const file = new File(["x"], "a.txt");
  const { files, folders } = splitDropItems([
    dropItem({ webkitGetAsEntry: () => folder }),
    dropItem({ getAsFile: () => file, webkitGetAsEntry: () => fileEntry("a.txt") }),
    dropItem({ kind: "string" }),
  ]);
  assert.deepEqual(folders, [folder]);
  assert.deepEqual(files, [file]);
});

test("splitDropItems keeps a file even when webkitGetAsEntry is missing or null", () => {
  const file = new File(["x"], "a.txt");
  const { files, folders } = splitDropItems([
    dropItem({ getAsFile: () => file }),
    dropItem({ getAsFile: () => file, webkitGetAsEntry: () => null }),
  ]);
  assert.equal(files.length, 2);
  assert.equal(folders.length, 0);
});

test("folderToZipFile packs a nested tree into one zip, paths preserved", async () => {
  const root = dirEntry("proj", [
    fileEntry("a.txt", "aaa"),
    dirEntry("sub", [fileEntry("b.md", "bbb"), dirEntry("deep", [fileEntry("c.json", "{}")])]),
  ]);
  const zip = await folderToZipFile(root);
  assert.equal(zip.name, "proj.zip");
  assert.equal(zip.type, "application/zip");
  assert.deepEqual(await zipPaths(zip), ["a.txt", "sub/b.md", "sub/deep/c.json"]);
  const loaded = await JSZip.loadAsync(await zip.arrayBuffer());
  assert.equal(await loaded.file("sub/b.md")!.async("string"), "bbb");
});

test("folderToZipFile drains a paginating reader (Chrome returns ~100 entries per call)", async () => {
  const children = Array.from({ length: 7 }, (_, i) => fileEntry(`f${i}.txt`));
  const zip = await folderToZipFile(dirEntry("proj", children, 2));
  assert.equal((await zipPaths(zip)).length, 7);
});

test("folderToZipFile skips OS junk files", async () => {
  const root = dirEntry("proj", [fileEntry(".DS_Store"), fileEntry("Thumbs.db"), fileEntry("real.txt")]);
  assert.deepEqual(await zipPaths(await folderToZipFile(root)), ["real.txt"]);
});

test("file-count cap throws a composer-ready FolderDropError", async () => {
  const root = dirEntry("proj", [fileEntry("a.txt"), fileEntry("b.txt"), fileEntry("c.txt")]);
  await assert.rejects(folderToZipFile(root, { maxFiles: 2, maxBytes: Infinity }), (err: unknown) => {
    assert.ok(err instanceof FolderDropError);
    assert.match(err.message, /proj.*too many files/);
    return true;
  });
});

test("byte cap throws a composer-ready FolderDropError", async () => {
  const root = dirEntry("proj", [fileEntry("a.txt", "x".repeat(100))]);
  await assert.rejects(folderToZipFile(root, { maxFiles: Infinity, maxBytes: 50 }), (err: unknown) => {
    assert.ok(err instanceof FolderDropError);
    assert.match(err.message, /proj.*too big/);
    return true;
  });
});

test("an empty folder is rejected with a plain message", async () => {
  await assert.rejects(folderToZipFile(dirEntry("empty", [dirEntry("nested", [])])), FolderDropError);
});

test("isFolderReadError recognizes the NotFoundError a directory-as-File read produces", () => {
  assert.ok(isFolderReadError(new DOMException("A requested file or directory could not be found", "NotFoundError")));
  assert.ok(!isFolderReadError(new DOMException("nope", "AbortError")));
  assert.ok(!isFolderReadError(new Error("NotFoundError")));
});
