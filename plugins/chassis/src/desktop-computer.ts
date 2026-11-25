export const desktopComputerTool = {
  name: "desktop",
  description:
    "Run JavaScript to observe and control apps on the user's Mac through the computer API. Prefer an available connector or API when it can complete the task. Top-level await is supported; variables persist between calls within this turn. The first call returns API documentation. Start with await computer.listApps() or await computer.getApp(name). Console output, observations, and screenshots are returned. Set reset to clear JavaScript state. Runs through the QM desktop app open on the person's Mac, whichever app this message came from, but only on messages the person addressed to you themselves; returns an error if no desktop app answers.",
  timeoutMs: 60_000,
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", maxLength: 100_000 },
      title: { type: "string" },
      reset: { type: "boolean" },
    },
    required: ["code"],
    additionalProperties: false,
  },
};
