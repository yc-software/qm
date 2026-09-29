# Live browser performance qualification

This suite measures user-visible content and controls through the real portal, web/admin services, core and database. It uses a fresh, isolated Playwright browser; it never attaches to an existing Chrome session. It makes no API-response mocks. Local UI-state setup selects a known empty or maximum-tab/four-pane layout before navigation. Screenshots and result files stay outside Git.

The fixed target is a median strictly below **1000 ms for every catalog cell**. A cell is one flow, cache state and load condition. Each qualifying cell needs at least 31 observations and an exact one-sided median confidence bound below 1000 ms. Bonferroni correction makes those bounds simultaneous at 95% confidence across the run. Failures, timeouts and unsupported fixtures fail the cell; there are no replacement retries. The suite retains p95 and every raw observation.

Cold means a new browser context with no HTTP cache. Warm means a completed initial navigation followed by a reload with that context's cache retained. Sidebar, pagination, overlays and tab-switch cases measure the actual interaction after its prerequisite page has loaded. These are browser-cache conditions, not a claim that the database or every process cache is cold. A fresh-server or expired-cache campaign needs separate independently observed environment conditions. Model generation completion is not a page-load boundary.

The catalog contains 60 scenarios and 109 cache cells per load condition. Web coverage includes Projects (`/contexts`), Crons, Webhooks, Loops, Inbox, Files, Keychain, Apps (`/apps`), Memory and Skills, as well as the existing chat, sidebar, search, settings and split-view flows. Legacy and mixed transcripts have cold and warm cases. Calendar is explicitly excluded because its implemented view is only the static “Coming soon.” placeholder.

Disabled crons remain inert. Their initial page must display the observed disabled count and a usable “Show disabled” control; a separate warm action measures revealing their actual titled rows. The attachment action selects a small synthetic text file through the real composer file input, waits for its filename and an editable composer, and rejects pending preparation or errors. Each sample uses a fresh browser context, prepares only the chat, and stages its first file during measurement, so the document importer can still be cold. The case does not send the attachment or claim upload/download performance.

Memory navigation requires the exact API-observed notebook in its editable raw textarea and no loading status. A separate warm action clicks “Facts view” and requires the observed fact count, fact text, and search control. Interactive samples clear preparation resource timings and long tasks immediately before the measured action.

## Run

Use Node 24 or later. The scoped browser dependency is pinned separately from product dependencies.

```sh
npm install --prefix test/performance
npm exec --prefix test/performance -- playwright install chromium
node --test test/performance/harness.test.mjs
node test/performance/run.mjs /absolute/private/run-config.json --list
node test/performance/run.mjs /absolute/private/run-config.json
```

Use a new output directory for every run. `--list` prints the exact scenario catalog and missing fixture prerequisites without launching a browser. It reads the fixture and measured usage profile locally. No YC usage data belongs in this directory.

The run configuration is private, for example:

```json
{
  "baseUrl": "https://performance.example.invalid",
  "isolated": true,
  "mode": "qualifying",
  "sourceRevision": "0000000000000000000000000000000000000000",
  "fixturePath": "fixture.json",
  "profilePath": "usage-profile.json",
  "envelopePath": "environment.json",
  "workloadPath": "workload-summary.json",
  "producerPath": "producer-summary.json",
  "outDir": "results/candidate-normal-1",
  "loadCondition": "normal",
  "samples": 31,
  "orderSeed": 7349,
  "timeoutMs": 15000,
  "authStates": {
    "fixture-user@example.invalid": "auth/user.json"
  },
  "adminAuthState": "auth/admin.json",
  "browser": {
    "viewport": { "width": 1440, "height": 1000 },
    "cpuThrottleRate": 1,
    "network": {
      "latencyMs": 40,
      "downloadBytesPerSecond": 12500000,
      "uploadBytesPerSecond": 2500000
    }
  }
}
```

Those network values are illustrative. Set them from the client envelope being qualified. The observed browser version is recorded. Set `browser.maxPanels` and `browser.visibleGroups` in the fixture manifest when the measured layout envelope differs from the defaults of twelve tabs and four visible groups. Use the same hardware, browser, budgets and order seeds for baseline and candidate. Playwright's per-page throttling does not prove a multi-connection WAN or a particular device CPU; the parity evidence must state what was actually reproduced. A browser physically outside the service's region supplies evidence that same-host loopback cannot.

Paths resolve relative to the configuration file. When the seeder used several aggregate exports, use `profilePaths: ["usage-profile.json", "usage-profile-extra.json"]` in the same order; the hash covers the canonical array of parsed profiles. `authStates` contains isolated fixture authentication states for every tested principal; no production cookies are accepted by this workflow. A localhost development bypass may use `localAuthPrincipal`, which only supplies that one principal's cases. Missing principals fail instead of testing every user as the same administrator. `executablePath` may select an isolated test-browser binary; persistent user profiles and CDP attachment are rejected.

`producerPath` supplies the private real-turn producer summary. The runner retains it as `producer.json` beside `workload.json` and passes both to verification. Diagnostics may omit producer evidence; qualification requires independently verified productive-workload evidence.

For development, use `mode: "diagnostic"`, fewer samples, and optionally `filter: "^web\\.chat\\.long$"` or `cacheFilter: "cold"`. Diagnostics retain threshold and confidence results, so a small sample may exit nonzero as inconclusive. They can never qualify. A full qualification cannot filter out slow or unsupported flows.

## Fixture readiness contract

The fixture manifest names its `fixtureId`, measured `profileSha256`, `scale`, `qualified`, and requested/verified table counts. `qualified` on a fixture means population verification; it does not establish the full environment's parity.

Browser cases use:

```json
{
  "adminPrincipalId": "fixture-admin@example.invalid",
  "orgScopeId": "org:fixture",
  "cohorts": {
    "median": { "principalId": "actor", "scopeId": "personal:actor", "rootCase": { "sessionId": "recent" } },
    "p95": { "principalId": "actor-p95", "scopeId": "personal:actor-p95", "rootCase": { "sessionId": "recent-p95" } },
    "max": { "principalId": "actor-max", "scopeId": "personal:actor-max", "rootCase": { "sessionId": "recent-max" } }
  },
  "cases": {
    "long": {
      "principalId": "actor-max",
      "scopeId": "personal:actor-max",
      "sessionId": "long-history",
      "threadRef": "web:actor-max:long-history",
      "title": "Long history",
      "expectedVisibleText": "FIXTURE_LONG_TAIL_SENTINEL",
      "earlierVisibleText": "FIXTURE_PREVIOUS_PAGE_SENTINEL",
      "adminVisibleText": "FIXTURE_ADMIN_TRANSCRIPT_SENTINEL"
    }
  },
  "sidebarPagination": { "principalId": "actor-max", "sessionId": "initially-beyond-row-50" },
  "multiview": [],
  "views": {
    "history.max": {
      "expectedText": ["EXPECTED_REAL_FIRST_PAGE_PREVIEW"],
      "rows": { "selector": "a.dense-row", "minimum": 50 }
    },
    "history.next": { "expectedText": ["EXPECTED_SECOND_PAGE_PREVIEW"] },
    "web.search": { "query": "fixture search token", "expectedText": ["EXPECTED_SEARCH_RESULT_SENTINEL"] }
  }
}
```

Supply `short`, `long`, `dense` and `slack` cases. Short and long must share a principal; setup exposes the short sidebar target through normal pagination before measuring its switch. Set `readOnly: true` for a read-only Slack transcript. Supply twelve distinct `multiview` cases belonging to one principal, each with a unique title, real transcript sentinel and thread reference. `browser.earlierPage` identifies a user entry and its text from the actual immediately preceding bounded API page. A nominal turn boundary cannot predict byte-bounded pages. `browser.rootSidebarCases` identifies an actual first-page sidebar conversation for each principal cohort.

`views` defines sentinels for `scopes`, `history.median`, `history.p95`, `history.max`, `history.next`, `web.settings`, `web.search`, `web.browse`, all admin views in `catalog.mjs`, and `spend.7d`/`spend.90d`. Each view may override `selector`, add a `controlSelector` that must be enabled, assert input `values: [{selector, value}]`, exclude pending `absentTexts`, and require row counts. Use deterministic populated fixture values: a title, aggregate value, known first/next row, resource name or log sentinel. Static headings such as “Spend” or “Models” alone are not credible data readiness boundaries. They are not substitutes for seeding those views. Unsupported fixture cases remain in the report as failures.

`fixture-views.mjs` also derives every `web.<view>` in `WEB_VIEWS`, `web.crons.disabled`, and `web.memory.facts` from authenticated observations for `cases.short.principalId`. Capture these exact portal paths and complete response bodies: `/me`, `/api/contexts`, `/api/crons`, `/api/webhooks`, `/api/files?limit=60`, `/api/keychain/overview`, `/api/connectors`, `/api/deployments`, `/api/memory`, and `/api/skills?includeShadowed=1`. Loops additionally needs `/api/loops`; Inbox needs `/api/inbox` and `/api/inbox?view=handled`, followed by the actual cursor URLs until each rendered window has 40 items or no next cursor. Current-tab filters determine row counts: owned nonarchived apps, active skills, bullet memory facts, and attention-requiring Inbox items. Memory's initial view uses the complete observed raw notebook value. Empty lists or missing observations fail readiness derivation.

Loops and Inbox availability comes from the observed account permissions in `/me`. Enabled branches require populated data. Disabled branches are explicitly recorded in `browser.features` and measure the authenticated fallback homepage, with the unavailable view and navigation absent. This verifies the disabled branch only; it does not qualify the enabled feature. A production-enabled cohort therefore needs its own enabled fixture and run.

The mixed transcript case requires `cases.mixed.transcriptBoundarySeq`, the verified canonical-prefix length. Capture the real `tailTurns=25` initial response and consecutive `beforeSeq=<first-entry-sequence>&tailTurns=25` pages until one page spans the boundary. Derivation requires visible user entries from both stores in that page. The harness performs any preceding pagination during setup, verifies the measured target is absent, then times the single crossing click and requires both entry identities and text. These observations are stored in `browser.mixedEarlierPage`; an assumed midpoint or empty viewer response cannot substitute for this evidence.

Readiness asserts the correct visible root, fixture text or row, required editable/enabled controls, no visible loading indicators or alert, and two animation frames. It never accepts only `body`, `networkidle`, a fixed sleep, or a visible composer without the expected transcript. Each successful sample retains the readiness assertions. Keep assertion definitions unchanged between baseline and candidate; review changes to them as carefully as performance changes.

Secondary data must finish too: settings include AI access, Slack status, all connector catalog/connection pages; admin includes scope-directory enrichment, providers, credential usage, model refresh and other view-specific requests. Earlier/history pagination proves that the target sentinel was absent before the click. Hidden-tab return activates and settles the tab during preparation, then measures one return click.

`fixture-views.mjs` derives assertions from saved read-only observations of the isolated fixture. Input is `{fixtureId, at, rows: [{path, principalId, status, data}]}` using actual portal-relative API paths. Omitted `principalId` denotes the fixture admin. Include `/me` and `/api/sessions` for all three homepage cohorts, plus the long transcript's initial `?tailTurns=25` and immediately preceding `?beforeSeq=FIRST_SEQ&tailTurns=25` pages. It validates fixture identity, retains hashes of source observations, preserves missing fixtures as gaps, and writes a new manifest. Org resource indexes use scope names/counts; they do not display individual artifact names. Audit readiness checks the fixture actor's real `audit.read` action and observed row count, since ongoing reads legitimately displace old seeded events. Supply observed data from the fixture, never production response bodies.

Before each measurement, the runner verifies the authenticated fixture principal, writes the intended split-canvas state through the real UI-state API, and reads it back. The browser starts with that same state locally. These untimed setup writes prevent persisted layout leakage; normal application startup and data fetches remain timed. Their identity, timestamp and state hash are retained in every sample. Failure records retain the final URL, visible alerts, stack traces and screenshot.

```sh
node test/performance/fixture-views.mjs /private/fixture.json /private/view-observations.json /private/fixture-with-views.json
```

Intentional feature disablement must be declared in `browser.features` with `enabled: false`, `mode: "disabled"`, and an `evidence` reference. A declared disabled `composio` requires its exact 403 `composio_unavailable` contract and the rendered unavailable message; a declared disabled `slack` requires 404 `not_configured` from its emoji API and the rendered unconfigured installation state. Unexpected status/error codes still fail. The harness never infers permission to ignore an error from the response alone. The local diagnostic can therefore measure correctly settled optional features while qualification still requires production-equivalent feature configuration.

## Load and environment evidence

Start the independent-arrival workload described in `workload.md` before the browser run. Its measured interval must encompass all browser observations. Preserve the workload JSONL, profile hash and summary. After it finishes, copy its summary to the browser output's `workload.json` and verify again:

```sh
cp /absolute/private/workload-summary.json /absolute/private/results/candidate-normal-1/workload.json
node test/performance/verify.mjs /absolute/private/results/candidate-normal-1
```

The environment JSON must contain `isolated: true`, `baseUrl`, `fixtureId`, `profileSha256`, `sourceRevision`, and epoch-millisecond `observedAt` within the preceding day. Its `checks` array must contain passing entries with nonempty evidence references plus `expected` and `observed` values for:

- `dataset-cardinality`, `dataset-distributions`, `payload-compressibility`
- `database-working-set`, `service-topology`, `resource-limits`, `schema-indexes`
- `production-build`, `portal-auth-routing`, `client-network`, `feature-configuration`

These are mandatory, externally measured proof obligations, not flags to set because startup succeeded. Preserve the source evidence at each reference. Table count equality alone cannot prove a realistic 200 GB working set, cache occupancy, I/O latency or payload compressibility. Local Docker with matching CPU and memory does not establish RDS storage or public-network parity. The verifier refuses qualification when those proofs or the measured workload interval are absent.

The `feature-configuration` check's `expected` and `observed` objects contain boolean `modelProvider`, `slack`, `composio`, `loops`, and `inbox` keys and must equal the fixture declarations. Enabled Loops and Inbox use `mode: "enabled"`. Enabled external integrations use `mode: "real"` or `mode: "protocol-fixture"`; the latter also needs `protocolParity: {pass: true, evidence: "..."}` proving the external service fixture reproduces the relevant payload and latency behavior. Missing enabled features cannot qualify through a disabled-feature contract. Browser API mocking remains prohibited. Partial search results and their visible failure warnings fail readiness even when some hits are present.

The result directory contains `run.json`, fixture/environment copies, append-only `samples.jsonl`, failure screenshots and `summary.json`. Samples include request timings/status, transfer/body sizes, compression and Server-Timing headers, browser Resource Timing, DOM counts and long tasks. Failures also retain the final URL and visible alerts' text, HTML and geometry. The alert gate excludes only Dockview's empty accessibility announcer; substantive alerts still fail. Authentication state and response bodies are not copied into evidence. Requests retain paths, so evidence still belongs with the private synthetic fixture when its identities are private.

## Campaign completion

One successful run qualifies only that run's declared envelope. Goal completion requires a measured baseline for both normal and peak load, and two independent candidate runs for each condition, using the same fixture, catalog, runner and client budgets. `verifyCampaign` in `verify.mjs` checks that complete set, rejects repeated run IDs or differing candidate revisions, and reports per-cell before/after p50 and p95. Each campaign item supplies parsed `run`, `samples`, `fixture`, `envelope`, `workload` and `producer` artifacts. The verifier derives the complete required cell set independently of the run's declaration. A baseline may exceed the target or contain measured application failures; every planned observation and all environment/workload parity evidence are still required. Unsupported cases, missing observations and failures before measurement invalidate the comparison. For a baseline cell with failures, the comparison reports the failure count and leaves latency quantiles/deltas null instead of treating its successful subset as representative. Every candidate observation must pass. No weighted/global median replaces a failing cell.

Keep the raw baseline and candidate evidence with the release's immutable image/source identity. This establishes the target for the declared measured envelope. It does not guarantee unmeasured client hardware, network conditions or future workloads.
