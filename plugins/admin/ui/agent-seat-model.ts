type Row = Record<string, any>;

export function capturedBody(request: Row): Row {
  const value = request.promptEnvelope ?? request.request;
  if (typeof value === "string") {
    try {
      return capturedBody({ request: JSON.parse(value) });
    } catch {
      return { unparsed: value };
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function exactText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}

export function snapshot(request: Row) {
  const body = capturedBody(request);
  const context = body.threadStart ?? (body.context && typeof body.context === "object" ? body.context : body);
  const source = context.messages ?? context.input ?? context.contents;
  let messages: Row[] = [];
  if (Array.isArray(source))
    messages = source.map((message) => (message && typeof message === "object" ? message : { content: message }));
  else if (typeof source === "string") messages = [{ role: "user", content: source }];
  let prefix = 0;
  while (prefix < messages.length && ["system", "developer"].includes(messages[prefix]!.role)) prefix++;
  const instructions = messages.slice(0, prefix);
  const conversation = messages.slice(prefix);
  const system =
    context.system ??
    context.systemPrompt ??
    context.instructions ??
    context.baseInstructions ??
    body.config?.systemInstruction ??
    body.systemInstruction;
  const blocks: { label: string; value: unknown }[] = [];
  if (system !== undefined) blocks.push({ label: "System prompt", value: system });
  if (context.developerInstructions != null)
    blocks.push({ label: "Developer instructions", value: context.developerInstructions });
  for (const m of instructions) blocks.push({ label: m.role, value: m.content ?? m });
  const rawTools = context.dynamicTools ?? context.tools ?? body.tools;
  const names: string[] = Array.isArray(body.allowedTools) ? body.allowedTools : [];
  const rawList: unknown[] = Array.isArray(rawTools)
    ? rawTools.flatMap((t) => (Array.isArray(t?.functionDeclarations) ? t.functionDeclarations : [t]))
    : [];
  for (const name of names)
    if (!rawList.some((t) => t === name || (t && typeof t === "object" && "name" in t && t.name === name)))
      rawList.push(name);
  const tools = rawList
    .filter((t) => typeof t === "string" || (t && typeof t === "object"))
    .map((t, index) => {
      const definition = t as Row;
      return {
        name: typeof t === "string" ? t : toolName(definition, index),
        description:
          typeof t === "string"
            ? "Only the tool name was captured; its description and schema are unavailable."
            : (definition.description ?? definition.function?.description ?? "No description captured."),
        raw: t,
        parameters:
          typeof t === "string"
            ? undefined
            : (definition.parameters ??
              definition.input_schema ??
              definition.inputSchema ??
              definition.function?.parameters),
        nameOnly: typeof t === "string",
      };
    });
  const kind = body.threadStart || body.allowedTools ? "Harness configuration" : "Captured request";
  return { body, blocks, conversation, tools, kind, truncated: !!request.truncated || !!body.truncated };
}

export function contentParts(value: unknown): string[] {
  if (!Array.isArray(value)) return [exactText(value)];
  return value.map((part) =>
    part && typeof part === "object" && typeof part.text === "string" ? part.text : exactText(part),
  );
}

export function toolName(tool: Row, index: number): string {
  return tool.name ?? tool.function?.name ?? tool.type ?? `Tool ${index + 1}`;
}

export function changedMessages(current: Row[], previous: Row[]): Set<number> {
  let prefix = 0;
  while (
    prefix < current.length &&
    prefix < previous.length &&
    JSON.stringify(current[prefix]) === JSON.stringify(previous[prefix])
  )
    prefix++;
  return new Set(current.map((_, index) => index).filter((index) => index >= prefix));
}

export function parseSession(value: string): string {
  const input = value.trim();
  if (!input) throw new Error("Enter a session ID or a session link.");
  if (!input.includes("/")) return input;
  const url = new URL(input, "https://local.invalid");
  const match = url.pathname.match(/\/history\/s\/([^/]+)\/?$/);
  const id = match ? decodeURIComponent(match[1]!) : url.searchParams.get("session");
  if (!id) throw new Error("This link does not contain a session ID.");
  return id;
}

export function turnEntries(entries: Row[], turnSeq: number | null): Row[] {
  if (turnSeq === null) return [];
  const start = entries.findIndex((entry) => entry.seq === turnSeq);
  if (start < 0) return [];
  let end = entries.findIndex((entry, index) => index > start && entry.type === "user");
  if (end < 0) end = entries.length;
  return entries.slice(start, end);
}
