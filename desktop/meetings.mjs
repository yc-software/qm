import { app, Menu, Notification, systemPreferences } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startWhisper, watchMicrophone } from "./desk.mjs";
import { pillLevel, registerPill, showPill } from "./pill.mjs";
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

export function meetingApp(apps) {
  for (const { bundle_id: bundle } of apps) {
    const match = bundle && meetingApps.find(([prefix]) => bundle.startsWith(prefix));
    if (match) return match[1];
  }
}

let request;
let openNotes;
let publish;
let enabled = false;
let automatic = false;
let local = true;
let model;
let checks = 0;
let stopWatching;
let detectionProblem;
let meetingNow;
let meetingEnded;
let recording;
let notes;
const notices = new Set();

const settingsPath = () => path.join(app.getPath("userData"), "meetings.json");
const plural = (count) => (count === 1 ? "1 audio segment" : `${count} audio segments`);

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

function problems(current) {
  return [
    ...Object.entries(current.tracks).map(([speaker, problem]) => `${trackNames[speaker]}: ${problem}`),
    ...(current.othersQuiet ? ["Computer audio: nothing heard for 2 minutes"] : []),
    ...(current.uploadProblem ? [`Upload retrying: ${current.uploadProblem}`] : []),
    ...(current.local && model && !model.file
      ? [
          model.problem
            ? `Transcription model: ${model.problem}`
            : `Downloading transcription model: ${model.progress}%`,
        ]
      : []),
  ];
}

export const meetingState = () =>
  recording
    ? {
        recording: true,
        startedAt: recording.startedAt,
        stopping: Boolean(recording.stopping),
        ...(recording.path ? { path: recording.path } : {}),
      }
    : { recording: false };

function render() {
  for (const item of meetingMenu()) {
    const live = Menu.getApplicationMenu()?.getMenuItemById(item.id);
    if (live)
      Object.assign(live, {
        visible: item.visible,
        enabled: item.enabled,
        ...(item.type && { checked: item.checked }),
      });
  }
  publish?.(meetingState());
  showPill(
    recording && {
      startedAt: recording.startedAt,
      stopping: Boolean(recording.stopping),
      line: recording.line,
      problem: problems(recording)[0],
    },
  );
}

function prepareModel() {
  model ??= { progress: 0 };
  model.ready ??= (async () => {
    for (let delay = 5000; local; delay = Math.min(delay * 2, 300_000)) {
      try {
        model.file = await downloadModel((share) => {
          const progress = Math.floor(share * 100);
          if (progress === model.progress) return;
          model.progress = progress;
          render();
        });
        model.problem = undefined;
        render();
        return model.file;
      } catch (error) {
        model.problem = error.message;
        render();
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
    return JSON.parse(text).message ?? text;
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
    if (response?.ok) {
      if (current.uploadProblem) {
        current.uploadProblem = undefined;
        render();
      }
      return response;
    }
    if (response) {
      problem = `HTTP ${response.status}: ${await explain(response)}`;
      if (response.status < 500 && response.status !== 408 && response.status !== 429)
        throw Object.assign(new Error(problem), { segmentOnly: ![401, 403, 404].includes(response.status) });
    }
    current.uploadProblem = problem;
    render();
    await sleep(delay, undefined, { signal: current.quitting.signal }).catch(() => {
      throw new Error(problem);
    });
  }
}

function meeting(current) {
  current.created ??= call(current, (signal) =>
    request("/api/meetings", "POST", signal, "application/json", {
      id: current.id,
      startedAt: current.startedAt,
      ...(current.app ? { app: current.app } : {}),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  ).then(async (response) => {
    ({ path: current.path, prompt: current.prompt } = await response.json());
    notes = current.path;
    render();
  });
  return current.created;
}

function fail(current, error) {
  if (current.failure) return;
  current.failure = error.message;
  void stopRecording();
}

async function transcribeHere(current, pcm) {
  if (!pcm.length) throw Object.assign(new Error("The audio could not be decoded"), { segmentOnly: true });
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
    return await whisper.transcribe(pcm, current.prompt ?? "");
  } catch (error) {
    if (error.segmentOnly) throw error;
    whisper.discarded ??= discardCorruptModels().then((discarded) => {
      if (discarded) model = current.whisper = undefined;
      return discarded;
    });
    if (!(await whisper.discarded)) throw error;
    return transcribeHere(current, pcm);
  }
}

function upload(current, speaker, at, bytes) {
  current.lastSpeech = Date.now();
  if (speaker === "others") {
    current.othersHeard = true;
    if (current.othersQuiet) {
      current.othersQuiet = false;
      render();
    }
  }
  current.uploads[speaker] = current.uploads[speaker].then(async () => {
    if (current.failure) return;
    try {
      await meeting(current);
    } catch (error) {
      return fail(current, error);
    }
    try {
      const body = current.local ? { text: await transcribeHere(current, bytes) } : bytes;
      if (body.text === "") return;
      const response = await call(current, (signal) =>
        request(
          `/api/meetings/${current.id}/speech?${new URLSearchParams({ speaker, at: String(at) })}`,
          "POST",
          signal,
          current.local ? "application/json" : "audio/webm",
          body,
        ),
      );
      const heard = await response.json();
      current.prompt = heard.prompt;
      if (heard.text) {
        current.line = heard.text;
        render();
      }
    } catch (error) {
      if (!error.segmentOnly) return fail(current, error);
      current.dropped = { count: (current.dropped?.count ?? 0) + 1, problem: error.message };
    }
  });
}

function trackProblem(current, speaker, problem) {
  current.tracks[speaker] = problem;
  render();
  if (Object.keys(current.tracks).length === 2) fail(current, new Error(Object.values(current.tracks).join(" ")));
  else notify(`${trackNames[speaker]} is not being recorded`, problem);
}

function startRecording(detected) {
  if (recording || !enabled) return undefined;
  const current = {
    id: randomUUID(),
    startedAt: Date.now(),
    app: detected,
    detected: Boolean(detected),
    local,
    lastSpeech: Date.now(),
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
      render();
      if (current.detected)
        notify(
          `No sound from ${current.app}`,
          "QM has heard nothing from your computer for 2 minutes. If others are talking, allow QM in System Settings › Privacy & Security › Screen & System Audio Recording.",
        );
    }
  }, 1000);
  meeting(current).catch((error) => fail(current, error));
  render();
  void capture(current);
  return current;
}

async function capture(current) {
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted")
    await systemPreferences.askForMediaAccess("microphone");
  if (recording !== current || current.stopping) return;
  current.capturing = Date.now();
  current.stopCapture = startCapture({
    segment: (speaker, at, bytes) => upload(current, speaker, at, bytes),
    track: (speaker, problem) => trackProblem(current, speaker, problem),
    level: (speaker, level) => pillLevel(speaker, level),
    local: current.local,
  });
  if (current.detected && !meetingNow) endMeetingSoon();
}

export function stopRecording() {
  const current = recording;
  if (!current) return Promise.resolve();
  if (current.stopping) return current.stopping;
  clearTimeout(meetingEnded);
  clearInterval(current.ticker);
  current.stopping = finishRecording(current, Date.now());
  render();
  return current.stopping;
}

async function finishRecording(current, endedAt) {
  await current.stopCapture?.();
  await Promise.all(Object.values(current.uploads));
  current.whisper?.stop();
  if (!current.failure) {
    try {
      await current.created;
      await call(current, (signal) =>
        request(`/api/meetings/${current.id}/stop`, "POST", signal, "application/json", { endedAt }),
      );
    } catch (error) {
      current.failure = error.message;
    }
  }
  recording = undefined;
  render();
  const open = current.path && { label: "Open Notes", run: () => openNotes(current.path) };
  if (current.failure) notify("Meeting recording failed", current.failure, open);
  else
    notify(
      "Meeting recorded",
      [
        current.silent && "Stopped after 15 minutes without speech.",
        "QM is writing notes.",
        current.dropped && `${plural(current.dropped.count)} could not be used: ${current.dropped.problem}`,
      ]
        .filter(Boolean)
        .join(" "),
      open,
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
      const current = startRecording(name);
      notify(`Taking notes on your ${name} meeting`, "Stop it from the recording pill at the bottom of your screen.", {
        label: "Open Notes",
        run: () =>
          void current?.created.then(
            () => openNotes(current.path),
            () => {},
          ),
      });
    } else
      notify(`${name} meeting detected`, `${name} is using the microphone.`, {
        label: "Take Notes",
        run: () => {
          const current = startRecording(name);
          void current?.created.then(
            () => openNotes(current.path),
            () => {},
          );
        },
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
      label: "Stop Recording",
      visible: Boolean(recording),
      enabled: !recording?.stopping,
      click: () => void stopRecording(),
    },
    {
      id: "meeting-notes",
      label: "Open Meeting Notes",
      visible: enabled,
      enabled: Boolean(notes),
      click: () => openNotes(notes),
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

export async function startMeeting() {
  if (!enabled) await refreshMeetings();
  if (!enabled) throw new Error("Meeting recording is not enabled for this account.");
  if (recording) throw new Error("A meeting is already being recorded.");
  const current = startRecording();
  await current.created;
  return { path: current.path };
}

export function configureMeetings(options) {
  ({ request, openNotes, publish } = options);
  registerRecorder();
  registerPill({ open: () => recording?.path && openNotes(recording.path), stop: () => void stopRecording() });
}

export async function refreshMeetings() {
  if (recording) return;
  const check = ++checks;
  let next = false;
  try {
    const response = await request("/api/meetings", "GET", AbortSignal.timeout(15_000));
    next = response.ok && (await response.json()).enabled === true;
  } catch (error) {
    console.error("QM could not check meeting recording", error);
  }
  if (check !== checks || recording || next === enabled) return;
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
    stopWatching = detectionProblem = meetingNow = notes = undefined;
  }
  render();
}
