import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFolderDrop, validateNativePath, checkDirectoryReadable, createFolderConversation, normalizeConfig } from '../src/client.mjs';
import { directory, transfer, fileItem, fakeHost, deferred } from './fixtures.mjs';

const bridge = { pathFor: file => `E:\\中文 工程\\${file.name}` };

test('空拖放、文字、网页 URL 和单个普通文件不触发', () => {
  assert.deepEqual(snapshotFolderDrop(null, bridge), { kind: 'ignore' });
  assert.deepEqual(snapshotFolderDrop({ items: [{ kind: 'string' }] }, bridge), { kind: 'ignore' });
  const plain = { name: 'notes.txt', isDirectory: false, isFile: true };
  assert.deepEqual(snapshotFolderDrop(transfer([plain]), bridge), { kind: 'ignore' });
});

test('空文件绝不靠 size=0 判目录', () => {
  const file = { name: 'empty', size: 0, type: '' };
  const item = fileItem({ name: 'empty', isDirectory: false }, file);
  assert.equal(snapshotFolderDrop({ items: [item], files: [file] }, bridge).kind, 'ignore');
});

test('目录识别并同步快照桥接路径，虚拟 fullPath 不参与', () => {
  const drop = transfer([directory('方案 A')]);
  const result = snapshotFolderDrop(drop, bridge);
  drop.items = []; drop.files = [];
  assert.equal(result.kind, 'folder'); assert.equal(result.directoryCount, 1);
  assert.equal(result.folder.path, 'E:\\中文 工程\\方案 A');
  assert.notEqual(result.folder.path, result.folder.entry.fullPath);
});

test('混合/多目录只选首个目录，保留选择顺序，不扫描子目录', () => {
  const calls = [];
  const result = snapshotFolderDrop(transfer([{ name: 'file', isDirectory: false }, directory('A'), directory('B')]),
    { pathFor: file => { calls.push(file.name); return `E:\\${file.name}`; } });
  assert.equal(result.folder.name, 'A'); assert.equal(result.directoryCount, 2); assert.equal(result.ignoredFiles, 1);
  assert.deepEqual(calls, ['A']);
});

test('getAsFile 缺席时按 file 项顺序取原始 FileList，字符串项不偏移', () => {
  const entry = directory('Folder'); const original = { name: 'Folder' };
  const result = snapshotFolderDrop({ items: [{ kind: 'string' }, { kind: 'file', webkitGetAsEntry: () => entry }], files: [original] },
    { pathFor: file => { assert.equal(file, original); return 'C:\\Folder'; } });
  assert.equal(result.folder.path, 'C:\\Folder');
});

test('错误的 FileList 对应项不按名称猜路径', () => {
  const result = snapshotFolderDrop({ items: [{ kind: 'file', webkitGetAsEntry: () => directory('A') }], files: [{ name: 'B' }] }, bridge);
  assert.equal(result.error.code, 'file-snapshot-missing');
});

test('浏览器桥缺席/空路径/桥抛错都明确报错，没有虚拟路径 fallback', () => {
  const data = transfer([directory()]);
  assert.equal(snapshotFolderDrop(data, null).error.code, 'native-bridge-missing');
  assert.equal(snapshotFolderDrop(data, { pathFor: () => '' }).error.code, 'native-path-missing');
  assert.equal(snapshotFolderDrop(data, { pathFor: () => { throw new Error('bad file'); } }).error.code, 'native-path-failed');
});

test('路径保留中文空格，支持盘符、UNC、extended Windows 和 POSIX', () => {
  for (const path of ['E:\\项目 A', 'C:/Project', '\\\\server\\share\\工程', '\\\\?\\C:\\Long', '/Users/me/工程', '/']) {
    assert.equal(validateNativePath(path), path);
  }
  for (const path of ['', 'C:folder', '\\folder', 'relative', 'https://example.com', 'C:\\a\0b', undefined]) {
    assert.throws(() => validateNativePath(path));
  }
});

test('目录检查只读一次首批，空目录也正常', async () => {
  let reads = 0;
  await checkDirectoryReadable(directory('empty', success => { reads++; success([]); }));
  assert.equal(reads, 1);
});

test('无权限目录：callback 和同步异常都失败，Host 零调用', async () => {
  for (const read of [(_success, failure) => failure({ name: 'NotReadableError', message: 'EACCES' }), () => { throw new Error('EPERM'); }]) {
    const host = fakeHost();
    await assert.rejects(createFolderConversation({ path: 'E:\\blocked', entry: directory('blocked', read) }, host),
      error => error.code === 'directory-unreadable');
    assert.deepEqual(host.calls, []);
  }
});

test('目录检查超时和取消；迟到 callback 不改变已结算结果', async () => {
  let success;
  await assert.rejects(checkDirectoryReadable(directory('slow', yes => { success = yes; }), { timeoutMs: 5 }),
    error => error.code === 'directory-check-timeout');
  success([]);
  const controller = new AbortController();
  const pending = checkDirectoryReadable(directory('wait', () => {}), { signal: controller.signal });
  controller.abort(new Error('stopped'));
  await assert.rejects(pending, /stopped/u);
});

test('创建顺序严格：目录检查 → workspace({path}) → session({workspaceId}) → open(id)', async () => {
  const host = fakeHost();
  const result = await createFolderConversation({ path: 'E:\\工程', entry: directory() }, host);
  assert.equal(result.opened, true);
  assert.deepEqual(host.calls, [['workspace', { path: 'E:\\工程' }], ['session', { workspaceId: 'workspace-test' }], ['open', 'session-test-1']]);
});

test('每次有效拖入都新建，API 请求没有旧 sessionId/cwd', async () => {
  const host = fakeHost(); const folder = { path: '/tmp/project', entry: directory() };
  const first = await createFolderConversation(folder, host); const second = await createFolderConversation(folder, host);
  assert.notEqual(first.sessionId, second.sessionId);
  for (const [, input] of host.calls.filter(call => call[0] === 'session')) assert.deepEqual(Object.keys(input), ['workspaceId']);
});

test('Host canonical path 回传后用它展示，Session 的 cwd 由 Host 绑定', async () => {
  const host = fakeHost({ createWorkspace: async () => ({ workspaceId: 'w', path: 'E:\\real' }) });
  const result = await createFolderConversation({ path: 'E:\\link', entry: directory() }, host);
  assert.equal(result.path, 'E:\\real'); assert.deepEqual(host.calls[0], ['session', { workspaceId: 'w' }]);
});

test('工作区登记失败：不创建会话、不导航', async () => {
  const host = fakeHost({ createWorkspace: async () => { throw new Error('ENOENT'); } });
  await assert.rejects(createFolderConversation({ path: 'E:\\deleted', entry: directory() }, host), /ENOENT/u);
  assert.deepEqual(host.calls, []);
});

test('会话创建失败：保留登记，报告部分状态，零自动重试', async () => {
  let attempts = 0;
  const host = fakeHost({ createSession: async () => { attempts++; throw { rpcError: { code: 'session/workspace-attach-failed', message: 'attach failed', details: { sessionId: 'session-existing' } } }; } });
  await assert.rejects(createFolderConversation({ path: 'E:\\project', entry: directory() }, host), error => {
    assert.equal(error.code, 'session-create-failed'); assert.equal(error.details.workspaceId, 'workspace-test');
    assert.equal(error.details.sessionId, 'session-existing'); return true;
  });
  assert.equal(attempts, 1); assert.equal(host.calls.length, 1);
});

test('另一次导航在创建途中发生：会话保留，但不抢回用户视图', async () => {
  const gate = deferred(); const controller = new AbortController();
  const host = fakeHost({ createSession: () => gate.promise });
  const pending = createFolderConversation({ path: 'E:\\project', entry: directory() }, host, { navigationSignal: controller.signal });
  await Promise.resolve(); await Promise.resolve(); controller.abort(); gate.resolve('session-created');
  const result = await pending; assert.equal(result.opened, false);
  assert.equal(host.calls.filter(call => call[0] === 'open').length, 0);
});

test('视图打开失败报告已创建会话，保留恢复身份', async () => {
  const host = fakeHost({ openSession: () => { throw new Error('view unavailable'); } });
  await assert.rejects(createFolderConversation({ path: 'E:\\project', entry: directory() }, host),
    error => error.code === 'session-open-failed' && error.details.sessionId === 'session-test-1');
});

test('注册中途卸载：只保留登记，不继续创建', async () => {
  const controller = new AbortController();
  const host = fakeHost({ createWorkspace: async () => { controller.abort(); return { workspaceId: 'w', path: '/project' }; } });
  await assert.rejects(createFolderConversation({ path: '/project', entry: directory() }, host, { signal: controller.signal }));
  assert.equal(host.calls.length, 0);
});

test('配置默认值、范围和拼写错误都可检查', () => {
  assert.equal(normalizeConfig().maxItems, 128);
  for (const config of [null, [], { enabled: 1 }, { targetSelector: '' }, { maxItems: 0 }, { directoryCheckTimeoutMs: 0 }, { typo: true }]) {
    assert.throws(() => normalizeConfig(config));
  }
});
