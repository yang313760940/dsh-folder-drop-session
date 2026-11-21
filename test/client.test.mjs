import test from 'node:test';
import assert from 'node:assert/strict';
import { mountFolderDrop, findDropRegion, createFeedback } from '../src/client.mjs';
import { Document, Element, fakeWindow, fakeHost, feedback, directory, transfer, dragEvent, flush, deferred } from './fixtures.mjs';

function setup(overrides = {}) {
  const document = new Document(); const window = fakeWindow(); const host = fakeHost(); const ui = feedback();
  const state = { document, window, host, feedback: ui, ...overrides };
  state.dispose = mountFolderDrop(state); return state;
}

test('完整 drop 事件链创建新会话并选中指定目录', async () => {
  const state = setup();
  try {
    const event = dragEvent(state.document.row, transfer([directory('方案')]));
    state.document.dispatch('drop', event);
    assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
    await flush();
    assert.deepEqual(state.host.calls, [['navigation'], ['workspace', { path: 'E:\\工程\\方案' }], ['session', { workspaceId: 'workspace-test' }], ['open', 'session-test-1']]);
    assert.equal(state.feedback.messages.at(-1).kind, 'success');
  } finally { state.dispose(); }
});

test('原始 DataTransfer 在事件结束后清空仍可完成，路径在 await 之前读取', async () => {
  const state = setup();
  try {
    const data = transfer([directory('同步快照')]);
    state.document.dispatch('drop', dragEvent(state.document.row, data));
    data.items = []; data.files = [];
    await flush();
    assert.equal(state.host.calls[1][1].path, 'E:\\工程\\同步快照');
  } finally { state.dispose(); }
});

test('普通文件和字符串 drop 透传，目录 drop 默认全文档接管', async () => {
  const state = setup();
  try {
    for (const [target, data] of [[state.document.row, transfer([{ name: 'note.txt', isDirectory: false }])],
      [state.document.row, { types: ['text/plain'], items: [{ kind: 'string' }] }]]) {
      const event = dragEvent(target, data); state.document.dispatch('drop', event);
      assert.equal(event.defaultPrevented, false); assert.equal(event.stopped, false);
    }
    const outside = dragEvent(state.document.outside, transfer([directory('工作区外')]));
    state.document.dispatch('drop', outside);
    assert.equal(outside.defaultPrevented, true); assert.equal(outside.stopped, true);
    await flush(); assert.equal(state.host.calls.length, 4);
    assert.equal(state.host.calls[1][1].path, 'E:\\工程\\工作区外');
  } finally { state.dispose(); }
});

test('工作区栏 header/list 共同父区域可接收；不靠 CSS 或语言', () => {
  const document = new Document();
  assert.equal(findDropRegion(document, dragEvent(document.row)), document.workspace);
  assert.equal(findDropRegion(document, dragEvent(document.header)), document.workspace);
  assert.equal(findDropRegion(document, dragEvent(document.outside)), null);
});

test('自定义显式区域替换默认区域，不把全页面当工作区', () => {
  const document = new Document(); const zone = new Element('aside', { id: 'zone' }); document.body.append(zone);
  assert.equal(findDropRegion(document, dragEvent(zone), '#zone'), zone);
  assert.equal(findDropRegion(document, dragEvent(document.row), '#zone'), null);
});

test('默认模式不依赖区域标记：全文档接收文件夹', async () => {
  const document = new Document(); delete document.header.attrs['data-sidebar-workspace-header']; delete document.list.attrs['data-sidebar-list-area'];
  const state = setup({ document });
  try {
    const event = dragEvent(document.row, transfer([directory()])); document.dispatch('drop', event);
    assert.equal(event.stopped, true); await flush();
    assert.equal(state.host.calls.filter(call => call[0] === 'session').length, 1);
  } finally { state.dispose(); }
});

test('dragover 全文档接受 Files，blur/leave 清除高亮', () => {
  const state = setup();
  try {
    const event = dragEvent(state.document.row, { types: ['Files'] }); state.document.dispatch('dragover', event);
    assert.equal(event.defaultPrevented, true); assert.equal(event.dataTransfer.dropEffect, 'copy');
    assert.equal(state.document.workspace.classList.contains('dsh-folder-drop-active'), true);
    state.window.dispatch('blur'); assert.equal(state.document.workspace.classList.contains('dsh-folder-drop-active'), false);
    const text = dragEvent(state.document.row, { types: ['text/plain'] }); state.document.dispatch('dragover', text); assert.equal(text.defaultPrevented, false);
    const outside = dragEvent(state.document.outside, { types: ['Files'] }); state.document.dispatch('dragover', outside);
    assert.equal(outside.defaultPrevented, true);
    assert.equal(state.document.workspace.classList.contains('dsh-folder-drop-active'), false);
  } finally { state.dispose(); }
});

test('多目录只创建一次并给出被忽略数量', async () => {
  const state = setup();
  try {
    state.document.dispatch('drop', dragEvent(state.document.row, transfer([directory('A'), directory('B')])));
    await flush();
    assert.equal(state.host.calls.filter(call => call[0] === 'session').length, 1);
    assert.match(state.feedback.messages.at(-1).message, /2 个文件夹/u);
  } finally { state.dispose(); }
});

test('并发拖入不排队，完成后再次拖入同目录仍新建', async () => {
  const gate = deferred(); let count = 0;
  const host = fakeHost({ createSession: async () => { count++; return count === 1 ? gate.promise : 'session-second'; } });
  const state = setup({ host });
  try {
    const make = () => dragEvent(state.document.row, transfer([directory()]));
    state.document.dispatch('drop', make()); await flush();
    const ignored = make(); state.document.dispatch('drop', ignored);
    assert.equal(ignored.stopped, true); assert.equal(count, 1);
    assert.match(state.feedback.messages.at(-1).message, /本次拖入未处理/u);
    gate.resolve('session-first'); await flush();
    state.document.dispatch('drop', make()); await flush(); assert.equal(count, 2);
  } finally { state.dispose(); }
});

test('同一个已消费 Event 重放不重复创建', async () => {
  const state = setup();
  try {
    const event = dragEvent(state.document.row, transfer([directory()]));
    state.document.dispatch('drop', event); await flush(); state.document.dispatch('drop', event); await flush();
    assert.equal(state.host.calls.filter(call => call[0] === 'session').length, 1);
  } finally { state.dispose(); }
});

test('普通浏览器无桥：显示原因、消费目录，不创建', async () => {
  const state = setup({ window: fakeWindow() }); delete state.window.__DSH_HOST_PATHS__;
  try {
    const event = dragEvent(state.document.row, transfer([directory()])); state.document.dispatch('drop', event);
    await flush(); assert.equal(event.stopped, true); assert.equal(state.host.calls.length, 0);
    assert.equal(state.feedback.messages.at(-1).kind, 'error'); assert.match(state.feedback.messages.at(-1).message, /原生路径桥/u);
  } finally { state.dispose(); }
});

test('无权限目录失败给提示且页面继续可用', async () => {
  const state = setup();
  try {
    state.document.dispatch('drop', dragEvent(state.document.row, transfer([directory('blocked', (_yes, no) => no(new Error('EACCES')))])));
    await flush(); assert.equal(state.feedback.messages.at(-1).kind, 'error');
    assert.equal(state.host.calls.filter(call => call[0] === 'workspace').length, 0);
    state.document.dispatch('drop', dragEvent(state.document.row, transfer([directory('good')]))); await flush();
    assert.equal(state.feedback.messages.at(-1).kind, 'success');
  } finally { state.dispose(); }
});

test('卸载撤回全部监听与 UI，幂等且可重新启用', async () => {
  const state = setup(); assert.equal(state.document.listenerCount('drop'), 1);
  state.dispose(); state.dispose();
  for (const name of ['drop', 'dragover', 'dragleave', 'dragend']) assert.equal(state.document.listenerCount(name), 0);
  assert.equal(state.window.listenerCount('blur'), 0); assert.equal(state.feedback.disposed, true);
  state.document.dispatch('drop', dragEvent(state.document.row, transfer([directory()]))); await flush(); assert.equal(state.host.calls.length, 0);
  const stop = mountFolderDrop({ ...state, feedback: feedback() }); stop();
});

test('目录检查期间卸载，迟到 callback 不创建会话', async () => {
  let finish;
  const state = setup();
  state.document.dispatch('drop', dragEvent(state.document.row, transfer([directory('wait', yes => { finish = yes; })])));
  state.dispose(); finish([]); await flush();
  assert.deepEqual(state.host.calls, [['navigation']]);
});

test('disabled 配置不监听；重复挂载有明确错误', () => {
  const document = new Document(); const window = fakeWindow(); const host = fakeHost();
  mountFolderDrop({ document, window, host, config: { enabled: false } })();
  assert.equal(document.listenerCount('drop'), 0);
  const stop = mountFolderDrop({ document, window, host, feedback: feedback() });
  try { assert.throws(() => mountFolderDrop({ document, window, host, feedback: feedback() }), /已挂载/u); } finally { stop(); }
});

test('提示只用 textContent；卸载删除自有 DOM', () => {
  const document = new Document(); const ui = createFeedback(document);
  const box = document.querySelector('[data-dsh-folder-drop-notice]');
  ui.show('error', '<img src=x onerror=alert(1)>');
  assert.equal(box.children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(box.getAttribute('role'), 'alert'); assert.equal(box.hidden, false);
  ui.dispose(); assert.equal(document.querySelector('[data-dsh-folder-drop-notice]'), null);
  assert.equal(document.head.children.length, 0);
});
