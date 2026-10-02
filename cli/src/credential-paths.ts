export const BASE_EPHEMERAL_CRED_LINKS: ReadonlyArray<{ rel: string; kind: "dir" | "file" }> = [
  { rel: ".aws", kind: "dir" },
  { rel: ".netrc", kind: "file" },
  { rel: ".config/gh", kind: "dir" },
  { rel: ".config/glab", kind: "dir" },
  { rel: ".config/glab-cli", kind: "dir" },
  { rel: ".config/gcloud", kind: "dir" },
];

export const DURABLE_CREDENTIAL_PATHS = [".ssh", ".git-credentials"] as const;

export const DISPLACED_DIR_REL = ".agent-displaced";

export interface CredentialPathSpec {
  path: string;
  kind: "file" | "directory";
}

export const CREDENTIAL_PATH_RE = /^[A-Za-z0-9._/@+-]+$/;

export function builtInCredentialPaths(): CredentialPathSpec[] {
  return [
    ...BASE_EPHEMERAL_CRED_LINKS.map(({ rel, kind }) => ({
      path: rel,
      kind: kind === "dir" ? ("directory" as const) : ("file" as const),
    })),
    { path: ".ssh", kind: "directory" },
    { path: ".git-credentials", kind: "file" },
  ];
}
