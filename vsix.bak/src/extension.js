/**
 * Kaniburner VS Code 拡張
 * 環境依存の実装をここへ集約する。serialport によるシリアル通信、
 * WASM の解決、コマンドと UI。
 * プロトコルとコンパイル・実行のロジックは core.js が持つ。
 */
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const { SerialPort } = require('serialport');
const { MrbwriteProtocol, MrbcCompiler } = require('./core');

/** Makefile の MRUBY_VERSIONS と一致させる */
const AVAILABLE_VERSIONS = ['3.4.0', '4.0.0'];
const DEFAULT_VERSION = '4.0.0';
const DEFAULT_BAUD = 19200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {vscode.ExtensionContext} */ let extContext;
/** @type {vscode.OutputChannel}    */ let output;
/** @type {SerialTransport}         */ let serial;
/** @type {MrbwriteProtocol}        */ let protocol;
/** @type {MrbcCompiler}            */ let compiler;
/** @type {vscode.TextDocument}     */ let lastRbDoc = null;
/** @type {ExecuteViewProvider} */ let executeProvider;
/** @type {SimpleProvider}      */ let settingsProvider;
/** @type {SimpleProvider}      */ let projectProvider;

const info  = (msg) => output.appendLine(`[info]  ${msg}`);
const error = (msg) => { output.appendLine(`[error] ${msg}`); output.show(true); };

/** コアからのログを OutputChannel の表記へ揃える */
function logHook(kind, msg) {
  if (kind === 'error') error(msg);
  else if (kind === 'stderr') output.append(`[stderr] ${msg}`);
  else if (kind === 'stdout') output.append(msg);
  else info(msg);
}

/** 3ビューを一括再描画する。ツリーの描画は onDidChangeTreeData 発火のみに集約する */
function refreshAll() {
  if (executeProvider) executeProvider.refresh();
  if (settingsProvider) settingsProvider.refresh();
  if (projectProvider) projectProvider.refresh();
}

/**
 * serialport ラッパ
 * コアが要求する write に加えて、接続管理と BREAK 送信を提供する。受信は protocol.feed へ直結。
 */
class SerialTransport {
  constructor() {
    this.port = null;
    this.connected = false;
  }

  connect(portPath, baudRate) {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path: portPath, baudRate }, (err) => {
        if (err) return reject(err);
        this.port = port;
        this.connected = true;
        port.on('data', (buf) => protocol.feed(new Uint8Array(buf)));
        port.on('close', () => this._onClose());
        port.on('error', () => {});
        resolve();
      });
    });
  }

  _onClose() {
    if (!this.connected && !this.port) return;
    this.connected = false;
    this.port = null;
    protocol.reset();
    info('Disconnected.');
    refreshAll();
  }

  disconnect() {
    return new Promise((resolve) => {
      const p = this.port;
      if (!p) { this._onClose(); return resolve(); }
      this.connected = false;
      this.port = null;
      p.close(() => { protocol.reset(); resolve(); });
    });
  }

  write(bytes) {
    return new Promise((resolve, reject) => {
      if (!this.port) return reject(new Error('Not connected'));
      this.port.write(Buffer.from(bytes), (err) => (err ? reject(err) : resolve()));
    });
  }

  /** BREAK 信号でデバイスをソフトリセットする */
  sendBreak() {
    return new Promise((resolve) => {
      if (!this.port) return resolve();
      this.port.set({ brk: true }, () => {
        setTimeout(() => {
          if (this.port) this.port.set({ brk: false }, () => resolve());
          else resolve();
        }, 100);
      });
    });
  }
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length ? folders[0].uri.fsPath : null;
}

/** 相対パスはワークスペースルート基準。ワークスペースなしで相対なら解決不能 */
function toAbs(p) {
  if (!p) return null;
  if (path.isAbsolute(p)) return p;
  const root = workspaceRoot();
  return root ? path.join(root, p) : null;
}

/* --- 設定の保存先 --- */

function readConfig(context) {
  return context.workspaceState.get('kaniburner.config') || {};
}

function writeConfig(context, config) {
  context.workspaceState.update('kaniburner.config', config);
}

/** 欠落キーを既定値で補った設定ビュー */
function getSettings(context) {
  const c = readConfig(context) || {};
  const compilerCfg = (c.compiler && typeof c.compiler === 'object') ? c.compiler : {};
  const deviceCfg = (c.device && typeof c.device === 'object') ? c.device : {};
  return {
    version: compilerCfg.version || DEFAULT_VERSION,
    compiler: compilerCfg,
    port: deviceCfg.port || null,
    baud: deviceCfg.baud || DEFAULT_BAUD,
    libraries: Array.isArray(c.libraries) ? c.libraries : [],
    tasks: Array.isArray(c.tasks) ? c.tasks : []
  };
}

function updateCompiler(context, compilerObj) {
  const c = readConfig(context) || {};
  c.compiler = compilerObj;
  writeConfig(context, c);
  invalidateToolchain();
  refreshAll();
}

function updateDevice(context, patch) {
  const c = readConfig(context) || {};
  c.device = Object.assign({}, c.device, patch);
  writeConfig(context, c);
  refreshAll();
}

function addProjectEntry(context, key, filename) {
  const c = readConfig(context) || {};
  if (!Array.isArray(c[key])) c[key] = [];
  c[key].push({ filename });
  writeConfig(context, c);
  refreshAll();
}

function removeProjectEntry(context, key, index) {
  const c = readConfig(context) || {};
  if (Array.isArray(c[key]) && c[key][index]) {
    c[key].splice(index, 1);
    writeConfig(context, c);
    refreshAll();
  }
}

/** 書き込み順は配列順のため、入れ替えで順序を変える */
function moveProjectEntry(context, key, index, delta) {
  const c = readConfig(context) || {};
  const list = c[key];
  const to = index + delta;
  if (!Array.isArray(list) || !list[index] || to < 0 || to >= list.length) return;
  [list[index], list[to]] = [list[to], list[index]];
  writeConfig(context, c);
  refreshAll();
}

/* --- コンパイラの解決 --- */

/** compiler 設定の解決状態 */
function compilerStatus(context) {
  const version = getSettings(context).version;
  const known = AVAILABLE_VERSIONS.includes(version);
  return {
    version,
    resolved: known,
    dir: known ? path.join(context.extensionPath, 'media', `mruby-${version}`) : null,
    label: `mruby: ${version}`
  };
}

/** 現在のツールチェインが対応する設定シグネチャ。設定変更を検知して作り直す */
let toolchainKey = null;

/** コンパイル・実行に使う mruby WASM を準備する */
function ensureToolchain(context) {
  const st = compilerStatus(context);
  if (!st.resolved) {
    vscode.window.showErrorMessage(`Kaniburner: mruby ${st.version} が見つかりません。`);
    return false;
  }
  const key = JSON.stringify(getSettings(context).compiler);
  if (key === toolchainKey && compiler) return true;
  compiler = new MrbcCompiler(() => require(path.join(st.dir, 'mrbc.js')), { onLog: logHook });
  toolchainKey = key;
  return true;
}

function invalidateToolchain() {
  toolchainKey = null;
  compiler = null;
}

/* --- ソース解決・ポート・接続 --- */

/** パネル操作でフォーカスが .rb から外れても対象を解決できるよう、直近の .rb を記憶する */
function rememberEditor(editor) {
  if (editor && editor.document && editor.document.fileName.endsWith('.rb')) {
    lastRbDoc = editor.document;
  }
}

function activeRbDocument() {
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.fileName.endsWith('.rb')) return ed.document;
  if (lastRbDoc && !lastRbDoc.isClosed) return lastRbDoc;
  const vis = vscode.window.visibleTextEditors.find((e) => e.document.fileName.endsWith('.rb'));
  return vis ? vis.document : null;
}

/** 設定のエントリ群からソースを読む */
function readSources(entries, kindLabel) {
  const out = [];
  for (const entry of entries) {
    try {
      out.push({ filename: entry.filename, source: fs.readFileSync(toAbs(entry.filename), 'utf8') });
    } catch (e) {
      vscode.window.showWarningMessage(`Kaniburner: ${kindLabel} のファイルを開けません: ${entry.filename}`);
      return null;
    }
  }
  return out;
}

/** コンパイル対象のタスク一覧。設定の tasks を優先し、なければアクティブな .rb */
function resolveTaskSources(context) {
  const s = getSettings(context);
  if (s.tasks.length > 0) return readSources(s.tasks, 'tasks');
  const doc = activeRbDocument();
  if (!doc) {
    vscode.window.showWarningMessage('Kaniburner: .rbファイルを開いてください');
    return null;
  }
  return [{ filename: path.basename(doc.fileName), source: doc.getText() }];
}

/** ワークスペース配下で開かれている未登録 .rb タブの相対パス一覧 */
function openRbRelPaths(context, excludeKey) {
  const root = workspaceRoot();
  if (!root) return [];
  const existing = new Set(getSettings(context)[excludeKey].map((e) => e.filename));
  const set = new Set();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = tab.input && tab.input.uri;
      if (!uri || !uri.fsPath.endsWith('.rb')) continue;
      const rel = path.relative(root, uri.fsPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (!existing.has(rel)) set.add(rel);
    }
  }
  return [...set];
}

/** シリアルポートを選択させる。選択は device.port に保存する */
async function pickPort(context) {
  const cached = getSettings(context).port;
  let ports;
  try {
    ports = await SerialPort.list();
  } catch (e) {
    error(`Failed to list ports: ${e.message}`);
    return null;
  }
  if (!ports || ports.length === 0) {
    vscode.window.showErrorMessage('Kaniburner: No serial ports found.');
    return null;
  }
  const items = ports.map((p) => {
    const meta = [p.manufacturer, p.vendorId && `VID:${p.vendorId}`, p.productId && `PID:${p.productId}`]
      .filter(Boolean).join(' ');
    return { label: p.path, description: meta || undefined, path: p.path, picked: p.path === cached };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Kaniburner: Select serial port',
    placeHolder: cached ? `Last used: ${cached}` : 'Pick a port'
  });
  if (!picked) return null;
  updateDevice(context, { port: picked.path });
  return picked.path;
}

/**
 * デバイスをソフトリセットし、コマンドモードへ入り直す。
 * コマンドモード中は reset コマンド、実行モード中は BREAK 信号を使う。
 * リセット中はポートが一時的に消えることがあるため、再出現を最大30秒待って再接続する。
 */
async function resetAndReconnect(context) {
  if (!serial.connected) return false;
  const s = getSettings(context);
  if (protocol.commandMode) {
    await protocol.sendCommand('reset', { ignoreResponse: true });
  } else {
    info('> break');
    await serial.sendBreak();
  }
  protocol.reset();
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (serial.connected) break;
    try {
      const ports = await SerialPort.list();
      if (ports.some((p) => p.path === s.port)) {
        await serial.connect(s.port, s.baud);
        info('Reconnected.');
        refreshAll();
        break;
      }
    } catch (_) {}
  }
  if (!serial.connected) return false;
  return await protocol.ensureCommandMode();
}

/** 未接続なら device.port で接続する */
async function ensureConnected(context) {
  if (serial.connected) return true;
  const s = getSettings(context);
  let portPath = s.port;
  if (!portPath) {
    portPath = await pickPort(context);
    if (!portPath) return false;
  }
  info(`Connecting (${s.baud} baud, ${portPath})...`);
  try {
    await serial.connect(portPath, s.baud);
    info('Connected.');
    refreshAll();
    return true;
  } catch (e) {
    error(`Connect failed: ${e.message}`);
    return false;
  }
}

/** 接続してコマンドモードへ入る。直接入れない場合はリセット後に入り直す */
async function ensureReady(context) {
  if (!(await ensureConnected(context))) return false;
  if (await protocol.ensureCommandMode({ retries: 3 })) return true;
  return await resetAndReconnect(context);
}

async function compileSources(sources) {
  const out = [];
  for (const { filename, source } of sources) {
    const bc = await compiler.compile(source);
    if (!bc) {
      error(`Compile failed: ${filename}`);
      return null;
    }
    out.push(bc);
  }
  return out;
}

/** libraries と tasks をコンパイルする */
async function doCompile(context) {
  const libSources = readSources(getSettings(context).libraries, 'libraries');
  if (libSources === null) return null;
  const taskSources = resolveTaskSources(context);
  if (taskSources === null) return null;
  if (!ensureToolchain(context)) return null;
  info(`Compiling (mruby ${getSettings(context).version})...`);
  const libs = await compileSources(libSources);
  if (libs === null) return null;
  const tasks = await compileSources(taskSources);
  if (tasks === null) return null;
  const total = [...libs, ...tasks].reduce((n, b) => n + b.length, 0);
  info(`Compile succeeded. (${total} bytes)`);
  return { libs, tasks };
}

/* --- TreeView --- */

/** ビューごとの軽量プロバイダ。項目は都度 build して返す */
class SimpleProvider {
  constructor(build) {
    this._build = build;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }
  refresh() { this._emitter.fire(); }
  getTreeItem(item) { return item; }
  getChildren(element) { return this._build(element); }
}

/** 設定行。押下で QuickPick を開く */
function settingItem(label, commandId, iconName) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.command = { command: commandId, title: label };
  item.iconPath = new vscode.ThemeIcon(iconName);
  return item;
}

function buildSettingsView(element) {
  if (element) return [];
  const s = getSettings(extContext);
  const st = compilerStatus(extContext);
  const items = [
    settingItem(`Port: ${s.port || '(none)'}`, 'kaniburner.selectPort', 'plug'),
    settingItem(`Baud: ${s.baud}`, 'kaniburner.selectBaud', 'pulse')
  ];

  const vItem = settingItem(st.label, 'kaniburner.selectVersion', 'check');
  if (!st.resolved) {
    vItem.description = 'not found';
    vItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
  }
  items.push(vItem);
  return items;
}

function projectParent(label, kind, count) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
  item.contextValue = kind;
  item.kind = kind;
  item.description = String(count);
  item.iconPath = new vscode.ThemeIcon('folder');
  return item;
}

/** 端では入れ替え先が無いため、位置を contextValue に含めて上下ボタンを出し分ける */
function projectPosition(index, length) {
  if (length === 1) return 'Only';
  if (index === 0) return 'First';
  if (index === length - 1) return 'Last';
  return 'Mid';
}

function projectChildren(list, entryType) {
  return list.map((entry, index) => {
    const rel = entry.filename;
    const item = new vscode.TreeItem(rel, vscode.TreeItemCollapsibleState.None);
    item.contextValue = `projectFile${projectPosition(index, list.length)}`;
    item.iconPath = new vscode.ThemeIcon('file');
    item.entryType = entryType;
    item.index = index;
    const abs = toAbs(rel);
    if (abs) item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(abs)] };
    return item;
  });
}

function buildProjectView(element) {
  if (!workspaceRoot()) return [];
  const s = getSettings(extContext);
  if (!element) {
    return [
      projectParent('Libraries', 'librariesParent', s.libraries.length),
      projectParent('Tasks', 'tasksParent', s.tasks.length)
    ];
  }
  if (element.kind === 'librariesParent') return projectChildren(s.libraries, 'library');
  if (element.kind === 'tasksParent') return projectChildren(s.tasks, 'task');
  return [];
}

/* --- コマンド --- */

/** 実行中の操作数。コマンドパレットからは同時に走りうるため数える */
let running = 0;

/** 実行中はボタンを無効化する。可否の提示は Execute ビューへ集約する */
async function runAction(fn) {
  running++;
  output.show(true);
  refreshAll();
  try {
    await fn();
  } finally {
    running--;
    refreshAll();
  }
}

async function selectVersion(context) {
  const pick = await vscode.window.showQuickPick(
    AVAILABLE_VERSIONS.map((v) => ({ label: v, value: v })),
    { title: 'Kaniburner: Select mruby version' }
  );
  if (!pick) return;
  updateCompiler(context, { version: pick.value });
}

async function selectBaud(context) {
  const pick = await vscode.window.showQuickPick(
    ['9600', '19200', '115200', 'その他...'],
    { title: 'Kaniburner: Select baud rate' }
  );
  if (!pick) return;
  let baud;
  if (pick === 'その他...') {
    const input = await vscode.window.showInputBox({
      title: 'Kaniburner: Baud rate',
      placeHolder: 'e.g. 57600',
      validateInput: (v) => (/^[1-9][0-9]*$/.test((v || '').trim()) ? null : '正の整数を入力してください')
    });
    if (!input) return;
    baud = parseInt(input.trim(), 10);
  } else {
    baud = parseInt(pick, 10);
  }
  updateDevice(context, { baud });
}

const projectKey = (entryType) => (entryType === 'library' ? 'libraries' : 'tasks');

async function addProjectFile(context, entryType) {
  const key = projectKey(entryType);
  const candidates = openRbRelPaths(context, key);
  if (candidates.length === 0) {
    vscode.window.showInformationMessage('Kaniburner: 追加できる未登録の .rb タブがありません。');
    return;
  }
  const picked = await vscode.window.showQuickPick(candidates, {
    title: entryType === 'library' ? 'Kaniburner: Add library' : 'Kaniburner: Add task'
  });
  if (!picked) return;
  addProjectEntry(context, key, picked);
}

/* --- Execute ビュー --- */

/** ボタンの並び。id は executeState のキーと一致させる */
const EXECUTE_BUTTONS = [
  { id: 'executeAll', command: 'kaniburner.executeAll', label: 'Execute All', primary: true },
  { id: 'compile',    command: 'kaniburner.compile',    label: 'Compile' },
  { id: 'connect',    command: 'kaniburner.connect',    label: 'Connect' },
  { id: 'disconnect', command: 'kaniburner.disconnect', label: 'Disconnect' },
  { id: 'write',      command: 'kaniburner.write',      label: 'Write' },
  { id: 'execute',    command: 'kaniburner.execute',    label: 'Execute' },
  { id: 'reset',      command: 'kaniburner.reset',      label: 'Reset' }
];

/**
 * ボタンの可否。デバイスは 未接続 / コマンドモード / 実行モード の3状態を取り、
 * 実行モードから戻す手段は Reset のみ。
 * Execute All は内部で復帰まで行うため接続中は常に押せる。
 * Disconnect は待機中の脱出口のため running では無効化しない。
 */
function executeState() {
  const connected = !!(serial && serial.connected);
  const commandMode = connected && protocol.commandMode;
  const compilerReady = compilerStatus(extContext).resolved;
  const idle = running === 0;
  return {
    executeAll: idle && connected && compilerReady,
    compile:    idle && compilerReady,
    connect:    idle && !connected,
    disconnect: connected,
    write:      idle && commandMode && compilerReady,
    execute:    idle && commandMode,
    reset:      idle && connected
  };
}

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function nonce() {
  let s = '';
  for (let i = 0; i < 32; i++) s += NONCE_CHARS[Math.floor(Math.random() * NONCE_CHARS.length)];
  return s;
}

function executeViewHtml() {
  const n = nonce();
  const buttons = EXECUTE_BUTTONS.map((b) =>
    `<button id="${b.id}" class="${b.primary ? 'primary' : 'secondary'}" data-command="${b.command}" disabled>${b.label}</button>`
  ).join('\n    ');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
  <style>
    body {
      padding: 8px 12px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    #buttons { display: flex; flex-wrap: wrap; gap: 4px; }
    button {
      flex: 1 1 calc(50% - 4px);
      padding: 4px 8px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 2px;
      font-family: inherit;
      font-size: inherit;
      cursor: pointer;
    }
    button.primary {
      flex-basis: 100%;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.primary:hover:not(:disabled)   { background: var(--vscode-button-hoverBackground); }
    button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    button:disabled { opacity: 0.4; cursor: default; }
  </style>
</head>
<body>
  <div id="buttons">
    ${buttons}
  </div>
  <script nonce="${n}">
    const vscode = acquireVsCodeApi();
    const buttons = document.querySelectorAll('button');
    for (const el of buttons) {
      el.addEventListener('click', () => vscode.postMessage({ type: 'command', id: el.dataset.command }));
    }
    window.addEventListener('message', (e) => {
      if (e.data.type !== 'state') return;
      for (const el of buttons) el.disabled = !e.data.state[el.id];
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

/**
 * Execute ビュー
 * ツリーの行は押せることが伝わらないため、webview で本物のボタンを並べる。
 * 押せない操作は disabled にして提示する。
 */
class ExecuteViewProvider {
  constructor() {
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = executeViewHtml();
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'ready') this.refresh();
      else if (msg.type === 'command') vscode.commands.executeCommand(msg.id);
    });
    webviewView.onDidChangeVisibility(() => this.refresh());
  }

  refresh() {
    if (this._view) this._view.webview.postMessage({ type: 'state', state: executeState() });
  }
}

const activate = (context) => {
  extContext = context;
  output = vscode.window.createOutputChannel('Kaniburner');
  context.subscriptions.push(output);

  rememberEditor(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(rememberEditor));

  executeProvider = new ExecuteViewProvider();
  settingsProvider = new SimpleProvider(buildSettingsView);
  projectProvider = new SimpleProvider(buildProjectView);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('kaniburner.execute', executeProvider),
    vscode.window.registerTreeDataProvider('kaniburner.project', projectProvider),
    vscode.window.registerTreeDataProvider('kaniburner.device', settingsProvider)
  );

  serial = new SerialTransport();
  protocol = new MrbwriteProtocol(serial, {
    onText: (text) => output.append(text),
    onLog: logHook,
    onCommandModeChange: () => refreshAll()
  });

  const reg = (id, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('kaniburner.selectVersion', () => selectVersion(context));
  reg('kaniburner.selectBaud', () => selectBaud(context));
  reg('kaniburner.selectPort', async () => { await pickPort(context); });
  reg('kaniburner.addLibrary', () => addProjectFile(context, 'library'));
  reg('kaniburner.addTask', () => addProjectFile(context, 'task'));
  reg('kaniburner.removeProjectFile', (node) => {
    if (!node) return;
    removeProjectEntry(context, projectKey(node.entryType), node.index);
  });
  reg('kaniburner.moveProjectFileUp', (node) => {
    if (!node) return;
    moveProjectEntry(context, projectKey(node.entryType), node.index, -1);
  });
  reg('kaniburner.moveProjectFileDown', (node) => {
    if (!node) return;
    moveProjectEntry(context, projectKey(node.entryType), node.index, 1);
  });

  reg('kaniburner.compile', () => runAction(async () => { await doCompile(context); }));

  reg('kaniburner.write', () => runAction(async () => {
    const compiled = await doCompile(context);
    if (!compiled) return;
    if (!(await ensureReady(context))) return;
    await protocol.writeBytecodes(compiled);
  }));

  reg('kaniburner.execute', () => runAction(async () => {
    if (!(await ensureReady(context))) return;
    await protocol.execute();
  }));

  reg('kaniburner.executeAll', () => runAction(async () => {
    const compiled = await doCompile(context);
    if (!compiled) return;
    if (!(await ensureReady(context))) return;
    if (await protocol.writeBytecodes(compiled)) {
      await protocol.execute();
    }
  }));

  reg('kaniburner.reset', () => runAction(async () => {
    if (!serial.connected) {
      vscode.window.showWarningMessage('Kaniburner: Not connected.');
      return;
    }
    await resetAndReconnect(context);
  }));

  reg('kaniburner.connect', () => runAction(async () => {
    if (serial.connected) {
      vscode.window.showInformationMessage('Kaniburner: Already connected.');
      return;
    }
    if (!(await ensureConnected(context))) return;
    await protocol.ensureCommandMode({ retries: 3 });
  }));

  reg('kaniburner.disconnect', async () => {
    output.show(true);
    info('Disconnecting...');
    await serial.disconnect();
    refreshAll();
  });
};

const deactivate = async () => {
  if (serial) await serial.disconnect();
};

module.exports = { activate, deactivate };
