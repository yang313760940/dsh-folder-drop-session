import { EventEmitter } from 'node:events';

export function directory(name = '工程', read = success => success([])) {
  return { name, isDirectory: true, isFile: false, fullPath: `/${name}`,
    createReader: () => ({ readEntries: read }) };
}
export function fileItem(entry, file = { name: entry.name }) {
  return { kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => entry };
}
export function transfer(entries) {
  const items = entries.map(entry => fileItem(entry));
  return { types: ['Files'], items, files: items.map(item => item.getAsFile()) };
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function fakeHost(overrides = {}) {
  const calls = [];
  let next = 0;
  return { calls,
    beginNavigation() { calls.push(['navigation']); return new AbortController().signal; },
    async createWorkspace(input) { calls.push(['workspace', input]); return { workspaceId: 'workspace-test', path: input.path }; },
    async createSession(input) { calls.push(['session', input]); return `session-test-${++next}`; },
    openSession(id) { calls.push(['open', id]); },
    ...overrides,
  };
}

/** 足够覆盖本插件 DOM Interface 的可控实现，不声称是浏览器或 OS 拖放。 */
export class Element extends EventEmitter {
  constructor(tag = 'div', attrs = {}) {
    super(); this.tagName = tag; this.attrs = { ...attrs }; this.children = [];
    const classes = new Set();
    this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  matches(selector) {
    if (selector === '#zone') return this.attrs.id === 'zone';
    return selector.split(',').some(part => {
      const match = /^\[([^\]]+)\]$/u.exec(part.trim());
      if (!match) throw new SyntaxError('Invalid fixture selector');
      return Object.hasOwn(this.attrs, match[1]);
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  addEventListener(name, handler) { this.on(name, handler); }
  removeEventListener(name, handler) { this.off(name, handler); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
}
export class Document extends EventEmitter {
  constructor() {
    super(); this.documentElement = new Element('html'); this.head = new Element('head'); this.body = new Element('body');
    this.documentElement.append(this.head, this.body);
    this.workspace = new Element('div');
    this.header = new Element('div', { 'data-sidebar-workspace-header': '' });
    this.list = new Element('div', { 'data-sidebar-list-area': '' });
    this.row = new Element('button'); this.list.append(this.row);
    this.workspace.append(this.header, this.list); this.body.append(this.workspace);
    this.outside = new Element('main'); this.body.append(this.outside);
  }
  createElement(tag) { return new Element(tag); }
  querySelectorAll(selector) {
    const results = [];
    function walk(element) { if (element.matches(selector)) results.push(element); element.children.forEach(walk); }
    walk(this.documentElement); return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(name, handler) { this.on(name, handler); }
  removeEventListener(name, handler) { this.off(name, handler); }
  dispatch(name, event) { this.emit(name, event); }
}
export function fakeWindow(pathFor = file => `E:\\工程\\${file.name}`) {
  const emitter = new EventEmitter();
  return { __DSH_HOST_PATHS__: { pathFor },
    addEventListener: (name, listener) => emitter.on(name, listener),
    removeEventListener: (name, listener) => emitter.off(name, listener),
    listenerCount: name => emitter.listenerCount(name),
    dispatch: name => emitter.emit(name),
  };
}
export function dragEvent(target, dataTransfer) {
  const event = { target, dataTransfer, defaultPrevented: false, stopped: false, relatedTarget: null,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
    composedPath() { const nodes = []; for (let node = target; node; node = node.parentElement) nodes.push(node); return nodes; },
  };
  return event;
}
export function feedback() {
  return { messages: [], disposed: false,
    show(kind, message) { this.messages.push({ kind, message }); },
    dispose() { this.disposed = true; },
  };
}
export async function flush() {
  // 仅排空微任务和一轮事件循环；没有定时轮询或真实网络/Host 工作。
  await new Promise(resolve => setImmediate(resolve));
}
