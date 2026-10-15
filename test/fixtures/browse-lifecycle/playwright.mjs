import { EventEmitter } from "node:events";
import { appendFileSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";

export const config = JSON.parse(readFileSync(new URL("./fixture-config.json", import.meta.url), "utf8"));

class Page extends EventEmitter {
  constructor(context, url) {
    super();
    this.contextValue = context;
    this._guid = `page-${++context.sequence}`;
    this.urlValue = url;
    this.closed = false;
  }
  context() {
    return this.contextValue;
  }
  url() {
    return this.urlValue;
  }
  async title() {
    return `Fake ${this.urlValue}`;
  }
  isClosed() {
    return this.closed;
  }
  async goto(url) {
    this.urlValue = url;
    appendFileSync(config.events, `${JSON.stringify({ method: "goto", url })}\n`);
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
  async screenshot({ path } = {}) {
    const data = Buffer.from(`screenshot:${this.urlValue}`);
    if (path) await writeFile(path, data);
    return data;
  }
}

class Context extends EventEmitter {
  constructor(urls) {
    super();
    this.sequence = 0;
    this.pageList = urls.map((url) => new Page(this, url));
  }
  pages() {
    return this.pageList.filter((page) => !page.isClosed());
  }
  async newPage() {
    const page = new Page(this, "about:blank");
    this.pageList.push(page);
    this.emit("page", page);
    return page;
  }
}

export class Browser extends EventEmitter {
  constructor() {
    super();
    this.contextList = [new Context(config.pages ?? ["about:blank"])];
  }
  contexts() {
    return this.contextList;
  }
  async newContext() {
    const context = new Context([]);
    this.contextList.push(context);
    return context;
  }
  isConnected() {
    return true;
  }
  async close() {
    this.emit("disconnected");
  }
}

export const chromium = {
  async connect(endpoint) {
    if (endpoint !== new URL("./fixture-config.json", import.meta.url).href) throw new Error("Unexpected endpoint");
    if (config.connectError) throw new Error(config.connectError);
    return new Browser();
  },
};
