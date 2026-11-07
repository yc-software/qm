import { tmpdir } from "node:os";
import { join } from "node:path";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderJunit(summary) {
  const failures = summary.cases.filter((candidate) => !candidate.passed).length;
  const properties = {
    sourceRevision: summary.sourceRevision,
    sourceStateDigest: summary.sourceStateDigest,
    sourceDirty: summary.sourceDirty,
    databaseConfigured: summary.databaseConfigured,
    liveServices: summary.liveServices,
  };
  const propertyXml = Object.entries(properties)
    .map(([name, value]) => `<property name="${xml(name)}" value="${xml(value)}"/>`)
    .join("");
  const body = summary.cases
    .map((candidate) => {
      const selectors = candidate.selectors.map((selector) => `${selector.file}: ${selector.name}`).join("\n");
      const missing = candidate.missingSelectors ?? [];
      const failed = [
        ...candidate.failedCommandIds.map((id) => `command:${id}`),
        ...missing.map((selector) => `selector:${selector.commandId}:${selector.name}`),
      ];
      const failure = candidate.passed
        ? ""
        : `<failure message="${xml(`Authoritative evidence failure: ${failed.join(", ")}`)}">${xml(
            candidate.failedCommandIds
              .map((id) => {
                const command = summary.commands.find((candidateCommand) => candidateCommand.id === id);
                return [command?.stdout, command?.stderr].filter(Boolean).join("\n");
              })
              .join("\n"),
          )}</failure>`;
      return `<testcase classname="finnyloop-r5" name="${xml(candidate.id)}" time="${(
        candidate.durationMs / 1000
      ).toFixed(3)}">${failure}<system-out>${xml(`${candidate.invariant}\n${selectors}`)}</system-out></testcase>`;
    })
    .join("");
  const commandEvidence = summary.commands.map((command) => ({
    id: command.id,
    program: command.program,
    args: command.args,
    requiresDatabase: command.requiresDatabase,
    passed: command.passed,
    exitCode: command.exitCode,
    signal: command.signal,
    durationMs: command.durationMs,
  }));
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="finnyloop-r5" tests="${summary.cases.length}" failures="${failures}" time="${(
    summary.durationMs / 1000
  ).toFixed(3)}"><properties>${propertyXml}</properties>${body}<system-out>${xml(
    JSON.stringify({ commands: commandEvidence }),
  )}</system-out></testsuite>\n`;
}

export function defaultOutputDirectory(now, pid) {
  return join(tmpdir(), `finnyloop-r5-evidence-${now}-${pid}`);
}
