export const desktopComputerTool = {
  name: "desktop",
  description:
    "Run JavaScript to observe and control apps on the user's Mac through the computer API. Prefer an available connector or API when it can complete the task. Top-level await is supported; variables persist between calls within this turn. The first call returns API documentation. Start with await computer.listApps() or await computer.getApp(name). Console output, observations, and screenshots are returned. Set reset to clear JavaScript state. Only human-initiated desktop turns with a live connection have access.",
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
