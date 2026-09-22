import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { errMessage } from "../../chassis/src/errors";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";

interface Credential {
  id: string;
  ownerId: string;
  service: string;
  accountLabel?: string;
  kind: string;
  host?: string;
  fields: string[];
  disabledReason?: string;
}
interface Binding {
  credentialId: string;
  ownerId: string;
  host: string;
  allowedMethods: string[];
  allowedPathPrefixes: string[];
  headers: Array<{ name: string; field?: string; scheme?: string }>;
}
interface CredentialsResponse {
  credentials: Credential[];
  credentialBindings: Binding[];
  revision: string | null;
}
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const HEADERS = [
  "Authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-token-id",
  "x-token-secret",
];

export function createDeploymentCredentials(input: {
  id: string;
  title: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  changed: () => void;
  isCurrent: () => boolean;
}) {
  const endpoint = `/api/deployments/${encodeURIComponent(input.id)}/credentials`;
  let data: CredentialsResponse | null = null;
  let busy = false;
  let error = "";
  let sequence = 0;
  let modal: "connect" | "revoke" | null = null;
  let draft: Binding | null = null;
  let revoke: Binding | null = null;
  let confirmed = false;
  let opener: HTMLElement | null = null;
  const draw = () => {
    if (input.isCurrent()) input.changed();
  };
  const bound = (id: string) => data?.credentialBindings.some((binding) => binding.credentialId === id);
  const label = (id: string) => {
    const credential = data?.credentials.find((item) => item.id === id);
    return credential
      ? `${credential.service}${credential.accountLabel ? ` · ${credential.accountLabel}` : ""}`
      : `Unavailable credential (${id})`;
  };
  const selectionReason = (credential: Credential) =>
    credential.disabledReason || (bound(credential.id) ? "Already connected" : "");
  const select = (id: string) => {
    const credential = data?.credentials.find((item) => item.id === id);
    if (!credential || selectionReason(credential)) {
      draft = null;
      return;
    }
    draft = {
      credentialId: credential.id,
      ownerId: credential.ownerId,
      host: credential.host?.toLowerCase() ?? "",
      allowedMethods: ["GET"],
      allowedPathPrefixes: ["/"],
      headers: [{ name: "Authorization", field: credential.fields[0], scheme: "Bearer" }],
    };
    confirmed = false;
  };
  const close = () => {
    modal = null;
    draft = null;
    revoke = null;
    confirmed = false;
    draw();
    requestAnimationFrame(() => {
      if (input.isCurrent() && !modal)
        restoreDialogFocus(opener, () => document.querySelector<HTMLElement>(".deploy-credential-connect"));
    });
  };
  const open = (binding?: Binding) => {
    if (busy || !data) return;
    opener = document.activeElement as HTMLElement | null;
    error = "";
    confirmed = false;
    revoke = binding ?? null;
    modal = binding ? "revoke" : "connect";
    if (!binding) select(data.credentials.find((credential) => !selectionReason(credential))?.id ?? "");
    draw();
    requestAnimationFrame(() => {
      if (input.isCurrent() && modal) focusDialogCancel(document);
    });
  };
  const load = async () => {
    const current = ++sequence;
    busy = true;
    draw();
    try {
      const result = await input.request<CredentialsResponse>(endpoint);
      if (current !== sequence || !input.isCurrent()) return;
      data = result;
    } catch (e) {
      if (current !== sequence || !input.isCurrent()) return;
      data = null;
      error = errMessage(e, "Could not load credentials.");
    } finally {
      if (current === sequence && input.isCurrent()) {
        busy = false;
        draw();
      }
    }
  };
  const save = async () => {
    if (busy || !data || !modal || (modal === "connect" && (!draft || !confirmed))) return;
    const action = modal;
    const payload = action === "connect" ? { binding: draft } : { credentialId: revoke!.credentialId };
    busy = true;
    error = "";
    draw();
    try {
      await input.request(endpoint, {
        method: "POST",
        body: JSON.stringify({ action, expectedRevision: data.revision, ...payload }),
      });
      if (!input.isCurrent()) return;
      close();
      await load();
    } catch (e) {
      if (!input.isCurrent()) return;
      error = errMessage(e, "Could not update credentials.");
      if (e && typeof e === "object" && "status" in e && e.status === 409) {
        close();
        await load();
      }
    } finally {
      if (input.isCurrent()) {
        busy = false;
        draw();
      }
    }
  };
  const changedDraft = () => {
    confirmed = false;
    draw();
  };
  const routing = (binding: Binding) =>
    html`<div class="deploy-credential-routing">
      <code>${binding.host}</code><span>${binding.allowedMethods.join(", ")}</span
      ><span>${binding.allowedPathPrefixes.join(", ")}</span>
    </div>`;
  return {
    load,
    isDialogOpen: () => modal !== null,
    section: () =>
      html`<section class="deploy-detail-section deploy-credentials">
        <div class="deploy-credentials-heading">
          <h3>Credentials</h3>
          <button class="btn deploy-credential-connect" type="button" ?disabled=${busy || !data} @click=${() => open()}>
            Connect saved key
          </button>
        </div>
        <p class="hint">API keys from your keychain, approved for this app only. Secrets stay in the broker.</p>
        ${error && !modal ? html`<div class="status" role="alert">${error}</div>` : nothing}
        ${busy ? html`<p class="hint" role="status">Loading credentials…</p>` : nothing}
        ${
          !data && !busy
            ? html`<button
                class="btn"
                type="button"
                @click=${() => {
                  error = "";
                  void load();
                }}
              >
                Retry
              </button>`
            : nothing
        }
        ${
          data?.credentialBindings.length
            ? data.credentialBindings.map(
                (binding) =>
                  html`<div class="deploy-setting-row deploy-credential-row">
                    <div>
                      <strong>${label(binding.credentialId)}</strong
                      ><span>Owner: ${binding.ownerId}</span
                      >${routing(binding)}${data?.credentials.find((credential) => credential.id === binding.credentialId)?.disabledReason ? html`<span>${data.credentials.find((credential) => credential.id === binding.credentialId)!.disabledReason}</span>` : nothing}
                    </div>
                    <button class="btn danger" type="button" ?disabled=${busy} @click=${() => open(binding)}>
                      Revoke
                    </button>
                  </div>`,
              )
            : nothing
        }
        ${data && !data.credentialBindings.length ? html`<p class="hint">No credentials connected.</p>` : nothing}
      </section>`,
    dialog: () => {
      if (!modal) return nothing;
      const credential = data?.credentials.find((item) => item.id === draft?.credentialId);
      return html`<div
        class="project-dialog-backdrop"
        @click=${(event: MouseEvent) => event.target === event.currentTarget && close()}
      >
        <div
          class="project-dialog deploy-credential-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="deploy-credential-title"
          @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, close)}
        >
          <div class="project-dialog-head">
            <h2 id="deploy-credential-title">${modal === "revoke" ? "Revoke credential" : "Connect saved key"}</h2>
          </div>
          ${error ? html`<div class="status" role="alert">${error}</div>` : nothing}
          ${
            modal === "revoke"
              ? html`<p>Revoke ${label(revoke!.credentialId)} from ${input.title}?</p>
                  <p class="hint">
                    Future requests will stop using this key immediately, without a redeploy. Other connections and your
                    saved key are unchanged. In-flight requests cannot be recalled.
                  </p>
                  ${routing(revoke!)}`
              : html` <form
                  id="deploy-credential-form"
                  @submit=${(event: SubmitEvent) => {
                    event.preventDefault();
                    void save();
                  }}
                >
                  <fieldset ?disabled=${busy} class="deploy-credential-fields">
                    <label
                      >Saved key<select
                        .value=${draft?.credentialId ?? ""}
                        @change=${(event: Event) => {
                          select((event.target as HTMLSelectElement).value);
                          draw();
                        }}
                      >
                        <option value="" ?selected=${!draft} disabled>Select a saved key</option>
                        ${data?.credentials.map((item) => html`<option value=${item.id} ?selected=${draft?.credentialId === item.id} ?disabled=${Boolean(selectionReason(item))}>${label(item.id)} · ${item.ownerId}${selectionReason(item) ? ` — ${selectionReason(item)}` : ""}</option>`)}
                      </select></label
                    >
                    ${!data?.credentials.length ? html`<p class="hint">No saved credentials. Add an API key in your keychain first.</p>` : nothing}
                    ${
                      draft && credential
                        ? html`
                            <p class="hint">
                              Owner: ${credential.ownerId}. ${credential.accountLabel ?? credential.service}
                            </p>
                            <label
                              >Exact host<input
                                required
                                placeholder="api.example.com"
                                .value=${live(draft.host)}
                                ?readonly=${Boolean(credential.host)}
                                @input=${(event: InputEvent) => {
                                  draft!.host = (event.target as HTMLInputElement).value;
                                  changedDraft();
                                }}
                            /></label>
                            <p class="hint">
                              ${credential.host ? "This host is fixed by your saved credential." : "HTTPS hostname only. No scheme, port, or wildcards."}
                            </p>
                            <fieldset class="deploy-credential-methods">
                              <legend>Allowed methods</legend>
                              ${METHODS.map(
                                (method) =>
                                  html`<label
                                    ><input
                                      type="checkbox"
                                      .checked=${draft!.allowedMethods.includes(method)}
                                      @change=${(event: Event) => {
                                        draft!.allowedMethods = METHODS.filter((value) =>
                                          value === method
                                            ? (event.target as HTMLInputElement).checked
                                            : draft!.allowedMethods.includes(value),
                                        );
                                        changedDraft();
                                      }}
                                    />${method}</label
                                  >`,
                              )}
                            </fieldset>
                            <label
                              >Allowed paths<textarea
                                required
                                rows="2"
                                .value=${live(draft.allowedPathPrefixes.join("\n"))}
                                @input=${(event: InputEvent) => {
                                  draft!.allowedPathPrefixes = (event.target as HTMLTextAreaElement).value.split("\n");
                                  changedDraft();
                                }}
                              ></textarea>
                            </label>
                            <p class="hint">
                              One prefix per line. / allows all paths. /v1/data allows that path and its descendants.
                            </p>
                            <details class="deploy-credential-headers">
                              <summary>Authentication headers</summary>
                              ${draft.headers.map(
                                (header, index) =>
                                  html`<div class="deploy-credential-header">
                                    <label
                                      >Header<select
                                        .value=${header.name}
                                        @change=${(event: Event) => {
                                          header.name = (event.target as HTMLSelectElement).value;
                                          changedDraft();
                                        }}
                                      >
                                        ${HEADERS.map((name) => html`<option value=${name} ?selected=${header.name === name}>${name}</option>`)}
                                      </select></label
                                    ><label
                                      >Saved field<select
                                        .value=${header.field ?? credential.fields[0] ?? ""}
                                        @change=${(event: Event) => {
                                          header.field = (event.target as HTMLSelectElement).value;
                                          changedDraft();
                                        }}
                                      >
                                        ${credential.fields.map((field) => html`<option value=${field} ?selected=${(header.field ?? credential.fields[0]) === field}>${field}</option>`)}
                                      </select></label
                                    ><label
                                      >Prefix<input
                                        placeholder="None"
                                        .value=${live(header.scheme ?? "")}
                                        @input=${(event: InputEvent) => {
                                          header.scheme = (event.target as HTMLInputElement).value;
                                          changedDraft();
                                        }} /></label
                                    ><button
                                      class="btn"
                                      type="button"
                                      ?disabled=${draft!.headers.length === 1}
                                      @click=${() => {
                                        draft!.headers.splice(index, 1);
                                        changedDraft();
                                      }}
                                    >
                                      Remove
                                    </button>
                                  </div>`,
                              )}
                              <button
                                class="btn"
                                type="button"
                                ?disabled=${draft.headers.length >= credential.fields.length || draft.headers.length >= HEADERS.length}
                                @click=${() => {
                                  draft!.headers.push({
                                    name: HEADERS.find(
                                      (name) =>
                                        !draft!.headers.some(
                                          (header) => header.name.toLowerCase() === name.toLowerCase(),
                                        ),
                                    )!,
                                    field: credential.fields.find(
                                      (field) => !draft!.headers.some((header) => header.field === field),
                                    ),
                                    scheme: "",
                                  });
                                  changedDraft();
                                }}
                              >
                                Add header
                              </button>
                            </details>
                            <p class="hint">
                              ${draft.headers.map((header) => `${header.name}: ${header.scheme ? `${header.scheme} ` : ""}[${header.field}]`).join("; ")}
                            </p>
                            <label class="deploy-credential-confirm"
                              ><input
                                type="checkbox"
                                .checked=${confirmed}
                                @change=${(event: Event) => {
                                  confirmed = (event.target as HTMLInputElement).checked;
                                  draw();
                                }}
                              /><span
                                >I approve this access for ${input.title}. App viewers can see returned data, and app
                                managers can change the code that uses this key.</span
                              ></label
                            >
                          `
                        : nothing
                    }
                  </fieldset>
                </form>`
          }
          <div class="project-dialog-actions actions">
            <button class="btn" type="button" data-dialog-cancel @click=${close}>Cancel</button
            >${modal === "revoke" ? html`<button class="btn danger" type="button" ?disabled=${busy} @click=${() => void save()}>${busy ? "Revoking…" : "Revoke"}</button>` : html`<button class="btn primary" type="submit" form="deploy-credential-form" ?disabled=${busy || !confirmed || !draft?.allowedMethods.length}>${busy ? "Connecting…" : "Connect key"}</button>`}
          </div>
        </div>
      </div>`;
    },
  };
}
