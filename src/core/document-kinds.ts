import type { AttachmentMeta } from "../types.ts";

export const MAX_DOCUMENT_BYTES = 8_000_000;
export const MAX_DOCUMENT_TEXT_CHARS = 200_000;
const TEXT_EXTENSIONS = new Set(
  "asm bat c cc conf cpp css cxx def dic eml h hh htm html ics ifb in js json ksh list log markdown md mht mhtml mime mjs nws pl py rst s sql srt text txt vcf vtt xml ts tsx jsx sh bash zsh yml yaml toml rs go java rb php swift kt scala lua r jl perl tex cs graphql ndjson json5 dockerfile".split(
    " ",
  ),
);
const DOCUMENT_EXTENSIONS = new Set(
  "pdf xla xlb xlc xlm xls xlsx xlt xlw csv tsv iif doc docx dot odt rtf pages pot ppa pps ppt pptx pwz wiz key ods odp".split(
    " ",
  ),
);
export const OFFICE_FALLBACK_EXTENSIONS = new Set("pdf docx pptx xlsx odt odp ods rtf".split(" "));
const extension = (name: string): string => name.split(".").at(-1)!.toLowerCase();

const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/json": "json",
  "application/xml": "xml",
  "application/javascript": "js",
};

export function documentExtension(file: { name: string; mimeType?: string; mimetype?: string }): string {
  const ext = extension(file.name);
  if (TEXT_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext)) return ext;
  const mime = (file.mimeType ?? file.mimetype ?? "").split(";")[0]!.trim().toLowerCase();
  return MIME_EXTENSIONS[mime] ?? (mime.startsWith("text/") ? "txt" : ext);
}

export function isDocumentAttachment(file: { name: string; mimetype?: string }): boolean {
  const ext = documentExtension(file);
  return TEXT_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext);
}

export function isTextDocument(file: { name: string; mimeType?: string; mimetype?: string }): boolean {
  const ext = documentExtension(file);
  return TEXT_EXTENSIONS.has(ext) || ["csv", "tsv", "iif"].includes(ext);
}

const DOCUMENT_BYTES_PER_TOKEN = 4;

export function estimateDocumentTokens(file: {
  name: string;
  mimeType?: string;
  mimetype?: string;
  sizeBytes: number;
}): number {
  const bytes = Number.isFinite(file.sizeBytes) && file.sizeBytes > 0 ? file.sizeBytes : 0;
  const expanded = isTextDocument(file) ? Math.min(bytes, MAX_DOCUMENT_TEXT_CHARS) : bytes;
  return Math.ceil(expanded / DOCUMENT_BYTES_PER_TOKEN);
}

export function replayableDocumentMetas(payload: unknown): AttachmentMeta[] {
  const attachments = (payload as { attachments?: unknown } | null)?.attachments;
  if (!Array.isArray(attachments)) return [];
  return (attachments as AttachmentMeta[]).filter(
    (file) =>
      file?.direction === "in" &&
      typeof file.name === "string" &&
      typeof file.artifactId === "string" &&
      isDocumentAttachment(file),
  );
}

export function documentAttachmentTokens(payload: unknown): number {
  return replayableDocumentMetas(payload).reduce((sum, file) => sum + estimateDocumentTokens(file), 0);
}

export function fileContentRequest(artifactId: string): string {
  return `GET $AGENT_API_URL/v1/files/${artifactId}/content (header x-agent-capability: $AGENT_API_TOKEN)`;
}

export function documentStub(file: { name: string; artifactId?: string }): string {
  const where = file.artifactId
    ? `It is still saved as file ${file.artifactId}: read it with ${fileContentRequest(file.artifactId)} and extract only the parts you need.`
    : "It is still saved in this conversation's files.";
  return `${JSON.stringify(file.name)} is not included inline, to keep this conversation within the model's context. ${where}`;
}
