/**
 * 文件夹拖放 → 新会话：纯浏览器 ESM，没有 Node、Electron 或第三方运行时 import。
 *
 * 外部 Interface：apply(ctx, config)（Cordis 插件），mountFolderDrop(...)
 * （可注入依赖的测试 Seam）。Host Adapter 只用已核实的四个 dsh 服务方法。
 * 不读取目录内文件内容、不上传目录、不发消息、不修改宿主或旧会话的 cwd。
 */

const inject = ['workspaces', 'sessions', 'uiWorkspace', 'layout'];
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  targetSelector: null,
  directoryCheckTimeoutMs: 8000,
  maxItems: 128,
});
const mountedDocuments = new WeakSet();

class FolderDropError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FolderDropError';
    this.code = code;
    this.details = details;
  }
}

function normalizeConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('folder-drop-session: config 应为对象');
  }
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new TypeError(`未知配置项：${key}`);
  }
  const config = { ...DEFAULT_CONFIG, ...input };
  if (typeof config.enabled !== 'boolean') throw new TypeError('enabled 应为 boolean');
  if (config.targetSelector !== null && (typeof config.targetSelector !== 'string'
      || config.targetSelector.trim() === '')) throw new TypeError('targetSelector 应为非空 CSS selector 或 null');
  if (!Number.isInteger(config.directoryCheckTimeoutMs)
      || config.directoryCheckTimeoutMs < 100 || config.directoryCheckTimeoutMs > 60000) {
    throw new TypeError('directoryCheckTimeoutMs 应为 100..60000 的整数');
  }
  if (!Number.isInteger(config.maxItems) || config.maxItems < 1 || config.maxItems > 1024) {
    throw new TypeError('maxItems 应为 1..1024 的整数');
  }
  return Object.freeze(config);
}

/** 只接收原生桥返回的绝对路径；绝不把 /entry.fullPath 当本地路径。 */
function validateNativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 32768
      || path.includes('\0') || !/^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(path)) {
    throw new FolderDropError('native-path-missing',
      '拖入对象未取得有效的本地绝对路径。请在 dsh 桌面客户端窗口拖入原始文件夹。');
  }
  return path; // 保留中文、空格与原始大小写；规范化交给 Host workspaceRegistry。
}

/**
 * 必须在 drop 的同步调用栈中执行：跨过 await 后 DataTransfer 会回到保护模式。
 * 只用真实 FileSystemEntry.isDirectory 判型，不靠 File.type、扩展名或零字节。
 * 同次拖放只选第一个目录；普通文件不被转换为工作区，其他目录不创建会话。
 * 返回 kind=folder 时即使路径取失败也由插件接管，避免 Chromium 导航离开页面。
 */
function snapshotFolderDrop(dataTransfer, pathBridge, maxItems = DEFAULT_CONFIG.maxItems) {
  if (!dataTransfer) return { kind: 'ignore' };
  const items = Array.from(dataTransfer.items ?? []);
  const files = Array.from(dataTransfer.files ?? []);
  let first;
  let directoryCount = 0;
  let ignoredFiles = 0;
  let fileIndex = 0;
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const correspondingFile = files[fileIndex++];
    const getEntry = item.getAsEntry ?? item.webkitGetAsEntry;
    if (typeof getEntry !== 'function') continue;
    let entry;
    try { entry = getEntry.call(item); } catch { continue; }
    if (entry?.isDirectory !== true) { ignoredFiles++; continue; }
    directoryCount++;
    if (first === undefined) {
      let file;
      try { file = item.getAsFile?.() ?? correspondingFile; } catch { file = correspondingFile; }
      // FileList 顺序对应 file-kind items；名称不同就报缺失，绝不按名称猜路径。
      if (file?.name !== entry.name) file = undefined;
      first = { entry, file, name: entry.name };
    }
  }
  if (first === undefined) return { kind: 'ignore' };
  const snapshot = { kind: 'folder', directoryCount, ignoredFiles, folder: first };
  try {
    if (items.length > maxItems) throw new FolderDropError('too-many-items',
      `本次拖入对象超过 ${maxItems} 项，请分批拖入。`);
    if (typeof pathBridge?.pathFor !== 'function') throw new FolderDropError('native-bridge-missing',
      '此窗口没有 __DSH_HOST_PATHS__.pathFor 原生路径桥。请使用 dsh 桌面窗口；普通浏览器拖放仅暴露虚拟条目路径。');
    if (!first.file) throw new FolderDropError('file-snapshot-missing',
      '文件夹的原生 File 对象缺失，请重新从文件管理器拖入原始文件夹。');
    // 已安装版 preload 内部调用 electron.webUtils.getPathForFile(file)。
    first.path = validateNativePath(pathBridge.pathFor(first.file));
  } catch (error) {
    snapshot.error = error instanceof FolderDropError ? error
      : new FolderDropError('native-path-failed', `原生路径读取失败：${errorText(error)}`);
  }
  return snapshot;
}

/**
 * 检查目录的读/列举权限。仅请求首个有界批次，丢弃结果，不递归也不读取文件。
 * Chromium 对 FileSystemDirectoryReader 的失败走 error callback。
 * 给回调 API 补充超时与生命周期取消；底层回调迟到时没有后续副作用。
 * Host 的 workspace.create 还会用 realpath+stat 独立验证实际目录。
 */
function checkDirectoryReadable(entry, { signal, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = () => finish(signal.reason ?? new FolderDropError('cancelled', '目录检查已结束。'));
    if (signal?.aborted) { onAbort(); return; }
    if (entry?.isDirectory !== true || typeof entry.createReader !== 'function') {
      finish(new FolderDropError('directory-reader-missing', '目录列举检查接口缺失，本次没有创建会话。'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new FolderDropError('directory-check-timeout',
      '文件夹检查超时。请检查网络盘、目录连接或文件夹访问权限后再拖入。')), timeoutMs);
    try {
      entry.createReader().readEntries(
        () => finish(),
        error => finish(new FolderDropError('directory-unreadable',
          `文件夹访问失败，请检查读/列举权限：${errorText(error)}`)),
      );
    } catch (error) {
      finish(new FolderDropError('directory-unreadable', `文件夹访问失败：${errorText(error)}`));
    }
  });
}

/**
 * 深 Module：小 Interface 隐藏目录检查、工作区幂等注册、会话创建及导航。
 * 两个实际 Adapter：dsh services（生产）和可控假 Host（测试）。
 * 返回具体持久结果；不是跨两个 Host 方法的事务，失败保留已完成步骤。
 */
async function createFolderConversation(folder, host, { signal, navigationSignal, timeoutMs = 8000 } = {}) {
  const path = validateNativePath(folder?.path);
  await checkDirectoryReadable(folder.entry, { signal, timeoutMs });
  signal?.throwIfAborted();
  const workspace = await host.createWorkspace({ path });
  if (typeof workspace?.workspaceId !== 'string' || workspace.workspaceId.length === 0
      || typeof workspace.path !== 'string') {
    throw new FolderDropError('workspace-response-invalid', '工作区注册响应缺少身份或路径，请检查宿主版本。');
  }
  // 卸载发生在注册中途时，保留已注册目录，但不继续创建会话。
  signal?.throwIfAborted();
  let sessionId;
  try {
    // 特意省略 sessionId：每次有效 drop 都新建，不复用之前的空白会话。
    // workspaceId 与 cwd 在 dsh 接口中互斥，工作区路径由 Host 转成 Session cwd。
    sessionId = await host.createSession({ workspaceId: workspace.workspaceId });
  } catch (error) {
    const rpc = error?.rpcError;
    const existingId = rpc?.details?.sessionId;
    throw new FolderDropError('session-create-failed',
      `会话创建未完成。工作区已登记；请先核对会话列表再重试。${existingId ? ` 已创建的会话身份：${existingId}。` : ''} ${errorText(error)}`,
      { workspaceId: workspace.workspaceId, path: workspace.path, sessionId: existingId, rpcError: rpc });
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new FolderDropError('session-response-invalid',
      '会话创建响应缺少身份，创建状态待核对。请先检查会话列表再重试。',
      { workspaceId: workspace.workspaceId, path: workspace.path });
  }
  const result = { workspaceId: workspace.workspaceId, path: workspace.path, sessionId, opened: false };
  // 另一次用户导航优先于晚到的 drop 响应；会话仍保留在新工作区下。
  if (signal?.aborted || navigationSignal?.aborted) return result;
  try { host.openSession(sessionId); } catch (error) {
    throw new FolderDropError('session-open-failed',
      `新会话已创建，视图切换失败。请在工作区列表打开会话 ${sessionId}。${errorText(error)}`, result);
  }
  return { ...result, opened: true };
}

function errorText(error) {
  try {
    const code = error?.rpcError?.code ?? error?.code ?? error?.name;
    const message = error?.rpcError?.message ?? error?.message ?? String(error);
    return `${code && code !== 'Error' ? `${code}: ` : ''}${message}`.slice(0, 1800);
  } catch { return '未知错误'; }
}

function hasFilePayload(dataTransfer) {
  return Array.from(dataTransfer?.types ?? []).includes('Files');
}

/**
 * 高亮与显式区域限定：已核实的工作区栏 header/list 共同父容器。
 * 不依赖 locale、CSS-module hash、像素位置或模拟点击。
 * 每次事件查询当前 DOM，所以 React 换页/重挂载后仍有效。
 * 默认模式（selector=null）允许整个文档接收文件夹；此函数只为高亮
 * 和「显式区域模式」的限定判断提供区域。
 */
function findDropRegion(document, event, selector = null) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
  const elements = path.filter(value => value && typeof value.closest === 'function');
  if (selector !== null) {
    for (const element of elements) {
      const match = element.closest(selector);
      if (match) return match;
    }
    return null;
  }
  const roots = new Set(Array.from(document.querySelectorAll('[data-sidebar-workspace-header]'))
    .map(header => header.parentElement).filter(Boolean));
  for (const element of elements) {
    for (const root of roots) if (root === element || root.contains(element)) return root;
    // 兼容只挂载 list 的测试/定制壳，仍仅接管语义标记内的区域。
    const list = element.closest('[data-sidebar-list-area], [data-dsh-folder-drop-zone]');
    if (list) return list;
  }
  return null;
}

/** 插件自有提示，不使用 innerHTML，也不借用宿主未公开的 toast API。 */
function createFeedback(document) {
  const style = document.createElement('style');
  style.textContent = `
.dsh-folder-drop-active { outline: 2px dashed var(--dsw-alias-state-business-primary, #5b68f5); outline-offset: -2px; border-radius: 8px; }
[data-dsh-folder-drop-notice] { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; max-width: min(560px, calc(100vw - 48px)); padding: 14px 40px 14px 16px; border: 1px solid #7782e3; border-radius: 10px; box-shadow: 0 8px 30px #0003; background: var(--dsw-specific-sidebar-fill, #202433); color: var(--dsw-alias-label-primary, #f5f6ff); font: 14px/1.55 system-ui, sans-serif; white-space: pre-wrap; overflow-wrap: anywhere; pointer-events: auto; }
[data-dsh-folder-drop-notice][hidden] { display: none !important; }
[data-dsh-folder-drop-notice][data-kind=error] { border-color: #de6060; }
[data-dsh-folder-drop-notice] button { position: absolute; top: 6px; right: 8px; border: 0; background: transparent; color: inherit; cursor: pointer; font: 20px system-ui; }
`;
  const box = document.createElement('div');
  box.setAttribute('data-dsh-folder-drop-notice', '');
  box.setAttribute('aria-live', 'polite');
  box.setAttribute('role', 'status');
  box.hidden = true;
  const text = document.createElement('span');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', '关闭文件夹拖放提示');
  box.append(text, close);
  (document.head ?? document.documentElement).append(style);
  (document.body ?? document.documentElement).append(box);
  let timer;
  const hide = () => { clearTimeout(timer); box.hidden = true; };
  close.addEventListener('click', hide);
  return {
    show(kind, message) {
      clearTimeout(timer);
      text.textContent = message;
      box.setAttribute('data-kind', kind);
      box.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      box.hidden = false;
      if (kind === 'success' || kind === 'info') timer = setTimeout(hide, 7000);
    },
    dispose() {
      hide();
      close.removeEventListener('click', hide);
      box.remove();
      style.remove();
    },
  };
}

/**
 * Install 一个完整生命周期：capture 事件、实时区域识别、反馈、异步操作、卸载。
 * 原生 bridge 通过 getter 在 drop 时读取；不强制预加载 Electron 到主世界。
 * feedback 可注入，便于测试；mount 返回幂等 disposer。
 */
function mountFolderDrop({ document, window, host, config: rawConfig = {}, feedback }) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return () => {};
  if (mountedDocuments.has(document)) throw new FolderDropError('already-mounted', '此页面已挂载文件夹拖放插件。');
  if (config.targetSelector !== null) document.querySelector(config.targetSelector); // 挂载时校验 CSS 语法。
  mountedDocuments.add(document);
  const ui = feedback ?? createFeedback(document);
  const lifetime = new AbortController();
  const handled = new WeakSet();
  let disposed = false;
  let busy = false;
  let highlighted;
  const show = (kind, message) => {
    if (disposed) return;
    try { ui.show(kind, message); } catch (error) { console.warn('folder-drop feedback failed', error); }
  };
  const highlight = (element) => {
    if (element === highlighted) return;
    highlighted?.classList.remove('dsh-folder-drop-active');
    highlighted = element;
    highlighted?.classList.add('dsh-folder-drop-active');
  };
  const regionOf = event => findDropRegion(document, event, config.targetSelector);
  const onDragOver = event => {
    if (disposed) return;
    if (!hasFilePayload(event.dataTransfer)) return;
    const region = regionOf(event);
    highlight(region);
    // 保护模式阶段通常拿不到目录类型，先按 Files 临时接受。
    // 默认模式整个文档都可接收文件夹；显式区域模式只认领该区域。
    // 到 drop 才判型；单文件 drop 仍交回宿主处理。
    if (config.targetSelector !== null && !region) return;
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'copy'; } catch { /* 某些 native data store 只读。 */ }
  };
  const onDragLeave = event => {
    if (highlighted && !highlighted.contains(event.relatedTarget)) highlight(null);
  };
  const onDragEnd = () => highlight(null);
  const onDrop = event => {
    highlight(null);
    if (disposed) return;
    const region = regionOf(event);
    const snapshot = snapshotFolderDrop(event.dataTransfer, window.__DSH_HOST_PATHS__, config.maxItems);
    if (snapshot.kind !== 'folder') return; // 单文件/文字/网页链接：保留宿主行为。
    if (config.targetSelector !== null && !region) return; // 显式区域模式：仅该区域创建会话。
    event.preventDefault();
    event.stopImmediatePropagation(); // 已认领目录，避免附件插件也处理同一个 drop。
    if (handled.has(event)) return;
    handled.add(event);
    if (busy) { show('info', '上一份文件夹正在创建会话，本次拖入未处理。请等待完成后再拖入。'); return; }
    if (snapshot.error) { show('error', errorText(snapshot.error)); return; }
    busy = true;
    let navigationSignal;
    try { navigationSignal = host.beginNavigation(); } catch (error) {
      busy = false;
      show('error', errorText(error));
      return;
    }
    const extra = snapshot.directoryCount > 1 ? `\n本次有 ${snapshot.directoryCount} 个文件夹，仅处理第一个；其余文件夹与文件均忽略。` : '';
    show('pending', `正在为文件夹创建新会话：${snapshot.folder.path}${extra}`);
    // DataTransfer 已经完整同步快照；之后只保存原生 File/Entry/路径值。
    void createFolderConversation(snapshot.folder, host, {
      signal: lifetime.signal, navigationSignal, timeoutMs: config.directoryCheckTimeoutMs,
    }).then(result => {
      show(result.opened ? 'success' : 'info', result.opened
        ? `新会话已创建并选中。工作区：${result.path}${extra}`
        : `新会话已创建。后续导航优先，视图未切换；请在工作区列表打开 ${result.sessionId}。\n工作区：${result.path}${extra}`);
    }).catch(error => {
      if (!lifetime.signal.aborted) show('error', errorText(error));
    }).finally(() => { busy = false; });
  };
  document.addEventListener('dragover', onDragOver, true);
  document.addEventListener('drop', onDrop, true);
  document.addEventListener('dragleave', onDragLeave, true);
  document.addEventListener('dragend', onDragEnd, true);
  window.addEventListener('blur', onDragEnd);
  return () => {
    if (disposed) return;
    disposed = true;
    lifetime.abort(new FolderDropError('disposed', '插件已卸载。'));
    document.removeEventListener('dragover', onDragOver, true);
    document.removeEventListener('drop', onDrop, true);
    document.removeEventListener('dragleave', onDragLeave, true);
    document.removeEventListener('dragend', onDragEnd, true);
    window.removeEventListener('blur', onDragEnd);
    highlight(null);
    ui.dispose();
    mountedDocuments.delete(document);
  };
}

/** 真正的 dsh Client Adapter；所有方法签名见 docs/HOST-INTERFACES.md。 */
function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const workspaces = ctx.get('workspaces');
  const sessions = ctx.get('sessions');
  const uiWorkspace = ctx.get('uiWorkspace');
  const layout = ctx.get('layout');
  const host = {
    createWorkspace: request => workspaces.create(request),
    createSession: request => sessions.create(request),
    openSession: sessionId => uiWorkspace.openSession(sessionId),
    beginNavigation: () => layout.beginNavigation(),
  };
  ctx.effect(() => mountFolderDrop({ document, window, host, config }));
}

// 唯一 ESM export 块；离线 build 将同一份 Implementation 包进 dsh 的惰性 factory。
export {
  apply, inject, DEFAULT_CONFIG, FolderDropError, normalizeConfig, validateNativePath,
  snapshotFolderDrop, checkDirectoryReadable, createFolderConversation,
  findDropRegion, mountFolderDrop, createFeedback,
};
