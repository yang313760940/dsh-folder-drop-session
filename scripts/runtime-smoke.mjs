#!/usr/bin/env node
/**
 * 对已安装 dsh 的真实 Cordis + ClientModuleSystem 做隔离 smoke test。
 * 不连接运行中 Host，不碰 profile、会话、工作区或用户目录。
 * 用 --modules 指定安装版 node_modules；只有文件解析/读取。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createContext, Script } from 'node:vm';
import { Document, fakeWindow, fakeHost, directory, transfer, dragEvent, flush } from '../test/fixtures.mjs';

const index = process.argv.indexOf('--modules');
const modules = index >= 0 ? process.argv[index + 1] : process.env.DSH_RUNTIME_MODULES;
if (!modules) throw new Error('Usage: node scripts/runtime-smoke.mjs --modules "<dsh runtime node_modules>"');
const cordisPath = join(resolve(modules), '@deepseek-ai/cordis/lib/index.js');
const { Context } = await import(pathToFileURL(cordisPath).href);
const doc = new Document(); const win = fakeWindow();
const target = { mode: 'queue', pendingQueue: [], load(row) { this.pendingQueue.push(row); } };
win.__ModuleLoader__ = target;
// 模块物化阶段暂不提供 document，测试真实加载器无需访问 DOM 的分支。
const sandbox = createContext({ window: win, AbortController, WeakSet, Set, Object, console, setTimeout, clearTimeout });
const kernelSource = await readFile(join(resolve(modules), '@deepseek-ai/dsh-client-modules/lib/client.js'), 'utf8');
new Script(kernelSource).runInContext(sandbox);
const bootstrap = target.pendingQueue.shift();
assert.equal(bootstrap.id, '@deepseek-ai/dsh-client-modules');
const kernel = bootstrap.factory(() => { throw new Error('Unexpected kernel external import'); });
const moduleSystem = kernel.createClientModuleSystem(target, { id: bootstrap.id, exports: kernel }, {
  boot: { rev: 'isolated-fixture', entries: [], batches: [] },
  staticModules: {},
  loadBundle: async () => { throw new Error('Unexpected network fetch'); },
});
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
new Script(source).runInContext(sandbox);
const plugin = await moduleSystem.import('dsh-folder-drop-session');
assert.equal(typeof plugin.apply, 'function');
sandbox.document = doc;
const ctx = new Context(); const host = fakeHost();
ctx.provide('workspaces', { create: host.createWorkspace.bind(host) });
ctx.provide('sessions', { create: host.createSession.bind(host) });
ctx.provide('uiWorkspace', { openSession: host.openSession.bind(host) });
ctx.provide('layout', { beginNavigation: host.beginNavigation.bind(host) });
const fiber = ctx.plugin(plugin, { directoryCheckTimeoutMs: 500 });
await fiber; // Cordis Fiber thenable：等待 inject 与 effect 挂载。
assert.equal(doc.listenerCount('drop'), 1);
doc.dispatch('drop', dragEvent(doc.row, transfer([directory('runtime-smoke')])));
await flush();
assert.equal(host.calls.filter(call => call[0] === 'session').length, 1);
assert.equal(host.calls.at(-1)[0], 'open');
await fiber.dispose();
assert.equal(doc.listenerCount('drop'), 0);
assert.equal(doc.querySelector('[data-dsh-folder-drop-notice]'), null);
console.log('PASS: installed client module system and Cordis accepted the generated Client plugin; inject, drop/create/open, and disposal succeeded in an isolated fixture.');
console.log('Native OS drag/drop and actual dsh session persistence remain separate manual acceptance checks.');
