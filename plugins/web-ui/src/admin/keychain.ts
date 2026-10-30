import { html } from "lit";
import { card, table, renderer, stacked, matches } from "./shared.ts";

export function keychain(root: HTMLElement, d: any, s: Record<string, any>) {
  const paint = renderer(root);
  if (d.enabled === false)
    return paint(
      card(
        "Keychain unavailable",
        "Stable key material is required before the core can store keychain records.",
        html`<p class="empty">Keychain is not configured for this deployment.</p>`,
      ),
    );
  const people = d.people || [],
    credentials = d.credentials || [],
    grants = d.grants || [],
    asks = d.asks || [];
  let filter = "";
  const personName = (id: string) => {
    const p = people.find((p: any) => p.principalId === id);
    return p?.displayName ? `${p.displayName} (${id})` : id;
  };
  const credName = (id: string) => {
    const c = credentials.find((c: any) => c.id === id);
    return c ? c.service + (c.accountLabel ? " - " + c.accountLabel : "") : id;
  };
  const hit = (...parts: unknown[]) => matches(filter, ...parts);
  const mono = (primary: unknown, secondary: unknown) => ({ node: stacked(primary, secondary), cls: "mono" });
  const muted = (text: string, tone = "") => ({
    node: html`<span class=${({ err: "flag-err", warn: "flag-warn" } as Record<string, string>)[tone] || "subline"}
      >${text}</span
    >`,
  });
  const expiry = (ts: number) => (!ts ? "No expiry" : (ts <= Date.now() ? "Expired " : "Expires ") + s.fmtTime(ts));
  function draw() {
    paint(
      html`<div class="list-root">
        ${card(
          "People",
          "Everyone known through sessions, admin grants, keychain records, grants, or asks.",
          table(
            ["Person", "Keychain", "Active grants", "Pending asks"],
            people
              .filter((p: any) => hit(p.principalId, p.displayName || ""))
              .map((p: any) => [
                mono(p.displayName || p.principalId, p.displayName ? p.principalId : ""),
                ...[p.credentialCount, p.activeGrantCount].map((n) => ({
                  action: {
                    label: String(n || 0),
                    title: "Open this person's credentials and grants",
                    run: () => s.openUser(p.principalId),
                  },
                })),
                { text: String(p.pendingAskCount || 0), cls: "num" },
              ]),
            "No people match.",
          ),
        )}${card(
          "Credentials",
          "Metadata only. Secret material and encrypted values are never returned to admin.",
          table(
            ["Owner", "Credential", "Delivery", "Account", "Expiry"],
            credentials
              .filter((c: any) =>
                hit(
                  c.ownerId,
                  personName(c.ownerId),
                  c.service,
                  c.kind,
                  c.envKey || "",
                  c.accountLabel || "",
                  c.host || "",
                  (c.targets || []).join(" "),
                ),
              )
              .map((c: any) => [
                mono(personName(c.ownerId), c.ownerId),
                mono(c.service, c.id),
                muted([c.kind || "unknown", c.envKey, ...(c.targets || []).slice(0, 2)].filter(Boolean).join(" · ")),
                c.accountLabel || c.host || "-",
                { text: expiry(c.expiresAt), cls: "num" },
              ]),
            "No keychain credentials match.",
          ),
        )}${card(
          "Grants",
          "Purpose-bound keychain grants from an owner to an audience scope.",
          table(
            ["Owner", "Credential", "Audience", "Mode", "Status", "Purpose"],
            grants
              .filter((g: any) =>
                hit(
                  g.ownerId,
                  personName(g.ownerId),
                  g.audienceScopeId,
                  g.mode,
                  g.status,
                  g.purpose,
                  credName(g.credentialId),
                ),
              )
              .map((g: any) => {
                const expired = g.expiresAt && g.expiresAt <= Date.now() && g.status === "active";
                return [
                  mono(personName(g.ownerId), g.ownerId),
                  mono(credName(g.credentialId), g.credentialId),
                  mono(g.audienceScopeId, s.scopeKind(g.audienceScopeId)),
                  muted(g.mode || "unknown"),
                  muted(
                    expired ? "expired" : g.status || "unknown",
                    (expired && "warn") || (g.status === "revoked" && "err") || "",
                  ),
                  {
                    node: stacked(
                      g.purpose || "-",
                      (g.usedBy && "used by " + g.usedBy) || (g.askId && "ask " + g.askId) || "",
                    ),
                  },
                ];
              }),
            "No keychain grants match.",
          ),
        )}${card(
          "Asks",
          "Outstanding and resolved cross-conversation consent requests.",
          table(
            ["Owner", "Requester", "Credential", "Scope", "Status", "Purpose"],
            asks
              .filter((a: any) =>
                hit(
                  a.ownerId,
                  personName(a.ownerId),
                  a.requesterId,
                  personName(a.requesterId),
                  a.requesterScopeId,
                  a.status,
                  a.purpose,
                  credName(a.credentialId),
                ),
              )
              .map((a: any) => [
                mono(personName(a.ownerId), a.ownerId),
                mono(personName(a.requesterId), a.requesterId),
                mono(credName(a.credentialId), a.credentialId),
                mono(a.requesterScopeId, s.scopeKind(a.requesterScopeId)),
                muted(a.status || "unknown", a.status === "pending" ? "warn" : ""),
                { node: stacked(a.purpose || "-", a.expiresAt ? expiry(a.expiresAt) : "") },
              ]),
            "No keychain asks match.",
          ),
        )}
      </div>`,
    );
  }
  s.defaultShell({
    stats: [
      [people.length, "People"],
      [credentials.length, "Credentials"],
      [
        grants.filter((g: any) => g.status === "active" && (!g.expiresAt || g.expiresAt > Date.now())).length,
        "Active grants",
      ],
      [asks.filter((a: any) => a.status === "pending").length, "Pending asks"],
    ],
    search: {
      placeholder: "person, service, audience, purpose",
      onInput: (value: string) => {
        filter = value;
        draw();
      },
    },
  });
  draw();
}
