#!/usr/bin/env node
/**
 * 零依赖离线构建：一个无 import 的浏览器 ESM 入口，唯一的尾部 export 块
 * 转成 dsh 的惰性 factory。不是通用 JS transpiler：超出此约束立即报错。
 * 原始 Implementation 一字不改地包进 factory；用 VM 验证生成 JS 语法。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const source = await readFile(new URL('src/client.mjs', root), 'utf8');
const match = /\nexport\s*\{([\s\S]*?)\};\s*$/u.exec(source);
if (!match) throw new Error('Client source needs exactly one trailing named export block');
const body = source.slice(0, match.index);
if (/^\s*(?:import|export)\s/mu.test(body)) {
  throw new Error('Offline build supports one self-contained entry; imports or other exports need a real bundler');
}
const names = match[1].split(',').map(name => name.trim()).filter(Boolean);
if (names.some(name => !/^[a-zA-Z_$][\w$]*$/u.test(name))
    || !names.includes('apply') || !names.includes('inject')) throw new Error('Invalid client export list');
const bundle = `// Generated from src/client.mjs; edit source and run npm run build.\n`
  + `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(pkg.name)},\n  factory: require => {\n'use strict';\n`
  + body + `\nreturn { ${names.join(', ')} };\n  },\n});\n`;
new Script(bundle, { filename: 'lib/client.js' });
await mkdir(new URL('lib/', root), { recursive: true });
await writeFile(new URL('lib/client.js', root), bundle);
await writeFile(new URL('lib/index.js', root), await readFile(new URL('src/index.mjs', root), 'utf8'));
console.log(`Built ${pkg.name}@${pkg.version}: ${fileURLToPath(new URL('lib/client.js', root))}`);
