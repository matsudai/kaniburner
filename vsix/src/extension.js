/**
 * Kaniburner VS Code 拡張
 * 環境依存の実装をここへ集約する。serialport によるシリアル通信、
 * WASM の解決・ダウンロード・キャッシュ、コマンドと UI。
 * プロトコルとコンパイル・実行のロジックは core.js が持つ。
 */
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const { SerialPort } = require('serialport');
const { MrbwriteProtocol, MrbcCompiler, MrubyRunner } = require('./core');

/** WASM 資産の取得元 GitHub Release タグ。新しい mruby-<x.y.z> を発行したらここも同時に更新する */
const WASM_RELEASE_TAG = 'mruby-0.0.1';
const WASM_FILES = ['mrbc.js', 'mrbc.wasm', 'mruby.js', 'mruby.wasm'];
/** selectVersion / downloadWasm で提示する既知バージョン。これ以外は (custom) 扱い */
const AVAILABLE_VERSIONS = ['3.4.0', '4.0.0'];
const DEFAULT_VERSION = '3.4.0';
const DEFAULT_BAUD = 19200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {vscode.ExtensionContext} */ let extContext;
/** @type {vscode.OutputChannel}    */ let output;
/** @type {SerialTransport}         */ let serial;
/** @type {MrbwriteProtocol}        */ let protocol;
/** @type {MrbcCompiler}            */ let compiler;
/** @type {MrubyRunner}             */ let runner;
/** @type {vscode.TextDocument}     */ let lastRbDoc = null;
/** @type {SimpleProvider} */ let compilerProvider;
/** @type {SimpleProvider} */ let deviceProvider;
/** @type {SimpleProvider} */ let projectProvider;
/** @type {vscode.FileSystemWatcher} */ let projectWatcher = null;

const info  = (msg) => output.appendLine(`[info]  ${msg}`);
const error = (msg) => output.appendLine(`[error] ${msg}`);

/** コアからのログを OutputChannel の表記へ揃える */
function logHook(kind, msg) {
  if (kind === 'error') error(msg);
  else if (kind === 'stderr') output.append(`[stderr] ${msg}`);
  else if (kind === 'stdout') output.append(msg);
  else info(msg);
}

const setDeviceConnected = (v) =>
  vscode.commands.executeCommand('setContext', 'kaniburner.deviceConnected', v);

/** 3ビューを一括再描画する。描画は onDidChangeTreeData 発火のみに集約する */
function refreshAll() {
  if (compilerProvider) compilerProvider.refresh();
  if (deviceProvider) deviceProvider.refresh();
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
    setDeviceConnected(false);
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

/** ワークスペース配下なら相対パス、外なら絶対パスのまま保存する */
function toRel(abs) {
  const root = workspaceRoot();
  if (!root) return abs;
  const rel = path.relative(root, abs);
  return (!rel.startsWith('..') && !path.isAbsolute(rel)) ? rel : abs;
}

/* --- プロジェクトファイル（設定の保存先） --- */

function projectFileRel(context) {
  return context.workspaceState.get('kaniburner.projectFile') || '.vscode/kaniburner.json';
}

function projectFileAbs(context) {
  const root = workspaceRoot();
  return root ? path.join(root, projectFileRel(context)) : null;
}

/** 設定を読む。ワークスペースなしは workspaceState、ありはプロジェクトファイル。都度 readFileSync */
function readConfig(context) {
  const root = workspaceRoot();
  if (!root) return context.workspaceState.get('kaniburner.config') || {};
  const abs = projectFileAbs(context);
  if (!abs || !fs.existsSync(abs)) return {};
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    error(`Failed to parse project file: ${e.message}`);
    return {};
  }
}

function writeConfig(context, config) {
  const root = workspaceRoot();
  if (!root) { context.workspaceState.update('kaniburner.config', config); return; }
  const abs = projectFileAbs(context);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(config, null, 2) + '\n');
}

/** 欠落キーを既定値で補った設定ビュー。旧形式 {libraries,tasks} もそのまま通る */
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

function removeProjectEntry(context, key, filename) {
  const c = readConfig(context) || {};
  if (Array.isArray(c[key])) {
    c[key] = c[key].filter((e) => e.filename !== filename);
    writeConfig(context, c);
    refreshAll();
  }
}

/* --- WASM 解決・ダウンロード --- */

/**
 * WASM の探索先。同梱 → ワークスペースキャッシュ → globalStorage の順。
 * ワークスペース側を globalStorage より先に見るのは、.vscode ごと配布してオフライン利用できるようにするため。
 */
function wasmSearchDirs(context, version) {
  const dirs = [path.join(context.extensionPath, 'media', `mruby-${version}`)];
  const root = workspaceRoot();
  if (root) dirs.push(path.join(root, '.vscode', 'kaniburner', `mruby-${version}`));
  dirs.push(path.join(context.globalStorageUri.fsPath, `mruby-${version}`));
  return dirs;
}

/** 4ファイル揃って初めて有効なキャッシュとみなす */
function dirHasWasm(dir) {
  return WASM_FILES.every((f) => fs.existsSync(path.join(dir, f)));
}

function resolveWasmDir(context, version) {
  for (const dir of wasmSearchDirs(context, version)) {
    if (dirHasWasm(dir)) return dir;
  }
  return null;
}

function wasmDownloadDir(context, version) {
  const root = workspaceRoot();
  if (root) return path.join(root, '.vscode', 'kaniburner', `mruby-${version}`);
  return path.join(context.globalStorageUri.fsPath, `mruby-${version}`);
}

function wasmAssetUrl(version, file) {
  const dot = file.lastIndexOf('.');
  const base = file.slice(0, dot);
  const ext = file.slice(dot + 1);
  return `https://github.com/matsudai/kaniburner/releases/download/${WASM_RELEASE_TAG}/mruby-${version}-${base}.${ext}`;
}

/**
 * GitHub Release から WASM 一式を取得する。
 * 一時名で保存し全ファイル成功後に確定させ、部分ダウンロードが有効なキャッシュに見えないようにする。
 */
async function downloadWasmFiles(context, version) {
  const dir = wasmDownloadDir(context, version);
  fs.mkdirSync(dir, { recursive: true });
  const tmpNames = WASM_FILES.map((f) => `${f}.download`);
  try {
    for (let i = 0; i < WASM_FILES.length; i++) {
      const file = WASM_FILES[i];
      const url = wasmAssetUrl(version, file);
      info(`Downloading ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${file}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(path.join(dir, tmpNames[i]), buf);
    }
    for (let i = 0; i < WASM_FILES.length; i++) {
      fs.renameSync(path.join(dir, tmpNames[i]), path.join(dir, WASM_FILES[i]));
    }
    info(`Downloaded mruby ${version} to ${dir}`);
    return true;
  } catch (e) {
    error(`Download failed: ${e.message}`);
    for (const t of tmpNames) {
      try { fs.unlinkSync(path.join(dir, t)); } catch (_) {}
    }
    return false;
  }
}

/**
 * compiler 設定を解決した状態を返す。描画・実行の双方が参照する。
 * existsSync はここでのみ行い、常駐監視はしない。
 */
function compilerStatus(context) {
  const s = getSettings(context);
  const version = s.version;
  if (version === 'local') {
    const c = s.compiler;
    const keys = ['mrbc_js', 'mrbc_wasm', 'mruby_js', 'mruby_wasm'];
    const resolved = keys.every((k) => {
      const abs = toAbs(c[k]);
      return abs && fs.existsSync(abs);
    });
    return { version, kind: 'local', resolved, label: 'mruby: local' };
  }
  const dir = resolveWasmDir(context, version);
  const known = AVAILABLE_VERSIONS.includes(version);
  return {
    version,
    kind: known ? 'known' : 'custom',
    resolved: !!dir,
    dir,
    label: known ? `mruby: ${version}` : `mruby: (custom: ${version})`
  };
}

/** 現在のツールチェインが対応する設定シグネチャ。設定変更を検知して作り直す */
let toolchainKey = null;

function buildToolchain(context) {
  const st = compilerStatus(context);
  if (st.kind === 'local') {
    const c = getSettings(context).compiler;
    const mrbcJs = toAbs(c.mrbc_js);
    const mrbcWasm = toAbs(c.mrbc_wasm);
    const mrubyJs = toAbs(c.mruby_js);
    const mrubyWasm = toAbs(c.mruby_wasm);
    compiler = new MrbcCompiler(() => require(mrbcJs), {
      onLog: logHook,
      moduleOptions: { locateFile: (p) => (p.endsWith('.wasm') ? mrbcWasm : p) }
    });
    runner = new MrubyRunner(() => require(mrubyJs), {
      onLog: logHook,
      moduleOptions: { locateFile: (p) => (p.endsWith('.wasm') ? mrubyWasm : p) }
    });
  } else {
    compiler = new MrbcCompiler(() => require(path.join(st.dir, 'mrbc.js')), { onLog: logHook });
    runner = new MrubyRunner(() => require(path.join(st.dir, 'mruby.js')), { onLog: logHook });
  }
}

/**
 * コンパイラとランナーを用意する。自動 DL はしない。
 * 未解決なら Download を案内するエラーを出して false を返す。
 */
function ensureToolchain(context) {
  const st = compilerStatus(context);
  if (!st.resolved) {
    if (st.kind === 'local') {
      vscode.window.showErrorMessage(
        'Kaniburner: local の mruby ファイルが見つかりません。プロジェクトファイルの compiler パスを確認してください。'
      );
    } else {
      vscode.window.showErrorMessage(
        `Kaniburner: mruby ${st.version} が未ダウンロードです。パネルの Download を使ってください。`
      );
    }
    return false;
  }
  const key = JSON.stringify(getSettings(context).compiler) + '|' + (st.dir || '');
  if (key === toolchainKey && compiler && runner) return true;
  buildToolchain(context);
  toolchainKey = key;
  return true;
}

function invalidateToolchain() {
  toolchainKey = null;
  compiler = null;
  runner = null;
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

/** コンパイル対象のソースを解決する。プロジェクトファイルの tasks を優先し、なければアクティブな .rb */
function resolveSource(context) {
  const s = getSettings(context);
  const taskFile = s.tasks[0] && s.tasks[0].filename;
  if (taskFile) {
    try {
      return fs.readFileSync(toAbs(taskFile), 'utf8');
    } catch (e) {
      vscode.window.showWarningMessage(`Kaniburner: tasks のファイルを開けません: ${taskFile}`);
      return null;
    }
  }
  const doc = activeRbDocument();
  if (!doc) {
    vscode.window.showWarningMessage('Kaniburner: .rbファイルを開いてください');
    return null;
  }
  return doc.getText();
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
 * BREAK でソフトリセットし、コマンドモードへ入り直す。
 * リセット中はポートが一時的に消えることがあるため、再出現を最大30秒待って再接続する。
 */
async function breakAndReconnect(context) {
  if (!serial.connected) return false;
  const s = getSettings(context);
  info('> break');
  await serial.sendBreak();
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (serial.connected) break;
    try {
      const ports = await SerialPort.list();
      if (ports.some((p) => p.path === s.port)) {
        await serial.connect(s.port, s.baud);
        info('Reconnected.');
        setDeviceConnected(true);
        refreshAll();
        break;
      }
    } catch (_) {}
  }
  if (!serial.connected) return false;
  return await protocol.ensureCommandMode();
}

/** 未接続なら device.port（なければ選択）で接続し、コマンドモード遷移まで行う */
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
    setDeviceConnected(true);
    refreshAll();
    output.show(true);
    await protocol.ensureCommandMode();
    return true;
  } catch (e) {
    error(`Connect failed: ${e.message}`);
    return false;
  }
}

async function doCompile(context) {
  const src = resolveSource(context);
  if (src === null) return null;
  if (!ensureToolchain(context)) return null;
  info(`Compiling (mruby ${getSettings(context).version})...`);
  const bc = await compiler.compile(src);
  if (bc) info(`Compile succeeded. (${bc.length} bytes)`);
  return bc;
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

/** 一行アクション。無効時は command を付けず理由を description で示す */
function actionItem(label, commandId, iconName, enabled, disabledReason) {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  if (enabled) {
    item.command = { command: commandId, title: label };
    item.iconPath = new vscode.ThemeIcon(iconName);
  } else {
    item.description = disabledReason || 'unavailable';
    item.iconPath = new vscode.ThemeIcon(iconName, new vscode.ThemeColor('disabledForeground'));
  }
  return item;
}

function buildCompilerView(element) {
  if (element) return [];
  const st = compilerStatus(extContext);
  const items = [];

  const vItem = new vscode.TreeItem(st.label, vscode.TreeItemCollapsibleState.None);
  vItem.command = { command: 'kaniburner.selectVersion', title: 'Select version' };
  vItem.version = st.version;
  if (!st.resolved) {
    vItem.description = st.kind === 'local' ? 'not found' : 'not downloaded';
    vItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
  } else {
    vItem.iconPath = new vscode.ThemeIcon('check');
    if (st.kind !== 'local') vItem.contextValue = 'compilerResolvedRemote';
  }
  items.push(vItem);

  if (!st.resolved && st.kind !== 'local') {
    const dl = new vscode.TreeItem(`Download mruby ${st.version}`, vscode.TreeItemCollapsibleState.None);
    dl.command = { command: 'kaniburner.downloadWasm', title: 'Download', arguments: [st.version] };
    dl.iconPath = new vscode.ThemeIcon('cloud-download', new vscode.ThemeColor('errorForeground'));
    items.push(dl);
  }

  items.push(actionItem('Compile', 'kaniburner.compile', 'tools', st.resolved, 'compiler not ready'));
  items.push(actionItem('Run mruby', 'kaniburner.run', 'play', st.resolved, 'compiler not ready'));
  return items;
}

function buildDeviceView(element) {
  if (element) return [];
  const s = getSettings(extContext);
  const connected = !!(serial && serial.connected);
  const compilerReady = compilerStatus(extContext).resolved;
  const items = [];

  const portItem = new vscode.TreeItem(`Port: ${s.port || '(none)'}`, vscode.TreeItemCollapsibleState.None);
  portItem.command = { command: 'kaniburner.selectPort', title: 'Select port' };
  portItem.iconPath = new vscode.ThemeIcon('plug');
  items.push(portItem);

  const baudItem = new vscode.TreeItem(`Baud: ${s.baud}`, vscode.TreeItemCollapsibleState.None);
  baudItem.command = { command: 'kaniburner.selectBaud', title: 'Select baud' };
  baudItem.iconPath = new vscode.ThemeIcon('pulse');
  items.push(baudItem);

  if (!connected) {
    items.push(actionItem('Connect', 'kaniburner.connect', 'plug', true));
  } else {
    items.push(actionItem('Disconnect', 'kaniburner.disconnect', 'debug-disconnect', true));
    items.push(actionItem('Execute All', 'kaniburner.executeAll', 'run-all', compilerReady, 'compiler not ready'));
    items.push(actionItem('Write', 'kaniburner.write', 'arrow-up', compilerReady, 'compiler not ready'));
    items.push(actionItem('Execute', 'kaniburner.execute', 'play-circle', true));
    items.push(actionItem('Break', 'kaniburner.break', 'debug-restart', true));
  }
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

function projectChildren(list, entryType) {
  return list.map((entry) => {
    const rel = entry.filename;
    const item = new vscode.TreeItem(rel, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'projectFile';
    item.iconPath = new vscode.ThemeIcon('file');
    item.entryType = entryType;
    item.filename = rel;
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

/** プロジェクトファイルの手編集を反映するため FileSystemWatcher を張り直す */
function setupProjectWatcher(context) {
  if (projectWatcher) { projectWatcher.dispose(); projectWatcher = null; }
  const root = workspaceRoot();
  if (!root) return;
  const pattern = new vscode.RelativePattern(vscode.Uri.file(root), projectFileRel(context));
  projectWatcher = vscode.workspace.createFileSystemWatcher(pattern);
  const onChange = () => { invalidateToolchain(); refreshAll(); };
  projectWatcher.onDidCreate(onChange);
  projectWatcher.onDidChange(onChange);
  projectWatcher.onDidDelete(onChange);
  context.subscriptions.push(projectWatcher);
}

/* --- コマンド --- */

async function selectVersion(context) {
  const pick = await vscode.window.showQuickPick(
    [
      ...AVAILABLE_VERSIONS.map((v) => ({ label: v, value: v })),
      { label: 'local...', value: 'local' }
    ],
    { title: 'Kaniburner: Select mruby version' }
  );
  if (!pick) return;
  if (pick.value !== 'local') {
    updateCompiler(context, { version: pick.value });
    return;
  }
  const targets = [
    ['mrbc_js', 'mrbc.js'],
    ['mrbc_wasm', 'mrbc.wasm'],
    ['mruby_js', 'mruby.js'],
    ['mruby_wasm', 'mruby.wasm']
  ];
  const compilerObj = { version: 'local' };
  for (const [key, name] of targets) {
    const uris = await vscode.window.showOpenDialog({
      title: `Kaniburner: Select ${name}`,
      canSelectMany: false,
      openLabel: 'Select'
    });
    if (!uris || uris.length === 0) return;
    compilerObj[key] = toRel(uris[0].fsPath);
  }
  updateCompiler(context, compilerObj);
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

async function addProjectFile(context, entryType) {
  const key = entryType === 'library' ? 'libraries' : 'tasks';
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

const activate = (context) => {
  extContext = context;
  output = vscode.window.createOutputChannel('Kaniburner');
  context.subscriptions.push(output);

  rememberEditor(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(rememberEditor));

  compilerProvider = new SimpleProvider(buildCompilerView);
  deviceProvider = new SimpleProvider(buildDeviceView);
  projectProvider = new SimpleProvider(buildProjectView);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('kaniburner.compiler', compilerProvider),
    vscode.window.registerTreeDataProvider('kaniburner.device', deviceProvider),
    vscode.window.registerTreeDataProvider('kaniburner.project', projectProvider)
  );

  setupProjectWatcher(context);

  serial = new SerialTransport();
  protocol = new MrbwriteProtocol(serial, {
    onText: (text) => output.append(text),
    onLog: logHook
  });

  setDeviceConnected(false);

  const reg = (id, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('kaniburner.openProjectFile', async () => {
    const root = workspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage('Kaniburner: ワークスペース（フォルダ）を開いてください');
      return;
    }
    const rel = await vscode.window.showInputBox({
      title: 'Kaniburner: Project file',
      value: projectFileRel(context),
      placeHolder: '.vscode/kaniburner.json'
    });
    if (!rel) return;
    await context.workspaceState.update('kaniburner.projectFile', rel);
    setupProjectWatcher(context);
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const initial = {
        compiler: { version: DEFAULT_VERSION },
        device: { baud: DEFAULT_BAUD },
        libraries: [],
        tasks: []
      };
      fs.writeFileSync(abs, JSON.stringify(initial, null, 2) + '\n');
      info(`Created project file: ${rel}`);
    }
    refreshAll();
    const doc = await vscode.workspace.openTextDocument(abs);
    await vscode.window.showTextDocument(doc);
  });

  reg('kaniburner.selectVersion', () => selectVersion(context));
  reg('kaniburner.selectBaud', () => selectBaud(context));
  reg('kaniburner.selectPort', async () => { await pickPort(context); });
  reg('kaniburner.addLibrary', () => addProjectFile(context, 'library'));
  reg('kaniburner.addTask', () => addProjectFile(context, 'task'));
  reg('kaniburner.removeProjectFile', (node) => {
    if (!node || !node.filename) return;
    removeProjectEntry(context, node.entryType === 'library' ? 'libraries' : 'tasks', node.filename);
  });

  reg('kaniburner.compile', async () => { await doCompile(context); });

  reg('kaniburner.run', async () => {
    const bc = await doCompile(context);
    if (!bc) return;
    info('Running on mruby...');
    await runner.run(bc);
    info('mruby execution finished.');
  });

  reg('kaniburner.write', async () => {
    const bc = await doCompile(context);
    if (!bc) return;
    if (!(await ensureConnected(context))) return;
    await protocol.writeBytecodes([bc]);
  });

  reg('kaniburner.execute', async () => {
    if (!(await ensureConnected(context))) return;
    await protocol.execute();
  });

  reg('kaniburner.executeAll', async () => {
    const bc = await doCompile(context);
    if (!bc) return;
    if (!(await ensureConnected(context))) return;
    if (!(await breakAndReconnect(context))) return;
    if (await protocol.writeBytecodes([bc])) {
      await protocol.execute();
    }
  });

  reg('kaniburner.break', async () => {
    if (!serial.connected) {
      vscode.window.showWarningMessage('Kaniburner: Not connected.');
      return;
    }
    await breakAndReconnect(context);
  });

  reg('kaniburner.connect', async () => {
    if (serial.connected) {
      vscode.window.showInformationMessage('Kaniburner: Already connected.');
      return;
    }
    await ensureConnected(context);
  });

  reg('kaniburner.disconnect', async () => {
    info('Disconnecting...');
    await serial.disconnect();
    setDeviceConnected(false);
    refreshAll();
  });

  reg('kaniburner.downloadWasm', async (arg) => {
    let version = typeof arg === 'string' ? arg : (arg && arg.version);
    const fromPanel = !!version;
    if (!version) {
      version = await vscode.window.showQuickPick(AVAILABLE_VERSIONS, {
        title: 'Kaniburner: Download mruby Version',
        placeHolder: 'Select mruby version to download'
      });
      if (!version) return;
      if (resolveWasmDir(context, version)) {
        vscode.window.showInformationMessage(`Kaniburner: mruby ${version} は既に利用可能です。`);
        return;
      }
    }
    const ok = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Downloading mruby ${version}...` },
      () => downloadWasmFiles(context, version)
    );
    if (ok) {
      invalidateToolchain();
      refreshAll();
      if (!fromPanel) vscode.window.showInformationMessage(`Kaniburner: mruby ${version} をダウンロードしました。`);
    }
  });
};

const deactivate = async () => {
  if (serial) await serial.disconnect();
};

module.exports = { activate, deactivate };
