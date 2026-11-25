import { app, Menu, Notification, systemPreferences } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startWhisper, watchMicrophone } from "./desk.mjs";
import { registerRecorder, startCapture } from "./recorder.mjs";
import { downloadModel } from "./transcription.mjs";

const meetingApps = [
  ["us.zoom.", "Zoom"],
  ["com.microsoft.teams", "Microsoft Teams"],
  ["com.apple.FaceTime", "FaceTime"],
  ["com.apple.avconferenced", "FaceTime"],
  ["com.cisco.webex", "Webex"],
  ["Cisco-Systems.Spark", "Webex"],
  ["com.tinyspeck.slackmacgap", "Slack"],
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
];
const callApps = new Set(["Zoom", "Microsoft Teams", "FaceTime", "Webex"]);
const trackNames = { me: "Microphone", others: "Computer audio" };
const meetingEndGrace = 20_000;
const promptLines = 12;
const transient = new Set([408, 429, 500, 503, 504]);
const unusableSegment = new Set(["empty_audio", "invalid_audio", "unsupported_audio", "dictation_rejected"]);

export function meetingApp(apps) {
  const bundles = apps.flatMap(({ bundle_id: bundle }) => (bundle ? [bundle] : []));
  return meetingApps.find(([prefix]) => bundles.some((bundle) => bundle.startsWith(prefix)))?.[1];
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
        ...("checked" in item && { checked: item.checked }),
      });
  }
}

function prepareModel() {
  model ??= {};
  model.ready ??= (async () => {
    for (let delay = 5000; local; delay = Math.min(delay * 2, 300_000)) {
      try {
        model.file = await downloadModel();
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

async function call(current, pathname, run) {
  for (let delay = 1000; ; delay = Math.min(delay * 2, 60_000)) {
    let response;
    let problem;
    try {
      response = await run();
    } catch (error) {
      problem = error.message;
    }
    if (response?.ok) return response;
    if (response) {
      const text = await response.text().catch((error) => `unreadable body: ${error.message}`);
      let code;
      try {
        ({ error: code } = JSON.parse(text));
      } catch {
        code = undefined;
      }
      problem = `${pathname} answered HTTP ${response.status}: ${text}`;
      if (!transient.has(response.status)) throw Object.assign(new Error(problem), { code });
    }
    if (current.uploadProblem !== problem) console.error("QM meeting upload retrying", problem);
    current.uploadProblem = problem;
    await sleep(delay, undefined, { signal: current.quitting.signal }).catch(() => {
      throw new Error(problem);
    });
  }
}

function fail(current, error) {
  console.error("QM meeting recording failed", error);
  current.failures.push(error.message);
  void stopRecording();
}

async function transcribeHere(current, pcm, prompt) {
  if (typeof pcm === "string")
    throw Object.assign(new Error(`The audio could not be decoded (${pcm})`), { segmentOnly: true });
  const { signal } = current.quitting;
  const file = await Promise.race([
    prepareModel(),
    new Promise((_, reject) => {
      const quit = () => reject(new Error("QM quit before the transcription model was ready"));
      if (signal.aborted) quit();
      signal.addEventListener("abort", quit, { once: true });
    }),
  ]);
  current.whisper ??= startWhisper(file);
  return current.whisper.transcribe(pcm, prompt);
}

async function transcribeOnline(current, bytes) {
  try {
    const response = await call(current, "/api/dictation", () =>
      request("/api/dictation", "POST", undefined, "audio/webm", bytes),
    );
    return (await response.json()).text ?? "";
  } catch (error) {
    if (error.code === "empty_audio") return "";
    if (unusableSegment.has(error.code)) error.segmentOnly = true;
    throw error;
  }
}

function upload(current, speaker, at, bytes) {
  current.uploads[speaker] = current.uploads[speaker].then(async () => {
    if (current.failures.length) return;
    try {
      const prompt = current.lines
        .slice(-promptLines)
        .map((line) => line.text)
        .join("\n");
      const text = (
        current.local ? await transcribeHere(current, bytes, prompt) : await transcribeOnline(current, bytes)
      ).trim();
      if (!text) return;
      current.lines.push({ at, speaker, text });
      await writeFile(current.file, transcript(current));
    } catch (error) {
      if (!error.segmentOnly) return fail(current, error);
      console.error("QM skipped a meeting segment", error);
      current.dropped.push(error.message);
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
    dropped: [],
    failures: [],
    tracks: {},
    uploads: { me: Promise.resolve(), others: Promise.resolve() },
    quitting: new AbortController(),
  };
  recording = current;
  render();
  void capture(current).catch((error) => fail(current, error));
  return current;
}

async function capture(current) {
  await mkdir(path.dirname(current.file), { recursive: true });
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted")
    await systemPreferences.askForMediaAccess("microphone");
  if (recording !== current || current.stopping) return;
  current.stopCapture = startCapture({
    segment: (speaker, at, bytes) => upload(current, speaker, at, bytes),
    track: (speaker, problem) => trackProblem(current, speaker, problem),
    local: current.local,
  });
  if (current.detected && !meetingNow) endMeetingSoon();
}

function stopRecording() {
  const current = recording;
  if (!current) return Promise.resolve();
  if (current.stopping) return current.stopping;
  clearTimeout(meetingEnded);
  current.stopping = finishRecording(current, Date.now());
  render();
  return current.stopping;
}

async function summarize(current, endedAt) {
  const bytes = Buffer.from(transcript(current));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const json = async (pathname, body, type = "application/json") =>
    (await call(current, pathname, () => request(pathname, "POST", undefined, type, body))).json();
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
      console.error("QM could not start the meeting summary", error);
      current.failures.push(error.message);
    }
  }
  recording = undefined;
  render();
  const kept = `The transcript is kept at ${current.file}.`;
  const dropped =
    current.dropped.length > 0 &&
    `${plural(current.dropped.length)} could not be used: ${[...new Set(current.dropped)].join(" ")}`;
  const failure = current.failures.join(" ");
  if (failure && current.lines.length)
    notify("Meeting not summarized", [failure, kept, dropped].filter(Boolean).join(" "));
  else if (failure) notify("Meeting recording failed", failure);
  else if (!opened) notify("Nothing was transcribed", [dropped].filter(Boolean).join(" ") || "QM heard no speech.");
  else
    notify("Meeting recorded", ["QM is summarizing it.", dropped].filter(Boolean).join(" "), {
      label: "Open",
      run: () => openSession(opened),
    });
}

export async function quitRecording() {
  const current = recording;
  if (!current) return;
  current.quitting.abort();
  await stopRecording();
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
  const began = name && name !== meetingNow;
  if (name) clearTimeout(meetingEnded);
  else if (meetingNow && recording?.detected) endMeetingSoon();
  meetingNow = name;
  if (began && !recording) {
    if (automatic && callApps.has(name)) {
      startRecording(name);
      notify(`Recording your ${name} meeting`, "Stop it from File › Stop Recording.");
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
    { id: "meeting-settings", type: "separator", visible: enabled },
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
  let next;
  let who;
  try {
    const response = await request("/api/meetings", "GET");
    if (!response.ok) throw new Error(`/api/meetings answered HTTP ${response.status}: ${await response.text()}`);
    ({ enabled: next, user: who } = await response.json());
  } catch (error) {
    console.error("QM could not check meeting recording", error);
    return;
  }
  if (check !== checks || recording) return;
  user = who;
  next = next === true;
  if (next === enabled) return;
  enabled = next;
  if (enabled) {
    ({ automatic, local } = await readSettings());
    if (local) void prepareModel();
    stopWatching = watchMicrophone(microphoneChanged, (problem) => {
      console.error("QM meeting detection problem", problem);
      if (!detectionProblem) notify("Meeting detection unavailable", problem);
      detectionProblem = problem;
    });
  } else {
    stopWatching?.();
    stopWatching = detectionProblem = meetingNow = undefined;
  }
  render();
}
