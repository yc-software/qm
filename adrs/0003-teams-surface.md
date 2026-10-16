# ADR-0003: Microsoft Teams as a surface

**Status:** Proposed — asking for scope alignment before any implementation
**Date:** 2026-08-02

## Context

Slack is currently the only chat surface. Organizations standardized on Microsoft
365 cannot adopt QM where their work already happens, so for those orgs the web UI
is the whole product and the collaborative half — channels, group messages, shared
project scopes — is unavailable.

This is a scope question before it is an engineering one. The README describes QM
as designed for startups, who skew Slack, so Teams may be deliberately out of
scope. That answer is worth having recorded either way.

## Decision

If Teams is in scope: build on the **Microsoft 365 Agents SDK**, which has a
JavaScript/TypeScript client. The Bot Framework SDK it supersedes was archived in
December 2025 and is no longer maintained, so it is not a viable base for new
work, and the TeamsFx SDK is in deprecation with community-only support through
September 2026.

Add Teams as a second in-process surface plugin alongside Slack rather than
generalizing the Slack plugin first. The surfaces already share the core HTTP API,
and an abstraction drawn from one implementation tends to fit only that
implementation; a second concrete surface is what shows where the real seam is.
`plugins/chassis` is the natural home for anything that turns out to be genuinely
shared.

## Registration model — this fits QM better than it first appears

An Azure Bot resource is still required as the channel registration: the Teams
channel is enabled on it, and its client ID goes in the Teams app manifest
alongside the bot's public domain.

Azure has deprecated the multi-tenant bot type — new registrations must be
single-tenant or use a user-assigned managed identity. That constraint aligns with
QM's deployment model rather than fighting it. Every deployment already runs in
the operator's own cloud account, so each operator registers their own bot in
their own tenant, exactly as they already own their Slack app, their infrastructure
and their secrets. No shared multi-tenant registration is needed, and the
`qm init` flow that already scaffolds provider credentials is the natural place to
generate the manifest.

## Scale, honestly

The Slack plugin is roughly 7,000 lines across ~40 modules — approvals, cards,
deliveries, identity, attachments, directives, emoji, conversation views. Teams
parity is that order of work, plus app-manifest packaging and tenant admin consent
before anyone can install it.

Adaptive Cards cover the approval surface, but their interaction and update model
differs from Slack Block Kit enough that approvals need their own design rather
than a port — approval cards, deferred acks, and the delivery/edit path are where
the real work is, not message plumbing.

## Consequences

- A second surface at parity is a project, not a feature, and it doubles the
  surface area for every future change to approvals or delivery.
- Tenant admin consent puts an org-level gate in front of installation that Slack
  does not have, which affects onboarding, not just the plugin.
- The Agents SDK is Microsoft's active line but a young one; the surface-plugin
  boundary keeps that churn out of core.
- Done second, it likely reveals which parts of the Slack plugin belong in
  `plugins/chassis`.

## Open question

Is Teams on the roadmap, and would you take it as a contribution? If it is out of
scope by design, that is a useful thing for this folder to say.
