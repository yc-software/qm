import { html, nothing } from "lit";
import { card, table, renderer } from "./shared.ts";

export function keychain(root: HTMLElement, d: any, s: Record<string, any>) {
  const paint = renderer(root);
  if (d.enabled === false) {
    paint(
      card(
        "Keychain unavailable",
        "Stable key material is required before the core can store keychain records.",
        html`<p class="empty">Keychain is not configured for this deployment.</p>`,
      ),
    );
    return;
  }
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
  const matches = (parts: any[]) => parts.join(" ").toLowerCase().includes(filter.trim().toLowerCase());
  const stacked = (primary: any, secondary: any, cls?: string) => ({
    node: html`<div>
      <div class="primaryline">${primary}</div>
      ${secondary ? html`<div class="subline">${secondary}</div>` : nothing}
    </div>`,
    cls,
  });
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
              .filter((p: any) => matches([p.principalId, p.displayName || ""]))
              .map((p: any) => [
                stacked(p.displayName || p.principalId, p.displayName ? p.principalId : "", "mono"),
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
                matches([
                  c.ownerId,
                  personName(c.ownerId),
                  c.service,
                  c.kind,
                  c.envKey || "",
                  c.accountLabel || "",
                  c.host || "",
                  (c.targets || []).join(" "),
                ]),
              )
              .map((c: any) => [
                stacked(personName(c.ownerId), c.ownerId, "mono"),
                stacked(c.service, c.id, "mono"),
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
                matches([
                  g.ownerId,
                  personName(g.ownerId),
                  g.audienceScopeId,
                  g.mode,
                  g.status,
                  g.purpose,
                  credName(g.credentialId),
                ]),
              )
              .map((g: any) => {
                const expired = g.expiresAt && g.expiresAt <= Date.now() && g.status === "active";
                let tone = g.status === "revoked" ? "err" : "";
                if (expired) tone = "warn";
                let purposeDetail = g.askId ? "ask " + g.askId : "";
                if (g.usedBy) purposeDetail = "used by " + g.usedBy;
                return [
                  stacked(personName(g.ownerId), g.ownerId, "mono"),
                  stacked(credName(g.credentialId), g.credentialId, "mono"),
                  stacked(g.audienceScopeId, s.scopeKind(g.audienceScopeId), "mono"),
                  muted(g.mode || "unknown"),
                  muted(expired ? "expired" : g.status || "unknown", tone),
                  stacked(g.purpose || "-", purposeDetail),
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
                matches([
                  a.ownerId,
                  personName(a.ownerId),
                  a.requesterId,
                  personName(a.requesterId),
                  a.requesterScopeId,
                  a.status,
                  a.purpose,
                  credName(a.credentialId),
                ]),
              )
              .map((a: any) => [
                stacked(personName(a.ownerId), a.ownerId, "mono"),
                stacked(personName(a.requesterId), a.requesterId, "mono"),
                stacked(credName(a.credentialId), a.credentialId, "mono"),
                stacked(a.requesterScopeId, s.scopeKind(a.requesterScopeId), "mono"),
                muted(a.status || "unknown", a.status === "pending" ? "warn" : ""),
                stacked(a.purpose || "-", a.expiresAt ? expiry(a.expiresAt) : ""),
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
