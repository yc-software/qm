import { html, nothing } from "lit";
import { renderer } from "./shared.ts";
type Context = {
  stateToUrl: (state: Record<string, unknown>) => string;
  scope: () => string;
  searchField: (options: Record<string, unknown>) => Node;
  twoWayToggle: (options: Record<string, unknown>) => Node;
  fileThumb: (item: Record<string, unknown>) => Node;
  initCustomDropdowns: (root: HTMLElement) => void;
};
const DESIGN_TOKENS = [
  ["--bg", "Page behind every surface"],
  ["--surface", "Cards, dialogs, table bodies"],
  ["--subtle", "Quiet control and inset backgrounds"],
  ["--border", "Every hairline and divider"],
  ["--text", "Primary copy"],
  ["--muted", "Secondary copy and hints"],
  ["--cta", "Primary actions and selected controls"],
  ["--ok", "Confirmed and healthy"],
  ["--warn", "Needs attention"],
  ["--danger", "Destructive and failed"],
  ["--trigger", "Automation and triggers"],
];

export function show(context: Context) {
  const root = document.getElementById("view-design")!;
  if (root.dataset.litDesign) return;
  root.dataset.litDesign = "true";
  const draw = renderer(root);
  const state = {
    scopeStatus: "Choose a scope to try the row interaction.",
    fileStatus: "File names, thumbnails, sizes, and dates stay visible.",
    packStatus: "Registration is a local demonstration.",
    searchStatus: "Type to try the search field, then clear it.",
    toggleStatus: "Selected: Human activity",
    advanced: false,
    name: "Acme",
    savedName: "Acme",
    nameSaved: false,
    chip: true,
  };
  const update = (change: Partial<typeof state>) => {
    Object.assign(state, change);
    paint();
  };
  const dialog = () => document.getElementById("design-dialog") as HTMLDialogElement;
  const search = context.searchField({
    placeholder: "Search messages…",
    onInput: (value: string) =>
      update({ searchStatus: value ? "Search query: " + value : "Type to try the search field, then clear it." }),
  });
  const searchFilled = context.searchField({ placeholder: "Search messages…", value: "Product updates" });
  const searchDisabled = context.searchField({ placeholder: "Search unavailable", disabled: true });
  const options = [
    { value: "human", label: "Human activity" },
    { value: "all", label: "All activity" },
  ];
  const toggle = context.twoWayToggle({
    label: "Example activity sort",
    options,
    value: "human",
    onChange: (value: string) => update({ toggleStatus: "Selected: " + options.find((o) => o.value === value)!.label }),
  });
  const toggleDisabled = context.twoWayToggle({
    label: "Disabled activity sort",
    options,
    value: "human",
    disabled: true,
    onChange: () => {},
  });
  const scopeList = () =>
    html`<div class="dense-list">
      ${[
        { name: "Example team", preview: "12 skills", time: "5 mins ago" },
        { name: "Research", preview: "4 skills", time: "Yesterday" },
      ].map(
        (item) =>
          html`<div
            class="dense-row"
            tabindex="0"
            role="button"
            @click=${() => update({ scopeStatus: "Selected: " + item.name })}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") update({ scopeStatus: "Selected: " + item.name });
            }}
          >
            <span class="dense-name">${item.name}</span><span class="dense-preview">${item.preview}</span
            ><span class="dense-time">${item.time}</span>
          </div>`,
      )}
    </div>`;
  const fileItems = [
    { name: "Research brief.pdf", size: "240 KB", date: "Today" },
    { name: "Project notes.md", size: "8 KB", date: "Yesterday" },
  ].map((item) => ({ ...item, thumb: context.fileThumb(item) }));
  const fileList = () =>
    html`<div class="dense-list">
      ${fileItems.map(
        (item) =>
          html`<div
            class="dense-row"
            tabindex="0"
            role="button"
            @click=${() => update({ fileStatus: "Selected: " + item.name + " (demo only)" })}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") update({ fileStatus: "Selected: " + item.name + " (demo only)" });
            }}
          >
            <span class="dense-icon">${item.thumb}</span><span class="dense-name">${item.name}</span
            ><span class="dense-preview">Example team</span
            ><span class="dense-time">${item.size + " · " + item.date}</span>
          </div>`,
      )}
    </div>`;
  function nameStatus() {
    if (state.name !== state.savedName) return "Unsaved changes";
    return state.nameSaved ? "Saved in this example" : "No changes";
  }
  function paint() {
    const titles: string[] = [];
    const designSpec = (label: string, note: string, demo: unknown, stack = false) =>
      html`<div class="spec">
        <div class="spec-label">${label}${note ? html`<span>${note}</span>` : nothing}</div>
        <div class=${"spec-demo" + (stack ? " stack" : "")}>${demo}</div>
      </div>`;
    const sectionId = (title: string) => "design-group-" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const designSection = (title: string, blurb: string, specs: unknown[]) => {
      titles.push(title);
      return html`<section class="design-group" id=${sectionId(title)}>
        <h2>${title}</h2>
        <p>${blurb}</p>
        ${specs}
      </section>`;
    };
    const swatches = DESIGN_TOKENS.map(
      (t) =>
        html`<div class="swatch">
          <div class="swatch-chip" style=${"background: var(" + t[0] + ")"}></div>
          <div class="swatch-meta"><b>${t[0]}</b>${t[1]}</div>
        </div>`,
    );
    const sections = [
      html`<p class="lead">
        Components and page patterns from the redesigned admin portal, including Skills, Files, Sessions, Metrics,
        Audit, and Egress. Examples use fictional data and do not save changes.
      </p>`,
      designSection("Foundations", "One palette, a small type scale, and consistent spacing.", [
        designSpec(
          "Semantic colors",
          "Shared theme tokens · light and dark",
          html`<div class="swatches">${swatches}</div>`,
        ),
        designSpec(
          "Type & spacing",
          "22px page title · 14px section title · 13px controls and copy",
          html`<div class="shell-title">Page title</div>
            <div class="head">
              <h2>Section title</h2>
              <p>Descriptions explain the setting.</p>
            </div>
            <label>Field label</label>
            <p class="hint">4px label gap · 8px action gap · 24px section spacing</p>`,
          true,
        ),
      ]),
      designSection(
        "Page layout",
        "Start with the shared shell. Align titles, sections, and rows to the same content edge; use whitespace and dividers instead of enclosing cards.",
        [
          designSpec(
            "Desktop and mobile",
            "Authored layout diagrams · .admin-main → .admin-inner → .shellbar",
            html`<div class="design-layouts">
              <div class="design-layout-frame">
                <div class="design-layout-nav">Sidebar<br />Independent scroll</div>
                <div class="design-layout-main">
                  <div class="design-layout-content">
                    <div class="design-layout-title">Title <span>Search / action</span></div>
                    <div class="design-layout-section">Open section<br /><small>Heading + description</small></div>
                    <div class="design-layout-lines">Compact rows<br />────────────────<br />Compact rows</div>
                  </div>
                </div>
              </div>
              <div class="design-layout-frame mobile">
                <div class="design-layout-nav">Horizontal navigation</div>
                <div class="design-layout-main">
                  <div class="design-layout-content">
                    <div class="design-layout-title">Title</div>
                    <div class="design-layout-section">Full-width search</div>
                    <div class="design-layout-lines">Stacked content<br />────────────<br />Local table scroll</div>
                  </div>
                </div>
              </div>
            </div>`,
            true,
          ),
          designSpec(
            "Width and page padding",
            "Current New CSS · index.html and admin-components.css",
            html`<div class="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Desktop</th>
                    <th>Small screens</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Navigation</td>
                    <td>280px sidebar; independent scroll</td>
                    <td>Horizontal navigation at ≤900px</td>
                  </tr>
                  <tr>
                    <td>Content width</td>
                    <td>960px maximum, centered; fluid below that</td>
                    <td>Available width; min-width: 0</td>
                  </tr>
                  <tr>
                    <td>Main padding</td>
                    <td>28px top and sides</td>
                    <td>At ≤900px: 18px top, 14px sides with safe-area insets</td>
                  </tr>
                  <tr>
                    <td>Bottom clearance</td>
                    <td colspan="2">110px for the fixed Original / New switch</td>
                  </tr>
                  <tr>
                    <td>Page heading</td>
                    <td colspan="2">22px / 500 weight; shared shell spacing 16px (activity pages use 24px)</td>
                  </tr>
                  <tr>
                    <td>Sections</td>
                    <td colspan="2">24px between artifact sections; 12px from section heading to content</td>
                  </tr>
                  <tr>
                    <td>Controls</td>
                    <td colspan="2">32px height · 6px radius · 8px gap · 4px label gap</td>
                  </tr>
                </tbody>
              </table>
            </div>`,
            true,
          ),
          designSpec(
            "Choose a page pattern",
            "Live references · preserve the selected organization",
            html`<div class="design-page-links">
              <a
                data-design-view="governance"
                href=${context.stateToUrl({ view: "governance", scope: context.scope() })}
                >Governance / Models</a
              >
              <p>
                Descriptions beside settings, 40px column gap; stack on small screens. Keep Apply right-aligned with
                status on its left.
              </p>
              <a data-design-view="skills" href=${context.stateToUrl({ view: "skills", scope: context.scope() })}
                >Skills</a
              >
              <p>Open installed-skill and skill-pack sections; compact tables and an inline registration form.</p>
              <a data-design-view="files" href=${context.stateToUrl({ view: "files", scope: context.scope() })}
                >Files</a
              >
              <p>Search in the header, flat upload toolbar, then scopes or files with metadata.</p>
              <a data-design-view="history" href=${context.stateToUrl({ view: "history", scope: context.scope() })}
                >Sessions</a
              >
              <p>Two-way sort toggle, named environments, and a separately titled conversation list.</p>
              <a data-design-view="audit" href=${context.stateToUrl({ view: "audit", scope: context.scope() })}
                >Audit</a
              >
              ·
              <a data-design-view="egress" href=${context.stateToUrl({ view: "egress", scope: context.scope() })}
                >Egress</a
              >
              <p>Filters above plain tables; headers stay transparent and regular-weight.</p>
            </div>`,
            true,
          ),
          designSpec(
            "Responsive behavior",
            "Page-level rules",
            html`<ul class="design-rules">
              <li>At ≤900px, the sidebar becomes horizontal navigation.</li>
              <li>
                At ≤640px, Skills and Files search uses the full row; dense rows allow more height and Files metadata
                wraps below the name.
              </li>
              <li>Wide tables scroll inside .tablewrap. Never force the entire document wider than the viewport.</li>
              <li>
                Keep all actions and metadata available on mobile. Use wrapping or local scrolling rather than hiding
                content.
              </li>
              <li>Sidebar scrolling is contained; reaching its end must not scroll the main page.</li>
            </ul>`,
            true,
          ),
        ],
      ),
      designSection(
        "Artifact and reporting patterns",
        "Compositions from the recent redesigns. Shared helpers render the lists; the form and report examples are local demonstrations.",
        [
          designSpec(
            "Scope list",
            "denseList() · shared Skills / Files row styles · Enter or click selects a demo row",
            html`<div id="design-scope-list">${scopeList()}</div>
              <p class="hint" id="design-scope-status" role="status">${state.scopeStatus}</p>`,
            true,
          ),
          designSpec(
            "File list and upload toolbar",
            "denseList() + fileThumb() · .file-upload · visual upload example, no network requests",
            html`<div class="file-upload">
                <div class="file-upload-actions">
                  <button
                    type="button"
                    class="primary upload-button"
                    id="design-upload"
                    @click=${() => update({ fileStatus: "On Files, this opens the file picker. This example does not upload files." })}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.8"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></svg
                    ><span>Upload</span>
                  </button>
                </div>
              </div>
              <div id="design-file-list">${fileList()}</div>
              <p class="hint" id="design-file-status" role="status">${state.fileStatus}</p>`,
            true,
          ),
          designSpec(
            "Skill-pack registration",
            ".pack-register · shared Skills styles · local form demonstration",
            html`<div class="pack-register">
                <input
                  type="url"
                  aria-label="Example skill repository"
                  placeholder="https://github.com/example/skills"
                /><button
                  type="button"
                  id="design-register"
                  @click=${() => update({ packStatus: "Example registered locally. No repository was fetched." })}
                >
                  Register</button
                ><button
                  type="button"
                  class="linkish"
                  id="design-advanced"
                  @click=${() => update({ advanced: !state.advanced })}
                  aria-expanded=${String(state.advanced)}
                  aria-controls="design-pack-advanced"
                >
                  Advanced
                </button>
              </div>
              <div class=${state.advanced ? "pack-adv" : "pack-adv hidden"} id="design-pack-advanced">
                <div>
                  <label for="design-pack-name">Name</label
                  ><input id="design-pack-name" type="text" placeholder="Team skills" />
                </div>
                <div>
                  <label for="design-pack-ref">Ref</label><input id="design-pack-ref" type="text" placeholder="main" />
                </div>
                <div>
                  <label for="design-pack-path">Path</label
                  ><input id="design-pack-path" type="text" placeholder="skills/" />
                </div>
              </div>
              <p class="hint" id="design-pack-status" role="status">${state.packStatus}</p>`,
            true,
          ),
          designSpec(
            "Open report section",
            "Authored Metrics / Audit / Egress composition · statline() + shared table controls",
            html`<section class="design-open-section">
              <h3>Activity summary</h3>
              <p class="hint">Keep descriptions beside the section they explain.</p>
              <div id="design-metrics-summary">
                <div class="statline">152 requests · 2 scopes · Last 24 hours</div>
              </div>
              <div class="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Scope</th>
                      <th>Requests</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Example team</td>
                      <td>128</td>
                      <td><span class="badge ok">Healthy</span></td>
                    </tr>
                    <tr>
                      <td>Research</td>
                      <td>24</td>
                      <td><span class="badge muted">Idle</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>`,
            true,
          ),
        ],
      ),
      designSection("Actions", "32px controls with a 6px radius. Primary actions use the dark blue accent.", [
        designSpec(
          "Buttons",
          "button · .primary · .danger",
          html`<button type="button" class="primary">Apply</button><button type="button">Add item</button
            ><button type="button" class="danger">Delete</button><button type="button" disabled>Disabled</button
            ><button type="button" class="primary" disabled>Apply</button>`,
        ),
        designSpec(
          "Quiet actions",
          ".viewlink · .icon-button",
          html`<button type="button" class="viewlink">View history ›</button
            ><button type="button" class="icon-button" aria-label="Remove example">×</button>`,
        ),
        designSpec(
          "Save feedback",
          ".foot · .status · native input events",
          html`<section class="card">
            <div class="head">
              <h2>Example setting</h2>
              <p>Edit the name to try unsaved and saved states.</p>
            </div>
            <div class="body">
              <label for="design-name">Display name</label
              ><input
                id="design-name"
                type="text"
                .value=${state.name}
                @input=${(e: Event) => update({ name: (e.target as HTMLInputElement).value, nameSaved: false })}
              />
            </div>
            <div class="foot">
              <span class="status" id="design-status" role="status">${nameStatus()}</span
              ><button
                class="primary"
                type="button"
                id="design-apply"
                ?disabled=${state.name === state.savedName}
                @click=${() => update({ savedName: state.name, nameSaved: true })}
              >
                Apply
              </button>
            </div>
          </section>`,
          true,
        ),
      ]),
      designSection(
        "Two-way toggle",
        "Choose one of two mutually exclusive options. Tab to focus; use arrow keys to switch.",
        [
          designSpec(
            "Segmented choice",
            "twoWayToggle({ label, options, value, onChange, disabled }) · shared radio group",
            html`<div id="design-two-way-toggle">${toggle}</div>
              <p class="hint" id="design-two-way-status" role="status">${state.toggleStatus}</p>`,
            true,
          ),
          designSpec(
            "Disabled",
            "The same component with disabled: true",
            html`<div id="design-two-way-disabled">${toggleDisabled}</div>`,
          ),
        ],
      ),
      designSection(
        "Search",
        "A transparent background, subtle border, search icon, and clear action. Focus uses the shared dark blue accent.",
        [
          designSpec(
            "Search field",
            "searchField() · shared with Slack and page toolbar searches",
            html`<div id="design-search">${search}</div>
              <p class="hint" id="design-search-status" role="status">${state.searchStatus}</p>`,
            true,
          ),
          designSpec(
            "Populated and disabled",
            "The same component with value and disabled options",
            html`<div id="design-search-filled">${searchFilled}</div>
              <div id="design-search-disabled">${searchDisabled}</div>`,
            true,
          ),
        ],
      ),
      designSection("Fields", "Shared sizing, labels, hints, focus rings, validation, and disabled states.", [
        designSpec(
          "Text fields",
          "input · label · .hint",
          html`<label for="design-text">Client ID</label
            ><input id="design-text" type="text" placeholder="Enter a client ID" aria-describedby="design-text-hint" />
            <p class="hint" id="design-text-hint">A label stays visible when the field has a value.</p>
            <label for="design-number">Limit</label><input id="design-number" type="number" value="10" /><label
              for="design-disabled"
              >Inherited value</label
            ><input id="design-disabled" type="text" disabled value="Organization default" /><label for="design-invalid"
              >Required value</label
            ><input id="design-invalid" type="text" aria-invalid="true" aria-describedby="design-error" />
            <p class="status err" id="design-error">Enter a value to continue.</p>`,
          true,
        ),
        designSpec(
          "Dropdown",
          "select → shared .dd accessible dropdown",
          html`<label for="design-select">Scope</label
            ><select id="design-select">
              <option>Organization</option>
              <option>Team</option>
              <option>Personal</option>
            </select>`,
          true,
        ),
        designSpec(
          "Multiline",
          "textarea · same field border and label",
          html`<label for="design-notes">Instructions</label
            ><textarea id="design-notes" rows="3" placeholder="Write instructions…"></textarea>`,
          true,
        ),
        designSpec(
          "Choices",
          ".choice-stack · .posture-choice",
          html`<div class="choice-stack">
            <label class="posture-choice"
              ><input type="radio" name="design-choice" checked /><span
                ><strong>Automatic</strong><small>Review activity when needed.</small></span
              ></label
            ><label class="posture-choice"
              ><input type="radio" name="design-choice" /><span
                ><strong>Always review</strong><small>Review every request.</small></span
              ></label
            >
          </div>`,
          true,
        ),
        designSpec(
          "Switch & checkbox",
          ".setting-toggle · .setting-switch · input[type=checkbox]",
          html`<label class="setting-toggle"
              ><input type="checkbox" checked /><span class="setting-switch" aria-hidden="true"></span
              ><span>Enable feature</span></label
            ><label><input type="checkbox" /> Include optional details</label>`,
          true,
        ),
      ]),
      designSection(
        "Sections & lists",
        "Open sections separated by rules, with the same headings, descriptions, and row actions.",
        [
          designSpec(
            "Settings section",
            ".card > .head / .body / .foot",
            html`<section class="card">
              <div class="head">
                <h2>Section title</h2>
                <p>Explain what the setting changes.</p>
              </div>
              <div class="body">
                <label for="design-section-field">Setting label</label
                ><input id="design-section-field" type="text" value="Default value" />
              </div>
              <div class="foot">
                <span class="status">No changes</span><button class="primary" type="button" disabled>Apply</button>
              </div>
            </section>`,
            true,
          ),
          designSpec(
            "List row",
            ".credential-row · .credential-title · .credential-actions",
            html`<div class="credential-row">
              <div class="credential-main">
                <div class="credential-title">
                  <strong>Example service</strong><span class="credential-slug">example</span>
                </div>
                <p class="hint">Available to the organization</p>
              </div>
              <div class="credential-actions">
                <button type="button">Edit</button><button type="button" class="danger">Delete</button>
              </div>
            </div>`,
            true,
          ),
          designSpec(
            "Model chip",
            ".model-chip · removable item",
            html`${state.chip ? html`<div class="model-chip"><span>Example model</span><button type="button" id="design-remove-chip" aria-label="Remove example model" @click=${() => update({ chip: false })}>×</button></div>` : nothing}<span
                class="hint"
                id="design-chip-status"
                role="status"
                >${state.chip ? "" : "Example model removed"}</span
              >`,
          ),
          designSpec(
            "Badges & feedback",
            ".badge · .status · semantic colors",
            html`<span class="badge muted">Inherited</span><span class="badge ok">Enabled</span
              ><span class="badge warn">Needs review</span><span class="badge err">Failed</span
              ><span class="status ok">Saved</span><span class="status err">Save failed</span>`,
          ),
          designSpec(
            "Empty state",
            ".empty",
            html`<div class="empty">No items yet. Add an item to get started.</div>`,
            true,
          ),
        ],
      ),
      designSection(
        "Dialogs",
        "The same controls in a focused, keyboard-accessible dialog. Escape closes it and returns focus.",
        [
          designSpec(
            "Review dialog",
            "dialog.review-dialog · shared fields and actions",
            html`<button type="button" id="design-dialog-open" @click=${() => dialog()?.showModal()}>
                Open example dialog
              </button>
              <dialog class="review-dialog" id="design-dialog" aria-labelledby="design-dialog-title">
                <div class="review-dialog-head">
                  <h2 id="design-dialog-title">Example dialog</h2>
                  <p>Try the shared controls without changing any settings.</p>
                </div>
                <div class="review-dialog-body">
                  <label for="design-dialog-field">Display name</label
                  ><input id="design-dialog-field" type="text" value="Example" />
                </div>
                <div class="review-dialog-foot">
                  <button type="button" id="design-dialog-close" @click=${() => dialog()?.close()}>Cancel</button
                  ><button type="button" class="primary" id="design-dialog-done" @click=${() => dialog()?.close()}>
                    Done
                  </button>
                </div>
              </dialog>`,
          ),
        ],
      ),
      designSection(
        "Tables",
        "13px cells, quiet headers, consistent padding, and scrolling inside the table on small screens.",
        [
          designSpec(
            "Data table",
            ".tablewrap > table · th · td",
            html`<div class="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Access</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Alex Example</td>
                    <td>Organization</td>
                    <td><span class="badge ok">Active</span></td>
                    <td><button type="button">Edit</button></td>
                  </tr>
                  <tr>
                    <td>Sam Example</td>
                    <td>Team</td>
                    <td><span class="badge muted">Invited</span></td>
                    <td><button type="button" disabled>Edit</button></td>
                  </tr>
                </tbody>
              </table>
            </div>`,
            true,
          ),
        ],
      ),
    ];
    draw(
      html`${sections[0]}
        <nav class="design-contents" aria-label="Design system sections">
          ${titles.map((title) => html`<a href=${"#" + sectionId(title)}>${title}</a>`)}
        </nav>
        ${sections.slice(1)}`,
    );
  }
  paint();
  context.initCustomDropdowns(root);
}
