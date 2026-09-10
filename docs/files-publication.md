# Durable Files publication

Files publication is independent of a sandbox's lifetime. The S3/Postgres deployment supports direct multipart transfers from a sandbox or API client. File bytes travel to S3; core authorizes the upload and publishes its metadata after verifying the completed object.

## Agent usage

Run this in a sandbox with the normal agent API environment:

```sh
curl -fsS "$AGENT_API_URL/v1/files/upload-client" \
  -H "x-agent-capability: $AGENT_API_TOKEN" -o /tmp/qm-upload.py
python3 /tmp/qm-upload.py path/to/report.pdf
```

The helper prints the published file and its content URL only after completion. It uses Python's standard library, holds at most one 64 MiB part in memory, retries transfers, and obtains another signed URL if one expires. A local `<filename>.qm-upload.json` tracks progress without storing credentials or signed URLs. Rerunning the same command resumes the same upload and returns the same artifact. `--state` selects another progress file; `--name` changes the published name. Keep the source file unchanged during transfer. The helper binds its progress to the API origin, actor, conversation scope, and complete part manifest.

The file belongs to the conversation scope. An agent token cannot publish into another scope or inspect another scope's upload sessions, even if its actor belongs to both scopes. Retirement of a sandbox does not affect a completed file. An unfinished upload is not a file and does not appear in Files.

## Direct protocol

Each JSON request requires the existing authenticated agent or user identity. A user client follows the existing principal-bound source authentication contract; an agent uses `x-agent-capability`.

| Method | Endpoint                              | Meaning                                                                                                            |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| POST   | `/v1/files/uploads`                   | Begin with `name`, optional `mimetype`, optional `scopeId`, `sizeBytes`, ordered `checksums`, optional `requestId` |
| GET    | `/v1/files/uploads/:id`               | Read the caller's session state                                                                                    |
| POST   | `/v1/files/uploads/:id/parts/:number` | Obtain a signed PUT URL plus required headers                                                                      |
| POST   | `/v1/files/uploads/:id/complete`      | Verify uploaded parts and publish the file                                                                         |
| DELETE | `/v1/files/uploads/:id`               | Abort before completion starts                                                                                     |

Split bytes into 64 MiB parts and supply each part's base64 SHA-256 checksum. An empty file has one empty part and the SHA-256 checksum of empty bytes. `requestId` is 32 lowercase hexadecimal characters; persist it before initiation to make response-loss retries idempotent. Reusing it with another manifest is rejected. Upload every part using the returned headers, including the signed content length and SHA-256 checksum. Completion uses S3's actual part sizes, checksums, and ETags rather than accepting a client claim that the transfer succeeded.

The limit is 100 GiB per file, four active uploads per actor, and 500 GiB of active declared bytes per actor. Sessions expire after 24 hours; signed URLs last at most 15 minutes and never outlast their session. Abort and completion have mutually exclusive durable state transitions. Once completion has begun, retry completion instead of aborting. Core can recover completion after S3 succeeded but a response or database write failed. Deleting an already-published artifact records an ID-only tombstone. Publication and deletion serialize on that ID, so recovery cannot recreate the file even if the upload state update failed after publication.

S3 stores a SHA-256 composite checksum for multipart objects. This is a checksum of the ordered part checksums, with a part-count suffix. It is not the SHA-256 of the entire file: these artifacts intentionally have `sha256: null`. Their unique blob key and server-verified multipart manifest identify the uploaded bytes.

## Deployment and recovery

New direct uploads require S3 file storage, Postgres, and `FILES_DIRECT_UPLOADS_ENABLED=true` (default `false`). Deploy this release with the flag disabled to every API server and worker before enabling it in a separate rollout. Older releases cannot read the new object keys or preserve deletion fences; after activation, any rollback target must include this release's reader and deletion compatibility. Turning the flag off disables initiation while preserving authenticated helper downloads, existing session status, signing, completion, abort, and background recovery. The helper can resume an existing session while initiation is disabled, including after a sandbox replacement. Upload sessions reside in `file_uploads`; process-local state is not required for recovery. Missing multipart uploads with no completed object become terminal failed sessions and release their quota. Expired sessions are claimed in bounded batches with durable retry times, so repeated failures cannot starve later sessions. The worker sweeper retries expired sessions each minute and aborts old multipart uploads under the Files upload prefix, including uploads abandoned before their session could be recorded. It does not change bucket lifecycle configuration. Deployments should also configure S3 abort-incomplete-multipart lifecycle rules as protection when core is unavailable for an extended period.

The core's S3 role needs `s3:GetObject`, `s3:PutObject`, `s3:AbortMultipartUpload`, and `s3:ListMultipartUploadParts` on its Files prefix, plus `s3:ListBucket` and `s3:ListBucketMultipartUploads` on the bucket. Existing generated AWS infrastructure includes these permissions. KMS-encrypted buckets also need the applicable KMS permissions to complete uploads and retrieve checksums. The sandbox needs outbound HTTPS to the S3 endpoint but receives no AWS credentials.

The existing browser uploader remains on its existing attachment-size limit. It does not automatically use this protocol. A browser client adopting the protocol must configure appropriate bucket CORS for PUT and the checksum header; Python and other non-browser clients do not require CORS.

Local and proxied S3 writes spool incoming bytes to temporary disk while hashing, with backpressure and the existing size checks. Local publication renames the completed temporary file atomically; S3 uploads the spool as bounded-memory parts. Temporary files are removed on success and failure. This fallback uses core disk proportional to the upload size; use the direct path for large files.
