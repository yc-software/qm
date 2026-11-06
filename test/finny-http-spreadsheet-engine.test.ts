import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDeterministicSpreadsheetWorker,
  digestSpreadsheetArtifact,
} from "../src/finny/deterministic-spreadsheet-worker.ts";
import { createHttpSpreadsheetCalculationEngine } from "../src/finny/http-spreadsheet-engine.ts";

const artifactBytes = new TextEncoder().encode("workbook bytes");
const binding = {
  artifactDigest: digestSpreadsheetArtifact(artifactBytes),
  policyVersion: "finny-r5.1",
  checks: [
    { checkId: "formula.recalculate" as const, generation: 2 },
    { checkId: "summary.crossfoot" as const, generation: 3 },
    { checkId: "artifact.structure" as const, generation: 4 },
  ],
};

const results = [
  {
    checkId: "formula.recalculate" as const,
    generation: 2,
    verdict: "pass" as const,
    evidence: { kind: "formula-recalculation" as const, cells: [] },
  },
  {
    checkId: "summary.crossfoot" as const,
    generation: 3,
    verdict: "pass" as const,
    evidence: { kind: "cross-foot" as const, comparisons: [] },
  },
  {
    checkId: "artifact.structure" as const,
    generation: 4,
    verdict: "pass" as const,
    evidence: { kind: "structure" as const, sheets: [] },
  },
];

test("HTTP engine sends immutable bytes and binding to the configured endpoint", async () => {
  const requests: Array<{ url: string; init: RequestInit; body: any }> = [];
  const engine = createHttpSpreadsheetCalculationEngine(
    {
      url: "https://spreadsheet-engine.example/evaluate",
      name: "libreoffice-service",
      version: "24.2",
      timeoutMs: 30_000,
      maxResponseBytes: 100_000,
    },
    async (url, init) => {
      requests.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
      return Response.json({ results });
    },
  );
  const envelope = await createDeterministicSpreadsheetWorker(engine).run({ artifactBytes, binding });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://spreadsheet-engine.example/evaluate");
  assert.equal(requests[0]?.init.method, "POST");
  assert.equal(requests[0]?.body.artifactBase64, Buffer.from(artifactBytes).toString("base64"));
  assert.deepEqual(requests[0]?.body.binding, binding);
  assert.deepEqual(envelope.results, results);
  assert.deepEqual(envelope.engine, { name: "libreoffice-service", version: "24.2" });
});

test("HTTP engine fails closed on provider errors and bounded response violations", async () => {
  const config = {
    url: "https://spreadsheet-engine.example/evaluate",
    name: "engine",
    version: "1",
    timeoutMs: 30_000,
    maxResponseBytes: 8,
  };
  await assert.rejects(
    () =>
      createHttpSpreadsheetCalculationEngine(config, async () => new Response("no", { status: 503 })).evaluate({
        artifactBytes: Array.from(artifactBytes),
        binding,
      }),
    /503/,
  );
  await assert.rejects(
    () =>
      createHttpSpreadsheetCalculationEngine(config, async () => Response.json({ results })).evaluate({
        artifactBytes: Array.from(artifactBytes),
        binding,
      }),
    /response.*limit/i,
  );
  await assert.rejects(
    () =>
      createHttpSpreadsheetCalculationEngine({ ...config, maxResponseBytes: 100_000 }, async () =>
        Response.json({ results, verdict: "pass" }),
      ).evaluate({ artifactBytes: Array.from(artifactBytes), binding }),
    /response.*invalid/i,
  );
});
