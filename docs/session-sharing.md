# Session sharing

The Share button beside a session title creates a read-only copy of its visible messages, replies, and attachments. Every creation produces a fresh link. Existing links keep their original content; there are no update or revoke controls.

Choose **Anyone in your organization** to require a signed-in internal account, or **Anyone with the link** to allow viewing and downloading without signing in. The latter is a bearer link: recipients can forward it. External links use the deployment's public portal origin; localhost links work only on the machine running the dev instance.

The server constructs the snapshot from an allowlist of user messages, final assistant replies, successful published replies, and their attachments. Thinking, intermediate text, tool commands/results, hidden messages, raw payloads, and source metadata are never sent to the shared webpage. Successful attachment delivery is projected to file metadata only. Text and attachments can themselves contain sensitive information; choose the audience accordingly.

Each attachment is authorized for the creator and copied into separate durable share storage. Share-specific file identifiers authorize only that snapshot's copied files. Downloads cannot fetch arbitrary session files. Raster images may render inline; other types download with a sandbox policy. Shared markdown cannot embed remote media or private resource links.

Snapshots live in the durable `session_shares` map, keyed by an unguessable random token. Copied bytes live in the configured durable byte backend under `session-shares`. Both internal and external reads verify that the creator is still internal and can access the original entries. If that access disappears, the share becomes unavailable.

The public portal permits only external share pages, their file downloads, and built static assets without sign-in. It forwards no browser cookies or identity headers on those routes. The web server calls the dedicated signed core projection endpoint; it never loads the private session API. Shared pages use an isolated frontend entry with no session fetches, no-store responses, no-referrer, noindex, and a restrictive content security policy. External pages use the production build even during development.
