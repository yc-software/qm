import { createHash, randomUUID } from "node:crypto";
import {
  S3Client,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  ListMultipartUploadsCommand,
  UploadPartCommand,
  type Part,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isNoSuchKey, type S3Send } from "../persistence/s3.ts";
import {
  FileArtifactDeletedError,
  artifactPath,
  type FileArtifact,
  type FileArtifactStore,
} from "./file-artifact-store.ts";
import type { FileUpload, FileUploadStore } from "./file-upload-store.ts";
import { safeAttachmentName, mimeFromName } from "../core/attachments.ts";
import { createSweeper } from "../util/sweeper.ts";

export const FILE_UPLOAD_PART_SIZE = 64 * 1024 * 1024;
const MAX_DIRECT_FILE_BYTES = 100 * 1024 ** 3;
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const URL_TTL_SECONDS = 15 * 60;
const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

export class FileUploadError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function multipartChecksum(checksums: string[]): string {
  return `${createHash("sha256")
    .update(Buffer.concat(checksums.map((v) => Buffer.from(v, "base64"))))
    .digest("base64")}-${checksums.length}`;
}

export interface DirectFileUploads {
  begin(
    input: Pick<FileUpload, "actorId" | "scopeId" | "name" | "mimetype" | "sizeBytes" | "checksums"> & {
      requestId?: string;
    },
  ): Promise<FileUpload>;
  get(id: string): Promise<FileUpload | null>;
  sign(id: string, partNumber: number): Promise<{ url: string; headers: Record<string, string>; expiresAt: number }>;
  complete(id: string): Promise<FileArtifact>;
  abort(id: string): Promise<void>;
  sweep(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createDirectFileUploads(options: {
  bucket: string;
  prefix?: string;
  region?: string;
  store: FileUploadStore;
  files: FileArtifactStore;
  client?: S3Send;
  presign?: (command: UploadPartCommand, expiresIn: number) => Promise<string>;
  now?: () => number;
}): DirectFileUploads {
  const nativeClient = new S3Client(options.region ? { region: options.region } : {});
  const client = options.client ?? nativeClient;
  const presign =
    options.presign ??
    ((command, expiresIn) =>
      getSignedUrl(nativeClient, command, {
        expiresIn,
        signableHeaders: new Set(["content-length"]),
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      }));
  const now = options.now ?? Date.now;
  const { store, files } = options;
  const target = (row: FileUpload) => ({
    Bucket: options.bucket,
    Key: `${options.prefix ?? ""}files/uploads/${row.id}`,
  });
  async function requireRow(id: string): Promise<FileUpload> {
    const row = await store.get(id);
    if (!row) throw new FileUploadError("upload not found", 404);
    return row;
  }
  async function verifyObject(row: FileUpload): Promise<boolean> {
    try {
      const head = (await client.send(new HeadObjectCommand({ ...target(row), ChecksumMode: "ENABLED" }))) as {
        ContentLength?: number;
        ChecksumSHA256?: string;
        Metadata?: Record<string, string>;
      };
      if (
        head.ContentLength !== row.sizeBytes ||
        head.ChecksumSHA256 !== multipartChecksum(row.checksums) ||
        head.Metadata?.["qm-upload"] !== row.id
      )
        throw new FileUploadError("completed object integrity check failed", 409);
      return true;
    } catch (error) {
      if (isNoSuchKey(error)) return false;
      throw error;
    }
  }
  async function uploadedParts(row: FileUpload): Promise<Part[]> {
    const parts: Part[] = [];
    let marker: string | undefined;
    do {
      const result = (await client.send(
        new ListPartsCommand({
          ...target(row),
          UploadId: row.uploadId,
          ...(marker ? { PartNumberMarker: marker } : {}),
        }),
      )) as { Parts?: Part[]; IsTruncated?: boolean; NextPartNumberMarker?: string };
      parts.push(...(result.Parts ?? []));
      marker = result.IsTruncated ? result.NextPartNumberMarker : undefined;
      if (result.IsTruncated && !marker) throw new Error("S3 omitted the next part marker");
      if (parts.length > row.checksums.length) throw new FileUploadError("unexpected uploaded parts", 409);
    } while (marker);
    if (
      parts.length !== row.checksums.length ||
      parts.some(
        (part, i) =>
          part.PartNumber !== i + 1 ||
          !part.ETag ||
          part.ChecksumSHA256 !== row.checksums[i] ||
          part.Size !== Math.min(row.partSize, row.sizeBytes - i * row.partSize),
      )
    )
      throw new FileUploadError("upload parts are incomplete or do not match the manifest", 409);
    return parts;
  }
  const sweeper = createSweeper(() => service.sweep(), 60_000, { label: "file uploads", immediate: true });
  const service: DirectFileUploads = {
    async begin(input) {
      if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0 || input.sizeBytes > MAX_DIRECT_FILE_BYTES)
        throw new FileUploadError(`sizeBytes must be between 0 and ${MAX_DIRECT_FILE_BYTES}`);
      if (
        !Array.isArray(input.checksums) ||
        input.checksums.length !== Math.max(1, Math.ceil(input.sizeBytes / FILE_UPLOAD_PART_SIZE)) ||
        input.checksums.some(
          (v) => typeof v !== "string" || !SHA256_BASE64.test(v) || Buffer.from(v, "base64").toString("base64") !== v,
        )
      )
        throw new FileUploadError("checksums must contain one base64 SHA-256 per 64 MiB part");
      if (
        input.requestId !== undefined &&
        (typeof input.requestId !== "string" || !/^[0-9a-f]{32}$/.test(input.requestId))
      )
        throw new FileUploadError("requestId must be 32 lowercase hex characters");
      const id = input.requestId ?? randomUUID().replaceAll("-", "");
      const name = safeAttachmentName(input.name);
      const row: FileUpload = {
        ...input,
        name,
        mimetype: input.mimetype || mimeFromName(name),
        id,
        partSize: FILE_UPLOAD_PART_SIZE,
        uploadId: "",
        state: "pending",
        createdAt: now(),
        expiresAt: now() + UPLOAD_TTL_MS,
      };
      const matches = (existing: FileUpload) =>
        existing.actorId === row.actorId &&
        existing.scopeId === row.scopeId &&
        existing.name === row.name &&
        existing.mimetype === row.mimetype &&
        existing.sizeBytes === row.sizeBytes &&
        JSON.stringify(existing.checksums) === JSON.stringify(row.checksums);
      const existing = await store.get(id);
      if (existing) {
        if (!matches(existing)) throw new FileUploadError("request ID already used", 409);
        return existing;
      }
      if (await files.get(id, { includeDisabled: true })) throw new FileUploadError("request ID already used", 409);
      const created = (await client.send(
        new CreateMultipartUploadCommand({
          ...target(row),
          ContentType: row.mimetype,
          ChecksumAlgorithm: "SHA256",
          ChecksumType: "COMPOSITE",
          Metadata: { "qm-upload": id },
        }),
      )) as { UploadId?: string };
      if (!created.UploadId) throw new Error("S3 did not return an upload ID");
      row.uploadId = created.UploadId;
      try {
        await store.insert(row);
      } catch (error) {
        await client.send(new AbortMultipartUploadCommand({ ...target(row), UploadId: row.uploadId }));
        const raced = await store.get(id);
        if (raced && matches(raced)) return raced;
        throw error;
      }
      return row;
    },
    get: (id) => store.get(id),
    async sign(id, partNumber) {
      const row = await requireRow(id);
      if (row.state !== "pending" || row.expiresAt <= now())
        throw new FileUploadError("upload is not pending or has expired", 409);
      if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > row.checksums.length)
        throw new FileUploadError("invalid part number");
      const length = Math.min(row.partSize, row.sizeBytes - (partNumber - 1) * row.partSize);
      const expiresIn = Math.min(URL_TTL_SECONDS, Math.floor((row.expiresAt - now()) / 1000));
      if (expiresIn < 1) throw new FileUploadError("upload expired", 409);
      const checksum = row.checksums[partNumber - 1]!;
      const url = await presign(
        new UploadPartCommand({
          ...target(row),
          UploadId: row.uploadId,
          PartNumber: partNumber,
          ContentLength: length,
          ChecksumSHA256: checksum,
        }),
        expiresIn,
      );
      return {
        url,
        headers: { "content-length": String(length), "x-amz-checksum-sha256": checksum },
        expiresAt: now() + expiresIn * 1000,
      };
    },
    async complete(id) {
      let row = await requireRow(id);
      if (row.state === "complete") {
        const artifact = await files.get(id, { includeDisabled: true });
        if (!artifact) throw new FileUploadError("published file was deleted", 410);
        if (
          artifact.blobKey !== `files/uploads/${id}` ||
          artifact.ownerScopeId !== row.scopeId ||
          artifact.createdBy !== row.actorId
        )
          throw new FileUploadError("file identity conflict", 409);
        return artifact;
      }
      if (row.state === "failed") throw new FileUploadError("upload bytes are no longer available", 410);
      if (row.state !== "pending" && row.state !== "completing")
        throw new FileUploadError("upload cannot be completed", 409);
      if (row.state === "pending" && row.expiresAt <= now()) throw new FileUploadError("upload expired", 409);
      if (!(await verifyObject(row))) {
        let parts: Part[];
        try {
          parts = await uploadedParts(row);
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "NoSuchUpload") throw error;
          if (await verifyObject(row)) return service.complete(id);
          await store.transition(id, ["pending", "completing"], "failed");
          throw new FileUploadError("upload bytes are no longer available", 410);
        }
        if (row.state === "pending" && !(await store.transition(id, ["pending"], "completing"))) {
          row = await requireRow(id);
          if (row.state !== "completing" && row.state !== "complete")
            throw new FileUploadError("upload was aborted", 409);
        }
        try {
          await client.send(
            new CompleteMultipartUploadCommand({
              ...target(row),
              UploadId: row.uploadId,
              ChecksumType: "COMPOSITE",
              ChecksumSHA256: multipartChecksum(row.checksums),
              MultipartUpload: {
                Parts: parts.map((p) => ({
                  PartNumber: p.PartNumber!,
                  ETag: p.ETag!,
                  ChecksumSHA256: p.ChecksumSHA256!,
                })),
              },
            }),
          );
        } catch (error) {
          if (!(await verifyObject(row))) throw error;
        }
        if (!(await verifyObject(row))) throw new FileUploadError("completed object is missing", 409);
      }
      const current = await requireRow(id);
      if (current.state !== "completing" && current.state !== "complete")
        throw new FileUploadError("upload cannot be published", 409);
      let artifact: FileArtifact;
      try {
        ({ artifact } = await files.publish({
          id,
          ownerScopeId: row.scopeId,
          createdBy: row.actorId,
          name: row.name,
          path: artifactPath(id, row.name),
          mimetype: row.mimetype,
          blobKey: `files/uploads/${id}`,
          sizeBytes: row.sizeBytes,
          sha256: null,
          direction: "out",
          createdInScope: row.scopeId,
          createdAt: row.createdAt,
        }));
      } catch (error) {
        if (!(error instanceof FileArtifactDeletedError)) throw error;
        await store.transition(id, ["completing"], "complete");
        throw new FileUploadError("published file was deleted", 410);
      }
      if (
        artifact.blobKey !== `files/uploads/${id}` ||
        artifact.ownerScopeId !== row.scopeId ||
        artifact.createdBy !== row.actorId
      )
        throw new FileUploadError("file identity conflict", 409);
      await store.transition(id, ["completing"], "complete");
      return artifact;
    },
    async abort(id) {
      let row = await requireRow(id);
      if (row.state === "aborted" || row.state === "failed") return;
      if (row.state === "pending") {
        if (!(await store.transition(id, ["pending"], "aborting"))) row = await requireRow(id);
        else row = { ...row, state: "aborting" };
      }
      if (row.state !== "aborting") throw new FileUploadError("upload completion has already started", 409);
      try {
        await client.send(new AbortMultipartUploadCommand({ ...target(row), UploadId: row.uploadId }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "NoSuchUpload") throw error;
      }
      await store.transition(id, ["aborting"], "aborted");
    },
    async sweep() {
      for (const row of await store.expired(now())) {
        try {
          if (row.state === "completing") await service.complete(row.id);
          else await service.abort(row.id);
        } catch (error) {
          if (error instanceof FileUploadError && error.status === 410) continue;
          console.warn("[file uploads] cleanup failed", row.id, error instanceof Error ? error.name : "unknown");
        }
      }
      let keyMarker: string | undefined;
      let uploadMarker: string | undefined;
      do {
        const page = (await client.send(
          new ListMultipartUploadsCommand({
            Bucket: options.bucket,
            Prefix: `${options.prefix ?? ""}files/uploads/`,
            MaxUploads: 100,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            ...(uploadMarker ? { UploadIdMarker: uploadMarker } : {}),
          }),
        )) as {
          Uploads?: Array<{ Key?: string; UploadId?: string; Initiated?: Date }>;
          IsTruncated?: boolean;
          NextKeyMarker?: string;
          NextUploadIdMarker?: string;
        };
        for (const upload of page.Uploads ?? []) {
          if (
            !upload.Key ||
            !upload.UploadId ||
            !upload.Initiated ||
            upload.Initiated.getTime() > now() - UPLOAD_TTL_MS
          )
            continue;
          const id = upload.Key.slice(`${options.prefix ?? ""}files/uploads/`.length);
          if (!/^[0-9a-f]{32}$/.test(id)) continue;
          const row = await store.get(id);
          if (row?.state === "completing" && row.uploadId === upload.UploadId) continue;
          await client.send(
            new AbortMultipartUploadCommand({ Bucket: options.bucket, Key: upload.Key, UploadId: upload.UploadId }),
          );
        }
        keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
        uploadMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
        if (page.IsTruncated && !keyMarker) throw new Error("S3 omitted the next upload marker");
      } while (keyMarker);
    },
    start: () => sweeper.start(),
    stop: () => sweeper.stop(),
  };
  return service;
}
