import { parentPort, workerData } from "node:worker_threads";
import { OfficeParser } from "officeparser";

try {
  const ast = await OfficeParser.parseOffice(Buffer.from(workerData.dataBase64, "base64"), {
    ocr: false,
    extractAttachments: false,
    decompressionLimits: { maxUncompressedBytes: 32_000_000, maxZipEntries: 2000, maxTableCells: 100_000 },
  });
  const result = await ast.to("text");
  const text = String(result.value);
  parentPort?.postMessage({
    text:
      text.length > workerData.maxChars
        ? `${text.slice(0, workerData.maxChars)}\n[Document text truncated at ${workerData.maxChars} characters.]`
        : text,
  });
} catch {
  parentPort?.postMessage({ error: "Document text could not be extracted." });
}
