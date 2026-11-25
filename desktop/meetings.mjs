import { app, Menu, Notification, systemPreferences } from "electron";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startWhisper, watchMicrophone } from "./desk.mjs";
import { registerRecorder, startCapture } from "./recorder.mjs";
import { discardCorruptModels, downloadModel } from "./transcription.mjs";

const meetingApps = [
  ["us.zoom.", "Zoom"],
  ["com.microsoft.teams", "Microsoft Teams"],
  ["com.tinyspeck.slackmacgap", "Slack"],
  ["com.apple.FaceTime", "FaceTime"],
  ["com.apple.avconferenced", "FaceTime"],
  ["com.cisco.webex", "Webex"],
  ["Cisco-Systems.Spark", "Webex"],
  ["com.hnc.Discord", "Discord"],
  ["net.whatsapp.WhatsApp", "WhatsApp"],
  ["desktop.WhatsApp", "WhatsApp"],
  ["com.google.Chrome", "Google Chrome"],
  ["com.microsoft.edgemac", "Microsoft Edge"],
  ["com.brave.Browser", "Brave"],
  ["company.thebrowser.Browser", "Arc"],
  ["company.thebrowser.dia", "Dia"],
  ["com.operasoftware.Opera", "Opera"],
  ["com.vivaldi.Vivaldi", "Vivaldi"],
  ["org.mozilla.firefox", "Firefox"],
  ["com.apple.Safari", "Safari"],
  ["com.apple.WebKit.GPU", "Safari"],
];
const trackNames = { me: "Microphone", others: "Computer audio" };
const meetingEndGrace = 20_000;
const silenceLimit = 15 * 60_000;
const othersQuietWarning = 2 * 60_000;
const quitFlushWait = 10_000;
const promptLines = 12;

export function meetingApp(apps) {
  for (const { bundle_id: bundle } of apps) {
    const match = bundle && meetingApps.find(([prefix]) => bundle.startsWith(prefix));
    if (match) return match[1];
  }
}

let request;
let openSession;
let enabled = false;
let user;
let automatic = false;
let local = true;
let model;
let checks = 0;
let stopWatching;
let detectionProblem;
let meetingNow;
let meetingEnded;
let recording;
const notices = new Set();

const settingsPath = () => path.join(app.getPath("userData"), "meetings.json");
const plural = (count) => (count === 1 ? "1 audio segment" : `${count} audio segments`);
const clock = (at) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const day = (at) =>
  new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function notify(title, body, action) {
  const notification = new Notification({
    title,
    body,
    ...(action ? { actions: [{ type: "button", text: action.label }] } : {}),
  });
  if (action) {
    notification.on("click", action.run);
    notification.on("action", action.run);
  }
  notices.add(notification);
  notification.on("close", () => notices.delete(notification));
  notification.show();
}

function render() {
  for (const item of meetingMenu()) {
    const live = Menu.getApplicationMenu()?.getMenuItemById(item.id);
    if (live)
      Object.assign(live, {
        visible: item.visible,
        enabled: item.enabled,
        ...(item.label && { label: item.label }),
        ...(item.type && { checked: item.checked }),
      });
  }
}

function prepareModel() {
  model ??= { progress: 0 };
  model.ready ??= (async () => {
    for (let delay = 5000; local; delay = Math.min(delay * 2, 300_000)) {
      try {
        model.file = await downloadModel((share) => {
          model.progress = Math.floor(share * 100);
        });
        model.problem = undefined;
        return model.file;
      } catch (error) {
        if (model.problem !== error.message) notify("Transcription model not downloaded", error.message);
        model.problem = error.message;
      }
      await sleep(delay);
    }
    model = undefined;
  })();
  return model.ready;
}

async function saveSettings(change) {
  ({ automatic, local } = { automatic, local, ...change });
  if (local) void prepareModel();
  try {
    await writeFile(`${settingsPath()}.tmp`, JSON.stringify({ automatic, local }));
    await rename(`${settingsPath()}.tmp`, settingsPath());
  } catch (error) {
    notify("Meeting setting not saved", error.message);
  }
  render();
}

async function readSettings() {
  try {
    const saved = JSON.parse(await readFile(settingsPath(), "utf8"));
    return { automatic: saved.automatic === true, local: saved.local !== false };
  } catch (error) {
    if (error.code !== "ENOENT") console.error("QM could not read meeting settings", error);
    return { automatic: false, local: true };
  }
}

async function explain(response) {
  const text = await response.text().catch((error) => error.message);
  try {
    return JSON.parse(text).message ?? JSON.parse(text).error ?? text;
  } catch {
    return text;
  }
}

async function call(current, run) {
  for (let delay = 1000; ; delay = Math.min(delay * 2, 60_000)) {
    let response;
    let problem;
    try {
      response = await run(current.controller.signal);
    } catch (error) {
      problem = error.message;
    }
    if (response?.ok) return response;
    if (response) {
      problem = `HTTP ${response.status}: ${await explain(response)}`;
      if (response.status < 500 && response.status !== 408 && response.status !== 429)
        throw Object.assign(new Error(problem), {
          status: response.status,
          segmentOnly: ![401, 403, 404].includes(response.status),
        });
    }
    if (current.uploadProblem !== problem) console.error("QM meeting upload retrying", problem);
    current.uploadProblem = problem;
    await sleep(delay, undefined, { signal: current.quitting.signal }).catch(() => {
      throw new Error(problem);
    });
  }
}

function fail(current, error) {
  if (current.failure) return;
  current.failure = error.message;
  void stopRecording();
}

async function transcribeHere(current, pcm, prompt) {
  if (typeof pcm === "string")
    throw Object.assign(new Error(`The audio could not be decoded (${pcm})`), { segmentOnly: true });
  const { signal } = current.controller;
  const file = await Promise.race([
    prepareModel(),
    new Promise((_, reject) => {
      const quit = () => reject(new Error("QM quit before the transcription model was ready"));
      if (signal.aborted) quit();
      signal.addEventListener("abort", quit, { once: true });
    }),
  ]);
  const whisper = (current.whisper ??= startWhisper(file));
  try {
    return await whisper.transcribe(pcm, prompt);
  } catch (error) {
    if (error.segmentOnly) throw error;
    whisper.discarded ??= discardCorruptModels().then((discarded) => {
      if (discarded) model = current.whisper = undefined;
      return discarded;
    });
    if (!(await whisper.discarded)) throw error;
    return transcribeHere(current, pcm, prompt);
  }
}

async function transcribeOnline(current, bytes) {
  try {
    const response = await call(current, (signal) => request("/api/dictation", "POST", signal, "audio/webm", bytes));
    return (await response.json()).text ?? "";
  } catch (error) {
    if (error.status === 400 && error.message.includes("empty_audio")) return "";
    throw error;
  }
}

function upload(current, speaker, at, bytes) {
  current.lastSpeech = Date.now();
  if (speaker === "others") current.othersHeard = true;
  current.uploads[speaker] = current.uploads[speaker].then(async () => {
    if (current.failure) return;
    try {
      const prompt = current.lines
        .slice(-promptLines)
        .map((line) => line.text)
        .join("\n");
      const text = (
        current.local ? await transcribeHere(current, bytes, prompt) : await transcribeOnline(current, bytes)
      ).trim();
      if (!text) return;
      const line = { at, speaker, text };
      current.lines.push(line);
      await appendFile(current.file, transcriptLine(line));
    } catch (error) {
      if (!error.segmentOnly) return fail(current, error);
      current.dropped = { count: (current.dropped?.count ?? 0) + 1, problem: error.message };
    }
  });
}

const transcriptLine = (line) => `**${clock(line.at)} ${line.speaker === "me" ? "Me" : "Them"}:** ${line.text}\n\n`;

function transcript(current) {
  return [
    `# ${current.app ? `${current.app} meeting` : "Meeting"} · ${day(current.startedAt)}\n\n`,
    ...[...current.lines].sort((a, b) => a.at - b.at).map(transcriptLine),
  ].join("");
}

function trackProblem(current, speaker, problem) {
  current.tracks[speaker] = problem;
  if (Object.keys(current.tracks).length === 2) fail(current, new Error(Object.values(current.tracks).join(" ")));
  else notify(`${trackNames[speaker]} is not being recorded`, problem);
}

function startRecording(detected) {
  if (recording || !enabled) return undefined;
  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
  const current = {
    startedAt,
    name: `Meeting ${stamp}.md`,
    file: path.join(app.getPath("userData"), "meetings", `Meeting ${stamp}.md`),
    app: detected,
    detected: Boolean(detected),
    local,
    lines: [],
    lastSpeech: startedAt,
    tracks: {},
    uploads: { me: Promise.resolve(), others: Promise.resolve() },
    controller: new AbortController(),
    quitting: new AbortController(),
  };
  recording = current;
  current.ticker = setInterval(() => {
    if (Date.now() - current.lastSpeech > silenceLimit) {
      current.silent = true;
      void stopRecording();
    }
    if (
      current.capturing &&
      !current.othersHeard &&
      !current.othersQuiet &&
      !current.tracks.others &&
      Date.now() - current.capturing > othersQuietWarning
    ) {
      current.othersQuiet = true;
      notify(
        "No sound from your computer",
        "QM has heard nothing from your computer for 2 minutes. If others are talking, allow QM in System Settings › Privacy & Security › Screen & System Audio Recording.",
      );
    }
  }, 1000);
  render();
  void capture(current).catch((error) => fail(current, error));
  return current;
}

async function capture(current) {
  await mkdir(path.dirname(current.file), { recursive: true });
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted")
    await systemPreferences.askForMediaAccess("microphone");
  if (recording !== current || current.stopping) return;
  current.capturing = Date.now();
  current.stopCapture = startCapture({
    segment: (speaker, at, bytes) => upload(current, speaker, at, bytes),
    track: (speaker, problem) => trackProblem(current, speaker, problem),
    level: () => {},
    local: current.local,
  });
  if (current.detected && !meetingNow) endMeetingSoon();
}

function stopRecording() {
  const current = recording;
  if (!current) return Promise.resolve();
  if (current.stopping) return current.stopping;
  clearTimeout(meetingEnded);
  clearInterval(current.ticker);
  current.stopping = finishRecording(current, Date.now());
  render();
  return current.stopping;
}

async function summarize(current, endedAt) {
  const bytes = Buffer.from(transcript(current));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const json = async (pathname, body, type = "application/json") =>
    (await call(current, (signal) => request(pathname, "POST", signal, type, body))).json();
  const blob = await json(`/api/blobs?sha=${sha}`, bytes, "application/octet-stream");
  const scopeId = `personal:${user}`;
  const { session } = await json("/api/sessions", { principalId: user, scopeId });
  await json("/api/turn", {
    threadRef: session.threadRef,
    scopeId,
    text: `Summarize this meeting transcript (${day(current.startedAt)} to ${clock(endedAt)}): a short summary, decisions, and action items with owners.`,
    attachments: [{ name: current.name, mimetype: "text/markdown", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return `/s/${encodeURIComponent(session.id)}`;
}

async function finishRecording(current, endedAt) {
  await current.stopCapture?.();
  await Promise.all(Object.values(current.uploads));
  current.whisper?.stop();
  let opened;
  if (current.lines.length) {
    try {
      opened = await summarize(current, endedAt);
      openSession(opened);
    } catch (error) {
      current.failure ??= error.message;
    }
  }
  recording = undefined;
  render();
  const kept = `The transcript is kept at ${current.file}.`;
  const dropped = current.dropped && `${plural(current.dropped.count)} could not be used: ${current.dropped.problem}`;
  if (current.failure && current.lines.length)
    notify("Meeting not summarized", [current.failure, kept, dropped].filter(Boolean).join(" "));
  else if (current.failure) notify("Meeting recording failed", current.failure);
  else if (!opened) notify("Nothing was transcribed", [dropped].filter(Boolean).join(" ") || "QM heard no speech.");
  else
    notify(
      "Meeting recorded",
      [current.silent && "Stopped after 15 minutes without speech.", "QM is summarizing it.", dropped]
        .filter(Boolean)
        .join(" "),
      { label: "Open", run: () => openSession(opened) },
    );
}

export async function quitRecording() {
  const current = recording;
  if (!current) return;
  current.quitting.abort();
  const deadline = setTimeout(() => current.controller.abort(), quitFlushWait);
  await stopRecording();
  clearTimeout(deadline);
}

export const isRecording = () => Boolean(recording);

function endMeetingSoon() {
  clearTimeout(meetingEnded);
  meetingEnded = setTimeout(() => {
    if (recording?.detected) void stopRecording();
  }, meetingEndGrace);
}

function microphoneChanged(apps) {
  const name = meetingApp(apps);
  const began = name && !meetingNow;
  if (name) clearTimeout(meetingEnded);
  else if (meetingNow && recording?.detected) endMeetingSoon();
  meetingNow = name;
  if (began && !recording) {
    if (automatic) {
      startRecording(name);
      notify(`Recording your ${name} meeting`, "Stop it from the QM menu.");
    } else
      notify(`${name} meeting detected`, `${name} is using the microphone.`, {
        label: "Record",
        run: () => startRecording(name),
      });
  }
}

export function meetingMenu() {
  return [
    {
      id: "meeting-start",
      label: "Start Recording",
      visible: enabled && !recording,
      enabled: true,
      click: () => void startRecording(),
    },
    {
      id: "meeting-stop",
      label: recording?.stopping ? "Saving Recording…" : "Stop Recording",
      visible: Boolean(recording),
      enabled: !recording?.stopping,
      click: () => void stopRecording(),
    },
    {
      id: "meeting-local",
      label: "Transcribe on This Mac",
      type: "radio",
      checked: local,
      visible: enabled,
      enabled: !recording,
      click: () => void saveSettings({ local: true }),
    },
    {
      id: "meeting-openai",
      label: "Transcribe with OpenAI",
      type: "radio",
      checked: !local,
      visible: enabled,
      enabled: !recording,
      click: () => void saveSettings({ local: false }),
    },
    {
      id: "meeting-automatic",
      label: "Record Meetings Automatically",
      type: "checkbox",
      checked: automatic,
      visible: enabled,
      enabled: true,
      click: (item) => void saveSettings({ automatic: item.checked }),
    },
  ];
}

export function configureMeetings(options) {
  ({ request, openSession } = options);
  registerRecorder();
}

export async function refreshMeetings() {
  if (recording) return;
  const check = ++checks;
  let next = false;
  let who;
  try {
    const response = await request("/api/meetings", "GET", AbortSignal.timeout(15_000));
    const body = response.ok ? await response.json() : {};
    next = body.enabled === true;
    who = body.user ?? undefined;
  } catch (error) {
    console.error("QM could not check meeting recording", error);
  }
  if (check !== checks || recording) return;
  user = who;
  if (next === enabled) return;
  enabled = next;
  if (enabled) {
    ({ automatic, local } = await readSettings());
    if (local) void prepareModel();
    stopWatching = watchMicrophone(microphoneChanged, (problem) => {
      if (!detectionProblem) notify("Meeting detection unavailable", problem);
      detectionProblem = problem;
    });
  } else {
    stopWatching?.();
    stopWatching = detectionProblem = meetingNow = undefined;
  }
  render();
}
