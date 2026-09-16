import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

class Container {
  children: unknown[] = [];
  append(...children: unknown[]) {
    this.children.push(...children);
  }
  appendChild(child: unknown) {
    this.append(child);
  }
  prepend(child: unknown) {
    this.children.unshift(child);
  }
}

test("external invitation controls stay in External users", () => {
  const start = html.indexOf("const usersCard = dataCard(");
  const end = html.indexOf("\n        };\n        drawLists();", start);
  assert.ok(start >= 0 && end > start);
  const cards = new Map<string, { heading: Container; body: Container }>();
  const addBtn = {};
  const invite = {};
  const externalSt = {};
  vm.runInNewContext(html.slice(start, end), {
    dataCard(title: string, _description: string, content: unknown) {
      const heading = new Container();
      const body = new Container();
      body.append(content);
      cards.set(title, { heading, body });
      return {
        classList: { add() {} },
        querySelector: (selector: string) => (selector === ".head h2" || selector === ".head" ? heading : body),
      };
    },
    actionTable: () => ({}),
    lists: new Container(),
    roster: {},
    addBtn,
    invite,
    externalSt,
    filteredExternal: [],
    externalUsers: [],
  });
  const users = cards.get("Users")!;
  const external = cards.get("External users")!;
  assert.ok(external.heading.children.includes(addBtn), "invite control is on External users");
  assert.ok(external.body.children.includes(invite), "form is on External users");
  assert.ok(external.body.children.includes(externalSt), "feedback is on External users");
  assert.ok(!users.heading.children.includes(addBtn));
  assert.ok(!users.body.children.includes(invite));
  assert.ok(!users.body.children.includes(externalSt));
});
