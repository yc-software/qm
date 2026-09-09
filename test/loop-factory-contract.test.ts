import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFactoryContract, type ContractInput } from "../src/loops/factory/contract.ts";

const github: Omit<ContractInput, "stdout"> = {
  sourceKey: "QM-12",
  forge: "github",
  publishProject: "yc-software/qm-yc",
};

const qm12OpenPr = [
  {
    shipAction: "open_pr",
    title: "QM-12: pull request #2311",
    label: "qm-12-s17868",
    externalRef: "https://github.com/yc-software/qm-yc/pull/2311",
    capturedBy: "classifier",
  },
];

test("the real QM-12 wrapper tail becomes one open_pr artifact", () => {
  const stdout = [
    '[ship-event] {"schema_version":1,"sequence":28,"decision":"finish",' +
      '"reason":"stable_final_read","ticket":"QM-12","mr_iid":2311,"branch":"qm-12-s17868"}',
    "BRANCH:qm-12-s17868",
    "MR:2311",
  ].join("\n");
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout }), qm12OpenPr);
});

test("a !-prefixed MR and padded values parse the same as the bare contract", () => {
  assert.deepStrictEqual(
    parseFactoryContract({ ...github, stdout: "BRANCH:   qm-12-s17868   \nMR:  !2311  " }),
    qm12OpenPr,
  );
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "BRANCH:qm-12-s17868\r\nMR:2311\r\n" }), qm12OpenPr);
});

test("the later contract line wins and a malformed later line never resets it", () => {
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "BRANCH:old\nMR:2311\nBRANCH:new\nMR:2999" }), [
    {
      shipAction: "open_pr",
      title: "QM-12: pull request #2999",
      label: "new",
      externalRef: "https://github.com/yc-software/qm-yc/pull/2999",
      capturedBy: "classifier",
    },
  ]);
  assert.deepStrictEqual(
    parseFactoryContract({ ...github, stdout: "BRANCH:qm-12-s17868\nMR:2311\nMR:none\nBRANCH:\nBRANCH:   " }),
    qm12OpenPr,
  );
});

test("gitlab builds a merge-request URL, decoding %2F without choking on a stray %", () => {
  const gitlab = { sourceKey: "QM-16", forge: "gitlab" } as const;
  assert.deepStrictEqual(
    parseFactoryContract({ ...gitlab, stdout: "BRANCH:feature-x\nMR:!77", publishProject: "yc-software%2Fcode" }),
    [
      {
        shipAction: "open_pr",
        title: "QM-16: pull request #77",
        label: "feature-x",
        externalRef: "https://gitlab.com/yc-software/code/-/merge_requests/77",
        capturedBy: "classifier",
      },
    ],
  );
  assert.deepStrictEqual(
    parseFactoryContract({ ...gitlab, stdout: "BRANCH:feature-x\nMR:77", publishProject: "yc-software%2Fco%de" })[0]
      ?.externalRef,
    "https://gitlab.com/yc-software/co%de/-/merge_requests/77",
  );
});

test("an already-fixed kickback that retained an MR closes and never opens a PR", () => {
  const closed = [
    {
      shipAction: "close_already_fixed",
      title: "QM-12: already fixed",
      summary: "fixed on main by 9f3ac21, tests already cover it",
      externalRef: "https://github.com/yc-software/qm-yc/pull/2311",
      capturedBy: "classifier",
    },
  ];
  const lines = [
    "ALREADY_FIXED_COMMIT:9f3ac21",
    "ALREADY_FIXED_EVIDENCE:fixed on main by 9f3ac21, tests already cover it",
    "ALREADY_FIXED_DUPLICATE_OF:QM-9",
    "BRANCH:qm-12-s17868",
    "MR:2311",
  ];
  assert.deepStrictEqual(
    parseFactoryContract({ ...github, stdout: ["ALREADY_FIXED:true", ...lines].join("\n") }),
    closed,
  );
  assert.deepStrictEqual(
    parseFactoryContract({ ...github, stdout: [...lines, "ALREADY_FIXED:true"].join("\n") }),
    closed,
  );
});

test("a CRLF stream still closes on ALREADY_FIXED:true", () => {
  assert.deepStrictEqual(
    parseFactoryContract({ ...github, stdout: "ALREADY_FIXED:true\r\nALREADY_FIXED_EVIDENCE:already on main\r\n" }),
    [
      {
        shipAction: "close_already_fixed",
        title: "QM-12: already fixed",
        summary: "already on main",
        capturedBy: "classifier",
      },
    ],
  );
});

test("an empty evidence tail falls through to the commit as the summary", () => {
  assert.deepStrictEqual(
    parseFactoryContract({
      ...github,
      stdout: "ALREADY_FIXED:true\nALREADY_FIXED_COMMIT:9f3ac21\nALREADY_FIXED_EVIDENCE:",
    }),
    [
      {
        shipAction: "close_already_fixed",
        title: "QM-12: already fixed",
        summary: "commit 9f3ac21",
        capturedBy: "classifier",
      },
    ],
  );
});

test("an uppercase commit with no evidence is still cited as the summary", () => {
  assert.deepStrictEqual(
    parseFactoryContract({ ...github, stdout: "ALREADY_FIXED:true\nALREADY_FIXED_COMMIT:9F3AC21BEEF" }),
    [
      {
        shipAction: "close_already_fixed",
        title: "QM-12: already fixed",
        summary: "commit 9F3AC21BEEF",
        capturedBy: "classifier",
      },
    ],
  );
});

test("an already-fixed run with nothing to cite carries no summary", () => {
  const bare = [{ shipAction: "close_already_fixed", title: "QM-12: already fixed", capturedBy: "classifier" }];
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "ALREADY_FIXED:true" }), bare);
  assert.deepStrictEqual(
    parseFactoryContract({ ...github, stdout: "ALREADY_FIXED:true\nALREADY_FIXED_COMMIT:zz12" }),
    bare,
  );
});

test("a contract token the mirrored transcript reprints is not the contract", () => {
  assert.deepStrictEqual(
    parseFactoryContract({
      ...github,
      stdout: '[claude-out] {"text":"the wrapper prints BRANCH:foo and MR:1"}',
    }),
    [],
  );
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "[claude-out] BRANCH:qm-12-s17868\nMR:2311" }), []);
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "BRANCH:qm-12-s17868\n[claude-out] MR:2311" }), []);
});

test("a half or malformed contract yields nothing", () => {
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "BRANCH:qm-12-s17868" }), []);
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "MR:2311" }), []);
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "BRANCH:qm-12\nMR:2311x" }), []);
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "BRANCH:qm-12\nMR:!" }), []);
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "  BRANCH:qm-12\nMR:2311" }), []);
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "" }), []);
  assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: "\n \n\r\n" }), []);
});

test("the wrapper's observability-only sibling lines are inert", () => {
  assert.deepStrictEqual(
    parseFactoryContract({
      ...github,
      stdout: [
        "MR_ADOPTED_VIA:https://github.com/yc-software/qm-yc/pull/2311",
        "MR_OPEN_FINDINGS:one thread unresolved",
        "ALREADY_FIXED_DUPLICATE_OF:QM-9",
        "ALREADY_FIXED_COMMIT:9f3ac21",
        "BRANCH:qm-12-s17868",
      ].join("\n"),
    }),
    [],
  );
});

test("an ALREADY_FIXED near-miss does not trigger the close branch", () => {
  const openPr = [
    {
      shipAction: "open_pr",
      title: "QM-12: pull request #7",
      label: "b",
      externalRef: "https://github.com/yc-software/qm-yc/pull/7",
      capturedBy: "classifier",
    },
  ];
  for (const nearMiss of ["ALREADY_FIXED:false", "ALREADY_FIXED: true", "ALREADY_FIXED:true extra"]) {
    assert.deepStrictEqual(parseFactoryContract({ ...github, stdout: `${nearMiss}\nBRANCH:b\nMR:7` }), openPr);
  }
});
