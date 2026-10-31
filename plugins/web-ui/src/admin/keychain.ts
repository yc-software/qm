import { html, render } from "lit";
import { formatMessageTime } from "../message-time.ts";
import type { AdminPage } from "./sections.ts";
import { pageHeader, card, table, stacked, subline, matches } from "./shared.ts";

export function keychain(page: AdminPage, d: any) {
  const tabs = [
    { label: "Users", href: page.href("users") },
    { label: "Keychain", href: page.href("keychain"), active: true },
  ];
  if (d.enabled === false)
    return render(
      html`${pageHeader({ tabs })}${card(
        "Keychain unavailable",
        "Stable key material is required before the core can store keychain records.",
        html`<p class="empty">Keychain is not configured for this deployment.</p>`,
      )}`,
      page.host,
    );
  const [people, credentials, grants, asks] = [d.people || [], d.credentials || [], d.grants || [], d.asks || []];
  let filter = "";
  const personName = (id: string) => {
    const p = people.find((p: any) => p.principalId === id);
    return p?.displayName ? `${p.displayName} (${id})` : id;
  };
  const credName = (id: string) => {
    const c = credentials.find((c: any) => c.id === id);
    return c ? c.service + (c.accountLabel ? " - " + c.accountLabel : "") : id;
  };
  const mono = (primary: unknown, secondary: unknown) => ({ node: stacked(primary, secondary), cls: "mono" });
  const muted = (text: string) => ({ node: subline(text) });
  const expiry = (ts: number) =>
    !ts ? "No expiry" : (ts <= Date.now() ? "Expired " : "Expires ") + formatMessageTime(ts);
  const rows = (items: any[], text: (item: any) => unknown[], cells: (item: any) => unknown[]) =>
    items.filter((item) => matches(filter, ...text(item))).map(cells);
  function draw() {
    render(
      html`${pageHeader({
          tabs,
          count: `${people.length} people · ${credentials.length} credentials`,
          search: {
            value: filter,
            placeholder: "person, service, audience, purpose",
            onInput: (v) => ((filter = v), draw()),
          },
        })}
        <div class="list-root">
          ${card(
            "People",
            "Everyone known through sessions, admin grants, keychain records, grants, or asks.",
            table(
              ["Person", "Keychain", "Active grants", "Pending asks"],
              rows(
                people,
                (p) => [p.principalId, p.displayName || ""],
                (p) => [
                  {
                    node: html`<a href=${page.href("user", { principal: p.principalId })}
                      >${stacked(p.displayName || p.principalId, p.displayName ? p.principalId : "")}</a
                    >`,
                    cls: "mono",
                  },
                  ...[p.credentialCount, p.activeGrantCount, p.pendingAskCount].map((n) => ({
                    text: String(n || 0),
                    cls: "num",
                  })),
                ],
              ),
              "No people match.",
            ),
          )}${card(
            "Credentials",
            "Metadata only. Secret material and encrypted values are never returned to admin.",
            table(
              ["Owner", "Credential", "Delivery", "Account", "Expiry"],
              rows(
                credentials,
                (c) => [
                  c.ownerId,
                  personName(c.ownerId),
                  c.service,
                  c.kind,
                  c.envKey,
                  c.accountLabel,
                  c.host,
                  ...(c.targets || []),
                ],
                (c) => [
                  mono(personName(c.ownerId), c.ownerId),
                  mono(c.service, c.id),
                  muted([c.kind || "unknown", c.envKey, ...(c.targets || []).slice(0, 2)].filter(Boolean).join(" · ")),
                  c.accountLabel || c.host || "-",
                  { text: expiry(c.expiresAt), cls: "num" },
                ],
              ),
              "No keychain credentials match.",
            ),
          )}${card(
            "Grants",
            "Purpose-bound keychain grants from an owner to an audience scope.",
            table(
              ["Owner", "Credential", "Audience", "Mode", "Status", "Purpose"],
              rows(
                grants,
                (g) => [
                  g.ownerId,
                  personName(g.ownerId),
                  g.audienceScopeId,
                  g.mode,
                  g.status,
                  g.purpose,
                  credName(g.credentialId),
                ],
                (g) => [
                  mono(personName(g.ownerId), g.ownerId),
                  mono(credName(g.credentialId), g.credentialId),
                  { text: g.audienceScopeId, cls: "mono" },
                  muted(g.mode || "unknown"),
                  muted(
                    g.expiresAt && g.expiresAt <= Date.now() && g.status === "active"
                      ? "expired"
                      : g.status || "unknown",
                  ),
                  {
                    node: stacked(
                      g.purpose || "-",
                      (g.usedBy && "used by " + g.usedBy) || (g.askId && "ask " + g.askId) || "",
                    ),
                  },
                ],
              ),
              "No keychain grants match.",
            ),
          )}${card(
            "Asks",
            "Outstanding and resolved cross-conversation consent requests.",
            table(
              ["Owner", "Requester", "Credential", "Scope", "Status", "Purpose"],
              rows(
                asks,
                (a) => [
                  a.ownerId,
                  personName(a.ownerId),
                  a.requesterId,
                  personName(a.requesterId),
                  a.requesterScopeId,
                  a.status,
                  a.purpose,
                  credName(a.credentialId),
                ],
                (a) => [
                  mono(personName(a.ownerId), a.ownerId),
                  mono(personName(a.requesterId), a.requesterId),
                  mono(credName(a.credentialId), a.credentialId),
                  { text: a.requesterScopeId, cls: "mono" },
                  muted(a.status || "unknown"),
                  { node: stacked(a.purpose || "-", a.expiresAt ? expiry(a.expiresAt) : "") },
                ],
              ),
              "No keychain asks match.",
            ),
          )}
        </div>`,
      page.host,
    );
  }
  draw();
}
