#!/usr/bin/env node
/**
 * 生成开源市场的 format-1 索引（index.json）。
 * 版本条目由 git 提交固定（source.type = git，完整 40 位 SHA），
 * 构建时读取 package.json 与仓库根 icon.png 内联为 data URL。
 *
 * 用法：node scripts/build-market.mjs [--commit <sha>] [--timestamp <unix>]
 * 无 --commit 时读取 git HEAD；无 --timestamp 时取当前时间。
 */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const readme = await readFile(new URL('README.md', root), 'utf8');
const args = process.argv.slice(2);
const argOf = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const commit = (argOf('--commit') ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).trim();
if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`Not a 40-hex commit: ${commit}`);
const timestamp = Number(argOf('--timestamp') ?? Math.floor(Date.now() / 1000));
const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' }).trim();
const repoUrl = remote.replace(/\.git$/u, '');
const iconBytes = await readFile(new URL('assets/icon.png', root));
const icon = `data:image/png;base64,${iconBytes.toString('base64')}`;

const oneLine = text => text.split('\n').map(line => line.trim()).filter(Boolean)[0] ?? '';
const index = {
  format: 1,
  title: { en: 'dsh-folder-drop-session', zh: '文件夹拖入创建对话' },
  description: {
    en: 'Local dsh plugins by yang313760940.',
    zh: 'yang313760940 的本地 dsh 插件源。',
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Folder Drop Conversations', zh: '文件夹拖入创建对话' },
      description: {
        en: 'Drop a folder from the file manager into dsh; a new conversation opens rooted in that folder. Single files keep the normal attachment behavior.',
        zh: '把文件夹从文件管理器拖进 dsh，自动以该文件夹为工作区新建对话；单个文件仍按原有附件逻辑处理。',
      },
      author: 'yang313760940',
      homepage: `${repoUrl}#readme`,
      repository: { url: repoUrl },
      icon,
      metadata: { category: 'productivity', labels: ['workspace', 'session', 'drag-drop'] },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: timestamp,
          source: { type: 'git', url: repoUrl, commit },
          engines: { dsh: pkg.engines.dsh },
        },
      ],
    },
  ],
  metadata: {
    categories: {
      productivity: { title: { en: 'Productivity', zh: '效率工具' } },
    },
    labels: {
      workspace: { title: { en: 'Workspaces', zh: '工作区' } },
      session: { title: { en: 'Conversations', zh: '对话' } },
      'drag-drop': { title: { en: 'Drag and drop', zh: '拖放' } },
    },
  },
};

await mkdir(new URL('market-dist/', root), { recursive: true });
await writeFile(new URL('market-dist/index.json', root), `${JSON.stringify(index, null, 2)}\n`);
console.log(`market-dist/index.json written: ${pkg.name}@${pkg.version} @ ${commit.slice(0, 12)} (${repoUrl})`);
void readme; void oneLine;
