import assert from "node:assert/strict";
import { app, BrowserWindow, Menu } from "electron";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "qm-meetings-"));
const wav = path.join(directory, "talk.wav");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-file-for-fake-audio-capture", wav);
(async () => {
  const rate = 16_000;
  const samples = Int16Array.from({ length: rate * 5 }, (_, i) =>
    i < rate * 3 ? Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / rate)) : 0,
  );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  await writeFile(wav, Buffer.concat([header, Buffer.from(samples.buffer)]));
  await writeFile(path.join(directory, "meetings.json"), JSON.stringify({ automatic: true, local: false }));
  await writeFile(path.join(directory, "ggml-large-v3-turbo-q5_0.bin"), "model");
  await writeFile(path.join(directory, "ggml-silero-v5.1.2.bin"), "vad");
  const desk = path.join(directory, "desk.mjs");
  await writeFile(
    desk,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
if (process.argv[2] === "whisper")
  createInterface({ input: process.stdin }).on("line", (line) => {
    const { pcm, prompt } = JSON.parse(line);
    console.log(JSON.stringify({ text: \`heard \${Buffer.from(pcm, "base64").length / 4} samples after \${prompt}\` }));
  });
else {
const line = (apps) => console.log(JSON.stringify({ type: "microphone", apps }));
line([]);
setTimeout(() => line([{ bundle_id: "us.zoom.xos", pid: 42 }]), 1000);
setTimeout(() => line([{ bundle_id: "com.qm.desktop.helper", pid: 43 }]), 30000);
setInterval(() => {}, 1000);
}
`,
  );
  await chmod(desk, 0o700);
  app.setPath("userData", directory);
  app.setPath("sessionData", directory);
  process.env.QM_DESK_BIN = desk;

  const log = [];
  const summarized = [];
  let summary = Promise.withResolvers();
  let failedOnce = false;
  let speechCount = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://stub");
    const reply = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("content-type", "text/html");
      return res.end(`<title>${url.pathname}</title>`);
    }
    const entry = { path: url.pathname, client: req.headers["x-qm-client"], origin: req.headers.origin };
    log.push(entry);
    if (req.method === "GET") return reply(200, { enabled: true, user: "alice" });
    if (url.pathname === "/api/dictation") {
      Object.assign(entry, { type: req.headers["content-type"], ebml: body.subarray(0, 4).toString("hex") });
      if (!failedOnce) {
        failedOnce = true;
        return reply(503, { error: "busy" });
      }
      if (++speechCount === 4) return reply(422, { error: "unreadable", message: "The audio could not be read." });
      return reply(200, { text: "hello" });
    }
    if (url.pathname === "/api/blobs") {
      entry.markdown = body.toString();
      return reply(200, { blobId: `blob-${summarized.length}`, sizeBytes: body.length });
    }
    if (url.pathname === "/api/sessions") return reply(201, { session: { id: "s1", threadRef: "web:alice:t1" } });
    Object.assign(entry, JSON.parse(body));
    summarized.push(entry);
    summary.resolve(entry);
    return reply(202, { status: "queued" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.QM_DESKTOP_URL = origin;
  const started = Date.now();
  await app.whenReady();
  try {
    await import("../main.mjs");
    const turn = await summary.promise;
    const ended = Date.now() - started;
    assert.ok(
      ended > 45_000 && ended < 70_000,
      `detected recording stopped ~20 s after the meeting ended (${ended} ms)`,
    );
    const speech = log.filter((entry) => entry.path === "/api/dictation");
    assert.ok(speech.every((entry) => entry.type === "audio/webm" && entry.ebml === "1a45dfa3"));
    assert.ok(speech.length >= 4, `segments uploaded: ${speech.length}`);
    assert.ok(log.every((entry) => entry.client === "desktop" && entry.origin === origin));
    const markdown = log.find((entry) => entry.path === "/api/blobs").markdown;
    assert.ok(markdown.startsWith("# Zoom meeting"), markdown);
    assert.ok(markdown.includes(" Me:** hello") && markdown.includes(" Them:** hello"), markdown);
    assert.equal(turn.threadRef, "web:alice:t1");
    assert.equal(turn.scopeId, "personal:alice");
    assert.ok(turn.text.startsWith("Summarize this meeting transcript"));
    assert.deepEqual(turn.attachments[0].blobId, "blob-0");
    assert.ok(turn.attachments[0].name.endsWith(".md"));
    const opened = () =>
      BrowserWindow.getAllWindows().some((window) => window.webContents.getURL() === `${origin}/s/s1`);
    for (let waited = 0; !opened() && waited < 5000; waited += 100)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(opened(), "the summary conversation opened");
    const menuItem = (label) =>
      Menu.getApplicationMenu()
        .items.flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.label === label);
    menuItem("Transcribe on This Mac").click();
    summary = Promise.withResolvers();
    menuItem("Start Recording").click();
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    app.on("will-quit", () => {
      server.close();
      rmSync(directory, { recursive: true, force: true });
      const local = log.findLast((entry) => entry.path === "/api/blobs")?.markdown ?? "";
      if (summarized.length !== 2 || !local.includes("heard ") || !local.startsWith("# Meeting")) {
        console.error("Quitting did not flush and summarize the recording", JSON.stringify(log, null, 1));
        return app.exit(1);
      }
      console.log(
        `PASS: detected Zoom, uploaded ${speech.length} segments, retried a 503, skipped an unusable segment, stopped after the meeting ended, uploaded the Markdown transcript and opened a conversation asking QM to summarize it; a recording started from the menu transcribed on this Mac and was summarized on quit`,
      );
    });
    app.quit();
  } catch (error) {
    console.error(error, JSON.stringify(log, null, 1));
    app.exit(1);
  }
})();
