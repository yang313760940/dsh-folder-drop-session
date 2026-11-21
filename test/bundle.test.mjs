import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';
import { inject } from '../src/client.mjs';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('预构建 bundle 注册真实 __ModuleLoader__.load 惰性 factory，加载无 DOM 副作用', async () => {
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const rows = [];
  const context = createContext({ window: { __ModuleLoader__: { load: row => rows.push(row) } } });
  new Script(code).runInContext(context);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, pkg.name); assert.equal(typeof rows[0].factory, 'function');
  const exported = rows[0].factory(() => { throw new Error('Client should need no external require'); });
  assert.equal(typeof exported.apply, 'function'); assert.deepEqual(Array.from(exported.inject), inject);
});

test('Host 入口是可加载的无副作用 Cordis 插件', async () => {
  const plugin = await import('../lib/index.js'); assert.equal(typeof plugin.apply, 'function'); assert.equal(plugin.apply(), undefined);
});

test('清单同时声明 bundle 和 client，使用已核实 patch/export 形态', async () => {
  assert.equal(pkg.dsh.client.platform, 'web'); assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml'); assert.equal(pkg.engines.dsh, '0.2.2-rc.3');
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /- insert:/u); assert.match(patch, /name: dsh-folder-drop-session/u);
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
});
