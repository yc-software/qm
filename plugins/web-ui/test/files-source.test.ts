import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/files.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("Files keeps the clickable drop target without a separate upload button", () => {
  assert.doesNotMatch(source, /Files created, uploaded, or shared with you|scopeFilterControl/);
  assert.equal(source.match(/@click=\$\{pickFiles\}/g)?.length, 1);
  assert.match(source, /class="file-drop/);
  assert.match(source, /Drop files here or choose files/);
  assert.doesNotMatch(source, /class="btn primary"[\s\S]{0,200}@click=\$\{pickFiles\}/);
  assert.match(source, /"Ownership"/);
  assert.match(source, /"Type"/);
  assert.doesNotMatch(source, /"Sort",\s*filesSort/);
});

test("Files uses compact rows that open directly", () => {
  const start = source.indexOf("function fileRow(");
  const end = source.indexOf("\nfunction rowsFromPage", start);
  const row = source.slice(start, end);
  assert.match(row, /<div class="list-row file-row">/);
  assert.match(row, /<a class="file-row-main" href=\$\{contentUrl\} target="_blank"/);
  assert.match(row, /<span class="file-row-main">\$\{content\}<\/span>/);
  assert.doesNotMatch(row, /file-row-type|\$\{f\.mimetype\}|class="badge"|\$\{f\.kind\}|>Open</);
  assert.doesNotMatch(row, /scopeChip|fileScope\(f\)/);
  assert.match(row, /formatBytes\(f\.sizeBytes\)/);
  assert.match(row, /relTime\(f\.createdAt\)/);
  assert.match(
    css,
    /\.file-row \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) auto;[^}]*justify-content: initial;/,
  );
  assert.match(
    css,
    /\.file-row-main \{\s*display: grid;\s*grid-template-columns: 22px minmax\(0, 1fr\) auto;[^}]*color: inherit;\s*text-decoration: none;/,
  );
  assert.match(css, /\.file-row \.list-row-title \{\s*justify-self: stretch;\s*text-align: left;/);
  assert.match(css, /\.file-row \.list-row-meta \{\s*gap: 14px;/);
  assert.match(
    css,
    /\.file-list,\s*\.file-groups,\s*\.deploy-list,\s*\.files-page \.file-drop \{\s*width: min\(960px, 100%\);\s*margin-inline: auto;/,
  );
  assert.doesNotMatch(
    css,
    /\.files-page \.list-page-head,\s*\.files-page \.file-drop,\s*\.files-page \.list-toolbar,\s*\.files-page \.file-groups,\s*\.files-page \.file-list \{\s*margin-right: 0;\s*margin-left: 0;/,
  );
});

test("splitting the file row into an open anchor and an actions cell keeps the click target and the row height", () => {
  const start = source.indexOf("function fileRow(");
  const row = source.slice(start, source.indexOf("\nfunction rowsFromPage", start));
  assert.match(
    row,
    /class="btn danger compact"/,
    "a full-size button is taller than the row body and would stretch every deletable row past its neighbours",
  );
  assert.match(css, /\.file-row \{[^}]*padding: 0;/);
  assert.match(
    css,
    /\.file-row-main \{[^}]*padding: 12px;/,
    "the row's click ring belongs to the open anchor now; left on the outer div it stops opening the file",
  );
  assert.match(
    css,
    /\.file-row-actions \{[^}]*padding: 0 [\d.]+px 0 [\d.]+px;/,
    "vertical padding on the actions cell makes deletable rows taller than the rows beside them",
  );
  assert.match(
    css,
    /@media \(max-width: 700px\) \{\s*\.file-row-main \{\s*grid-template-columns: 22px minmax\(0, 1fr\);/,
  );
  assert.doesNotMatch(
    css,
    /\.file-row,\s*\.deploy-row \{\s*grid-template-columns: auto minmax\(0, 1fr\)/,
    "a narrow-width override of the outer row would collapse the column the Delete button sits in",
  );
});

test("Files groups rows by scope instead of repeating scope badges", () => {
  assert.match(source, /function groupFilesByScope\(files: FileRow\[\]\)/);
  assert.match(source, /groups\.map\(/);
  assert.match(source, /<h2>\$\{scopeTitle\(group\.scope\)\}<\/h2>/);
  assert.doesNotMatch(source, /scopeChip/);
  assert.match(css, /\.file-scope-group h2 \{/);
  assert.match(source, /else if \(filesScope\) \{\s*filesScope = null;/);
});

test("Files uses distinct Finder-inspired glyphs and type colors", () => {
  for (const glyph of [
    "FileImage",
    "FileText",
    "FileSpreadsheet",
    "Presentation",
    "FileJson",
    "FileArchive",
    "FileAudio",
    "FileVideo",
    "FileCode",
  ]) {
    assert.match(source, new RegExp(`\\b${glyph}\\b`));
  }
  for (const kind of ["image", "pdf", "spreadsheet", "presentation", "archive", "code", "audio", "video", "document"]) {
    assert.match(css, new RegExp(`\\.file-row-icon\\.${kind}`));
  }
});
