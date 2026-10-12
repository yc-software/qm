import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxFixture } from "./inbox-composer-fixture.ts";

test("shared menu selection supports keyboard navigation and preserves disabled choices", async () => {
  const { dom, vite, host, close } = await createInboxFixture();
  try {
    const { menuSelect } = await vite.ssrLoadModule("/src/ui.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const selected: Array<string | null> = [];
    const props = {
      value: "private",
      ariaLabel: "Sharing",
      ariaDescription: "Choose who can access this app",
      keyboardNavigation: true,
      onSelect: (value: string | null) => selected.push(value),
      options: [
        { value: "private", label: "Private" },
        { value: "team", label: "Team" },
        { value: "public", label: "Public", disabledHint: "External sharing is disabled" },
      ],
    };
    render(menuSelect(props), host);
    const trigger = host.querySelector<HTMLButtonElement>(".menu-button")!;
    const menu = host.querySelector<HTMLElement>(".menu-popover")!;
    const options = [...host.querySelectorAll<HTMLButtonElement>(".menu-option")];
    const key = (target: HTMLElement, value: string) =>
      target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    assert.equal(trigger.getAttribute("aria-description"), props.ariaDescription);
    key(trigger, "ArrowDown");
    assert.equal(menu.hidden, false);
    assert.equal(document.activeElement, options[0]);
    key(options[0]!, "End");
    assert.equal(document.activeElement, options[2]);
    assert.equal(options[2]!.getAttribute("aria-disabled"), "true");
    options[2]!.click();
    assert.equal(selected.length, 0);
    assert.equal(menu.hidden, false);
    key(options[2]!, "ArrowDown");
    assert.equal(document.activeElement, options[0]);
    key(options[0]!, "ArrowUp");
    assert.equal(document.activeElement, options[2]);
    key(options[2]!, "Home");
    assert.equal(document.activeElement, options[0]);
    key(options[0]!, "ArrowDown");
    options[1]!.click();
    assert.deepEqual(selected, ["team"]);
    assert.equal(menu.hidden, true);
    assert.equal(document.activeElement, trigger);
    key(trigger, "ArrowUp");
    assert.equal(document.activeElement, options[2]);
    key(options[2]!, "Escape");
    assert.equal(menu.hidden, true);
    assert.equal(document.activeElement, trigger);
    trigger.click();
    assert.equal(document.activeElement, options[0]);
    key(options[0]!, "Tab");
    assert.equal(menu.hidden, true);
    render(menuSelect({ ...props, disabled: true }), host);
    assert.equal(trigger.disabled, true);
    assert.ok(options.every((option) => option.disabled));
    trigger.click();
    key(trigger, "ArrowDown");
    options[1]!.click();
    assert.equal(menu.hidden, true);
    assert.deepEqual(selected, ["team"]);
  } finally {
    await close();
  }
});

test("shared menu selection preserves default keyboard and focus behavior without opting in", async () => {
  const { dom, vite, host, close } = await createInboxFixture();
  try {
    const { menuSelect } = await vite.ssrLoadModule("/src/ui.ts");
    const { render } = await vite.ssrLoadModule("lit");
    const selected: Array<string | null> = [];
    render(
      menuSelect({
        value: "private",
        ariaLabel: "Sharing",
        onSelect: (value: string | null) => selected.push(value),
        options: [
          { value: "private", label: "Private" },
          { value: "team", label: "Team" },
          { value: "public", label: "Public", disabledHint: "External sharing is disabled" },
        ],
      }),
      host,
    );
    const trigger = host.querySelector<HTMLButtonElement>(".menu-button")!;
    const menu = host.querySelector<HTMLElement>(".menu-popover")!;
    const options = [...host.querySelectorAll<HTMLButtonElement>(".menu-option")];
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    const bubbledKeys: string[] = [];
    host.addEventListener("keydown", (event) => bubbledKeys.push(event.key));
    const key = (target: HTMLElement, value: string) =>
      target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    trigger.focus();
    for (const value of keys) {
      assert.equal(key(trigger, value), true);
      assert.equal(menu.hidden, true);
      assert.equal(document.activeElement, trigger);
    }
    trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 0 }));
    assert.equal(menu.hidden, false);
    assert.equal(document.activeElement, trigger);
    options[1]!.focus();
    for (const value of keys) {
      assert.equal(key(options[1]!, value), true);
      assert.equal(menu.hidden, false);
      assert.equal(document.activeElement, options[1]);
    }
    assert.deepEqual(bubbledKeys, [...keys, ...keys]);
    assert.equal(options[2]!.getAttribute("aria-disabled"), "true");
    options[2]!.click();
    assert.deepEqual(selected, []);
    assert.equal(menu.hidden, false);
    assert.equal(document.activeElement, options[1]);
    options[1]!.click();
    assert.deepEqual(selected, ["team"]);
    assert.equal(menu.hidden, true);
    assert.equal(document.activeElement, options[1]);
  } finally {
    await close();
  }
});
