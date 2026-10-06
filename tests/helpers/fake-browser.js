// A hand-rolled, minimal `window`/`document` -- just enough surface for ui.js and
// board.js to run under `node:test` (same spirit as sandbox-viewer.test.js's fakeDoc(),
// extended to support innerHTML templates, querySelector-by-class and a real id registry,
// since board.js's buildTile() needs all three). There is no real layout engine here: it
// cannot tell you whether a mutation would actually reflow the page. Tests that need that
// simulate it explicitly (see tests/board.test.js) by having a specific mutation point
// (e.g. grid.appendChild, or a desk's load() resolving) nudge `window.scrollY` itself, the
// same way a real browser's layout engine would -- then assert the code under test
// restores it, which is the property this whole fix is about.

function makeClassList(el) {
  const set = new Set();
  return {
    add(...cs) { for (const c of cs) set.add(c); },
    remove(...cs) { for (const c of cs) set.delete(c); },
    toggle(c, on) {
      const want = on === undefined ? !set.has(c) : on;
      if (want) set.add(c); else set.delete(c);
      return want;
    },
    contains(c) { return set.has(c); },
    get _set() { return set; },
  };
}

function findFirstByClass(root, cls) {
  for (const c of root.children) {
    if (c.classList.contains(cls)) return c;
    const found = findFirstByClass(c, cls);
    if (found) return found;
  }
  return null;
}

function parseFragment(html, doc) {
  const root = makeElement("#fragment", doc);
  const stack = [root];
  // comment | closing tag | opening tag (attrs, optional self-close) | text run
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[a-zA-Z0-9_:-]+(?:="[^"]*")?)*)\s*(\/?)>|[^<]+/g;
  let m;
  while ((m = re.exec(html))) {
    const [whole, closeTag, openTag, attrStr] = m;
    if (closeTag) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (openTag) {
      const el = makeElement(openTag, doc);
      if (attrStr) {
        const attrRe = /([a-zA-Z0-9_:-]+)(?:="([^"]*)")?/g;
        let am;
        while ((am = attrRe.exec(attrStr))) {
          const [, name, value = ""] = am;
          el.setAttribute(name, value);
        }
      }
      stack[stack.length - 1].append(el);
      const selfClosing = whole.trimEnd().endsWith("/>") || /^(use|br|wbr|img|input)$/.test(openTag);
      if (!selfClosing) stack.push(el);
      continue;
    }
    if (whole.startsWith("<!--")) continue;
    if (whole.trim() !== "") stack[stack.length - 1]._text += whole;
  }
  return root.children;
}

export function makeElement(tag, doc) {
  const el = {
    tag,
    attrs: {},
    children: [],
    parent: null,
    _text: "",
    dataset: {},
    hidden: false,
    offsetWidth: 0,
    id: "",
    title: "",
    src: "",
    href: "",
    classList: null,
    get className() {
      return [...this.classList._set].join(" ");
    },
    set className(v) {
      this.classList._set.clear();
      for (const c of String(v).split(/\s+/).filter(Boolean)) this.classList._set.add(c);
    },
    get textContent() {
      return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
    },
    set textContent(v) {
      this.children = [];
      this._text = v == null ? "" : String(v);
    },
    set innerHTML(html) {
      this.children = [];
      this._text = "";
      for (const child of parseFragment(html, doc)) this.append(child);
    },
    get innerHTML() {
      return "[fake-dom: not reconstructed]";
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === "class") this.className = v;
      if (k === "id") {
        this.id = v;
        doc._byId.set(v, this);
      }
    },
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    },
    removeAttribute(k) {
      delete this.attrs[k];
    },
    append(...kids) {
      for (const k of kids) {
        k.parent = this;
        this.children.push(k);
      }
    },
    appendChild(kid) {
      kid.parent = this;
      this.children.push(kid);
      return kid;
    },
    prepend(...kids) {
      for (const k of kids) k.parent = this;
      this.children = [...kids, ...this.children];
    },
    replaceChildren(...kids) {
      this.children = [];
      this.append(...kids);
    },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    },
    querySelector(sel) {
      if (!sel.startsWith(".")) throw new Error(`fake-browser querySelector only supports ".class" selectors, got ${sel}`);
      return findFirstByClass(this, sel.slice(1));
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    closest() {
      return null;
    },
  };
  el.classList = makeClassList(el);
  return el;
}

/**
 * Installs a minimal fake `window`/`document` on globalThis, enough to import and run
 * ui.js + board.js. Returns `{ document, window, reset }`; call `reset()` between tests
 * that need a clean `#tiles` grid registered under the same global document (ui.js's `$`
 * always reads the current `globalThis.document`, so there is no need to reinstall it).
 */
export function installFakeBrowser() {
  const doc = {
    _byId: new Map(),
    createElement: (tag) => makeElement(tag, doc),
    getElementById: (id) => doc._byId.get(id) || null,
    addEventListener() {},
    removeEventListener() {},
    title: "",
  };
  const win = {
    scrollY: 0,
    matchMedia: () => ({ matches: true }), // reduced motion: skip ui.js's print() animation bookkeeping entirely
    scrollTo(_x, y) {
      win.scrollY = y;
    },
  };
  globalThis.document = doc;
  globalThis.window = win;
  return {
    document: doc,
    window: win,
    /** Registers a fresh #tiles grid (board.js's mountBoard reads it via $("tiles") at mount time). */
    freshGrid() {
      const grid = makeElement("div", doc);
      grid.setAttribute("id", "tiles");
      return grid;
    },
  };
}
