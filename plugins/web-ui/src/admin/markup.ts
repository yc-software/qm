export const ADMIN_MARKUP = `
<div class="admin-main">
<div class="admin-inner">
  <div class="header-controls" id="header-controls" aria-label="Page controls"></div>
  <div class="shellbar" id="shellbar"></div>

  <div id="view-onboarding" class="hidden">
    <div class="setup-head">
      <p class="governance-eyebrow">Temporary setup guide</p>
      <h1>Onboarding</h1>
      <p class="lead">
        Get this deployment ready for real conversations. Secrets are validated, encrypted in durable storage,
        and never displayed again.
      </p>
    </div>
    <template data-onboarding-ui="steps"></template>
    <template data-onboarding-ui="provider"></template>
    <template data-onboarding-ui="registry"></template>
    <section class="card">
      <div class="head">
        <h2>Custom providers</h2>
        <p>
          Point the deployment at any OpenAI- or Anthropic-compatible endpoint: a vendor like DeepSeek, or a
          gateway like LiteLLM fronting many models. Keys are validated, stored write-only, and the models join
          the picker.
        </p>
      </div>
      <div class="body">
        <table class="table" id="custom-provider-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Protocol</th>
              <th>Endpoint</th>
              <th>Models</th>
              <th>Key</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="custom-provider-rows"></tbody>
        </table>
        <p class="muted" id="custom-provider-empty" hidden>No custom providers registered.</p>
      </div>
      <div class="foot">
        <button type="button" id="onboarding-add-custom-provider">+ Add provider</button>
      </div>
    </section>
  </div>

  <div id="view-governance">
    <p id="governance-loading" class="hint hidden" role="status">Loading settings…</p>
    <aside class="environment-notice admin-notice hidden" id="environment-notice" role="status">
      <div>
        <strong id="environment-notice-title"></strong>
        <p id="environment-notice-detail"></p>
      </div>
      <button type="button" id="environment-notice-open">Open environment</button>
    </aside>
    <section class="governance-overview" id="governance-overview" aria-labelledby="governance-overview-title">
      <div class="governance-overview-head">
        <h2 id="governance-overview-title">Effective state</h2>
        <p>Resolved for this scope now</p>
      </div>
      <div class="governance-status-grid">
        <div class="governance-status" id="governance-status-posture">
          <span class="k">Autonomy</span><span class="v">Loading</span
          ><span class="detail">Security posture</span>
        </div>
        <div class="governance-status" id="governance-status-sharing">
          <span class="k">Sharing</span><span class="v">Loading</span
          ><span class="detail">Cross-context reads</span>
        </div>
        <div class="governance-status" id="governance-status-egress">
          <span class="k">Network</span><span class="v">Loading</span
          ><span class="detail">Outbound enforcement</span>
        </div>
        <div class="governance-status" id="governance-status-audience">
          <span class="k">Slack audience</span><span class="v">Loading</span
          ><span class="detail">External participants</span>
        </div>
        <div class="governance-status" id="governance-status-model">
          <span class="k">Intelligence</span><span class="v">Loading</span
          ><span class="detail">Base model</span>
        </div>
      </div>
    </section>
    <div class="governance-layout">
      <nav class="governance-sections" aria-label="Governance sections">
        <a href="#governance-autonomy" aria-current="true">Autonomy</a>
        <a href="#governance-boundaries">Data boundaries</a>
        <a href="#governance-intelligence">Models &amp; browsing</a>
        <a href="#governance-credentials">Credentials</a>
      </nav>
      <div class="governance-content">
        <div class="governance-group" id="governance-autonomy">
          <h2>Autonomy</h2>
          <p>How agents reason, act, and respond without supervision.</p>
        </div>
        <template data-governance-card="card-security-posture"></template>
        <template data-governance-card="card-auto-flagger"></template>
        <template data-governance-card="card-approval-grant-modes"></template>
        <template data-governance-card="card-command-policy"></template>
        <template data-settings-card="card-soul"></template>
        <template data-governance-card="card-ambient-policy"></template>
        <div class="governance-group" id="governance-boundaries">
          <h2>Data boundaries</h2>
          <p>What can leave a scope, which audiences can see it, and how deployment authority is carried.</p>
        </div>
        <template data-governance-card="card-sharing-posture"></template>
        <template data-governance-card="card-egress"></template>
        <template data-integrations-card="card-external-slack"></template>
        <template data-integrations-card="card-channel-header-pin-default"></template>
        <template data-integrations-card="card-ack-emoji"></template>
        <div class="governance-group" id="governance-intelligence">
          <h2>Models &amp; browsing</h2>
          <p>The models, browser runtime, and organization context available on future turns.</p>
        </div>
        <template data-settings-card="card-runtimes"></template>
        <template data-settings-card="card-webui-models"></template>
        <template data-settings-card="card-branding"></template>
        <template data-settings-card="card-feature-flags"></template>
        <template data-settings-card="card-decisions"></template>
        <div class="governance-group" id="governance-credentials">
          <h2>Credentials</h2>
          <p>Shared server-side authority available to agents in this organization.</p>
        </div>
        <template data-settings-card="card-service-credentials"></template>
      </div>
    </div>
  </div>

  <div id="view-connectors" class="hidden">
    <template data-integrations-card="card-connectors"></template>
    <template data-integrations-card="card-slack-installation"></template>
  </div>

  <div id="view-data" class="hidden"></div>
</div>
</div>
<dialog class="review-dialog policy-test-dialog" id="policy-test-dialog" aria-labelledby="policy-test-title">
  <div class="review-dialog-head">
    <h2 id="policy-test-title">Test a command</h2>
  </div>
  <div class="review-dialog-body">
    <label for="policy-sample"
      >Command<input
        type="text"
        id="policy-sample"
        placeholder="git push --force origin main"
        autocomplete="off"
        spellcheck="false"
    /></label>
    <div class="policy-result" id="policy-result" aria-live="polite">
      Enter a sample command to test the scope policy.
    </div>
  </div>
  <div class="review-dialog-foot">
    <button type="button" id="policy-test-close">Close</button
    ><button id="policy-simulate" class="primary" type="button">Test command</button>
  </div>
</dialog>

<dialog class="review-dialog" id="governance-review" aria-labelledby="governance-review-title">
  <div class="review-dialog-head">
    <p class="governance-eyebrow">Review change</p>
    <h2 id="governance-review-title">Confirm governance change</h2>
    <p id="governance-review-subtitle"></p>
  </div>
  <div class="review-dialog-body">
    <dl class="review-dialog-facts" id="governance-review-facts"></dl>
    <p class="review-dialog-warning admin-notice" id="governance-review-warning"></p>
  </div>
  <div class="review-dialog-foot">
    <button type="button" id="governance-review-cancel">Cancel</button
    ><button type="button" class="review-dialog-confirm" id="governance-review-confirm">Confirm change</button>
  </div>
</dialog>

<template data-settings-card="custom-provider-dialog"></template>
`;
