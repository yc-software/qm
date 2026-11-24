import { app, Menu, nativeImage, Notification, systemPreferences, Tray } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { watchMicrophone } from "./desk.mjs";
import { registerRecorder, startCapture } from "./recorder.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
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
const quitFlushWait = 10_000;

export function meetingApp(apps) {
  for (const { bundle_id: bundle } of apps) {
    const match = bundle && meetingApps.find(([prefix]) => bundle.startsWith(prefix));
    if (match) return match[1];
  }
}

let request;
let openNotes;
let enabled = false;
let automatic = false;
let checks = 0;
let tray;
let stopWatching;
let detectionProblem;
let meetingNow;
let meetingEnded;
let recording;
let notes;
const notices = new Set();

const settingsPath = () => path.join(app.getPath("userData"), "meetings.json");
const elapsed = (since) => {
  const seconds = Math.floor((Date.now() - since) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

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

function showTime() {
  tray?.setTitle(recording ? `● ${elapsed(recording.startedAt)}` : "");
  tray?.setToolTip(recording ? `QM is recording (${elapsed(recording.startedAt)})` : "QM");
}

function render() {
  for (const item of meetingMenu()) {
    const live = Menu.getApplicationMenu()?.getMenuItemById(item.id);
    if (live) Object.assign(live, { visible: item.visible, enabled: item.enabled });
  }
  showTime();
  if (!tray) return;
  let status = "Not recording";
  if (recording?.stopping) status = "Saving the meeting…";
  else if (recording)
    status = `Recording since ${new Date(recording.startedAt).toLocaleTimeString([], { timeStyle: "short" })}`;
  const problems = [
    ...Object.entries(recording?.tracks ?? {}).map(([speaker, problem]) => `${trackNames[speaker]}: ${problem}`),
    ...(recording?.uploadProblem ? [`Upload retrying: ${recording.uploadProblem}`] : []),
    ...(detectionProblem ? [`Meeting detection unavailable: ${detectionProblem}`] : []),
  ];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      ...problems.map((label) => ({ label, enabled: false })),
      { type: "separator" },
      ...meetingMenu(),
      { type: "separator" },
      {
        label: "Record Meetings Automatically",
        type: "checkbox",
        checked: automatic,
        click: (item) => void saveAutomatic(item.checked),
      },
    ]),
  );
}

async function saveAutomatic(value) {
  automatic = value;
  try {
    await writeFile(`${settingsPath()}.tmp`, JSON.stringify({ automatic }));
    await rename(`${settingsPath()}.tmp`, settingsPath());
  } catch (error) {
    notify("Meeting setting not saved", error.message);
  }
  render();
}

async function readAutomatic() {
  try {
    return JSON.parse(await readFile(settingsPath(), "utf8")).automatic === true;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("QM could not read meeting settings", error);
    return false;
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
      if (response.status < 500 && response.status !== 408 && response.status !== 429) throw new Error(problem);
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
    current.path = (await response.json()).path;
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

function upload(current, speaker, at, bytes) {
  current.lastSpeech = Date.now();
  current.uploads[speaker] = current.uploads[speaker].then(async () => {
    if (current.failure) return;
    try {
      await meeting(current);
      await call(current, (signal) =>
        request(
          `/api/meetings/${current.id}/speech?${new URLSearchParams({ speaker, at: String(at) })}`,
          "POST",
          signal,
          "audio/webm",
          bytes,
        ),
      );
    } catch (error) {
      fail(current, error);
    }
  });
}

function trackProblem(current, speaker, problem) {
  current.tracks[speaker] = problem;
  render();
  if (Object.keys(current.tracks).length === 2) fail(current, new Error(Object.values(current.tracks).join(" ")));
  else notify(`${trackNames[speaker]} is not being recorded`, problem);
}

async function startRecording(detected) {
  if (recording || !enabled) return;
  const current = {
    id: randomUUID(),
    startedAt: Date.now(),
    app: detected,
    detected: Boolean(detected),
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
    showTime();
  }, 1000);
  render();
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted")
    await systemPreferences.askForMediaAccess("microphone");
  if (recording !== current || current.stopping) return;
  current.stopCapture = startCapture(
    (speaker, at, bytes) => upload(current, speaker, at, bytes),
    (speaker, problem) => trackProblem(current, speaker, problem),
  );
  if (current.detected && !meetingNow) endMeetingSoon();
}

export function stopRecording() {
  const current = recording;
  if (!current) return Promise.resolve();
  current.stopping ??= (async () => {
    clearTimeout(meetingEnded);
    clearInterval(current.ticker);
    const endedAt = Date.now();
    render();
    await current.stopCapture?.();
    await Promise.all(Object.values(current.uploads));
    if (current.created && !current.failure) {
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
    else if (!current.created) notify("Recording stopped", "No speech was heard, so nothing was saved.");
    else
      notify(
        "Meeting recorded",
        current.silent ? "Stopped after 15 minutes without speech. QM is writing notes." : "QM is writing notes.",
        open,
      );
  })();
  return current.stopping;
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
      void startRecording(name);
      notify(`Recording your ${name} meeting`, "Stop it from the QM menu bar item.");
    } else
      notify("Meeting detected", `${name} is using the microphone.`, {
        label: "Record",
        run: () => void startRecording(name),
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
  ];
}

export function configureMeetings(options) {
  ({ request, openNotes } = options);
  registerRecorder();
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
    automatic = await readAutomatic();
    tray = new Tray(
      nativeImage.createFromPath(path.join(directory, "assets/qm.png")).resize({ width: 16, height: 16 }),
    );
    stopWatching = watchMicrophone(microphoneChanged, (problem) => {
      detectionProblem = problem;
      render();
    });
  } else {
    stopWatching?.();
    tray?.destroy();
    tray = stopWatching = detectionProblem = meetingNow = notes = undefined;
  }
  render();
}
