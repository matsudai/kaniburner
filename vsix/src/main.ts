/**
 * Kaniburner VS Code拡張。
 * mrbwriteプロトコル、mrbc(WASM)によるコンパイル、シリアル通信、UIを持つ。
 */
import type * as vscode from 'vscode';
import type { SerialPort } from 'serialport';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** MakefileのMRUBY_VERSIONSと一致させる。 */
const AVAILABLE_VERSIONS = ['3.4.0', '4.0.0'];
const DEFAULT_VERSION = '4.0.0';
const DEFAULT_BAUD = 115200;
const PROJECT_CONFIG_FILENAME = '.vscode/kaniburner.json';
/** 自動接続のためにポート一覧を見る間隔。 */
const AUTO_CONNECT_INTERVAL = 1000;

type ProjectKey = 'libraries' | 'tasks';

/** filenameはワークスペースルートからの相対パス。 */
interface Entry {
  filename: string;
}

/** ユーザーストレージに保存する設定。 */
interface DeviceConfig {
  port?: string;
  baud?: number;
  autoConnect?: boolean;
}

/** プロジェクト設定ファイルに保存する設定。 */
interface ProjectConfig {
  compiler?: { version?: string };
  libraries?: Entry[];
  tasks?: Entry[];
}

interface Settings {
  version: string;
  port: string | null;
  baud: number;
  autoConnect: boolean;
  libraries: Entry[];
  tasks: Entry[];
}

interface Source {
  filename: string;
  source: string;
}

interface Bytecodes {
  libraries: Uint8Array[];
  tasks: Uint8Array[];
}

/** ツリーの行をコマンド側で識別するための情報。 */
type Item = vscode.TreeItem & { key?: ProjectKey; index?: number };

type Provider = vscode.TreeDataProvider<Item> & { refresh(): void };

/** mrbc.jsが公開するEmscriptenモジュール。 */
interface MrbcModule {
  FS: {
    writeFile(path: string, data: string): void;
    unlink(path: string): void;
    readFile(path: string): Uint8Array;
  };
  callMain(args: string[]): number;
}

type MrbcFactory = (options: Record<string, unknown>) => Promise<MrbcModule>;

/** activateで注入する依存。 */
export interface Dependencies {
  vscode: typeof vscode;
  SerialPort: typeof SerialPort;
  storage: vscode.Memento;
  extensionPath: string;
  output: vscode.OutputChannel;
}

export interface Context extends Dependencies {
  lastRubyDocument: vscode.TextDocument | null;
  projectProvider: Provider;
  deviceProvider: Provider;
  /* mrbwriteプロトコル */
  pending: string;
  commandMode: boolean;
  lastCommand: string | null;
  responseResolve: ((line: string | null) => void) | null;
  /* シリアル通信 */
  serialPort: SerialPort | null;
  /** 前回の監視で設定のポートが見えていたか。挿された瞬間だけ自動接続するために持つ。 */
  portPresent: boolean;
  /* mrbcコンパイラ */
  mrbc: MrbcModule | null;
  mrbcDirectory: string | null;
  /** 実行中の操作数。コマンドパレットからは同時に走りうるため数える。 */
  running: number;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const logInfo = (context: Context, message: string) => context.output.appendLine(`[info]  ${message}`);
export const logError = (context: Context, message: string) => { context.output.appendLine(`[error] ${message}`); context.output.show(true); };

export function buildContext(dependencies: Dependencies): Context {
  const context: Context = {
    ...dependencies,
    lastRubyDocument: null,
    projectProvider: createProvider(dependencies.vscode, (element) => buildProjectView(context, element)),
    deviceProvider: createProvider(dependencies.vscode, (element) => buildDeviceView(context, element)),
    pending: '',
    commandMode: false,
    lastCommand: null,
    responseResolve: null,
    serialPort: null,
    portPresent: false,
    mrbc: null,
    mrbcDirectory: null,
    running: 0
  };
  return context;
}

/* --- mrbwriteプロトコル --- */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const sendText = (context: Context, text: string) => write(context, encoder.encode(text));

/**
 * 受信バイトを復号し、行分割・モード検出・応答解決を行う。
 *
 * コマンドモードのプロンプトは改行なしで届くため、未完の行でもモード検出は行う。
 */
export function feed(context: Context, bytes: Uint8Array) {
  const text = decoder.decode(bytes, { stream: true });
  if (text) context.output.append(text);
  const lines = (context.pending + text).split('\r\n');
  context.pending = lines.pop() ?? '';
  for (const line of lines) handleLine(context, line, false);
  if (context.pending) handleLine(context, context.pending, true);
}

export function handleLine(context: Context, line: string, isPartial: boolean) {
  checkCommandModePatterns(context, line);
  if (isPartial) return;
  if (context.responseResolve
      && (line.startsWith('+OK') || line.startsWith('-ERR') || line.startsWith('+DONE'))) {
    const resolve = context.responseResolve;
    context.responseResolve = null;
    resolve(line);
  }
}

/** 受信テキストからコマンドモードの開始・終了を検出する。 */
export function checkCommandModePatterns(context: Context, text: string) {
  if (!context.commandMode && text.includes('+OK mruby/c')) {
    context.commandMode = true;
    logInfo(context, 'Command mode entered.');
    refreshAll(context);
  } else if (context.commandMode && context.lastCommand === 'execute'
      && text.startsWith('+OK') && !text.includes('+OK mruby/c')) {
    context.commandMode = false;
    context.lastCommand = null;
    logInfo(context, 'Command mode exited.');
    refreshAll(context);
  }
}

/** プロトコル状態を初期化する。 */
export function resetProtocol(context: Context) {
  context.pending = '';
  context.commandMode = false;
  context.lastCommand = null;
  if (context.responseResolve) {
    const resolve = context.responseResolve;
    context.responseResolve = null;
    resolve(null);
  }
}

/**
 * ボードからの応答行を待つ。
 *
 * @return タイムアウトした場合はnull。
 */
export function waitForResponse(context: Context, timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      context.responseResolve = null;
      resolve(null);
    }, timeout);
    context.responseResolve = (line) => { clearTimeout(timer); resolve(line); };
  });
}

export async function sendCommand(context: Context, command: string, { ignoreResponse = false } = {}): Promise<string | null> {
  logInfo(context, `> ${command}`);
  if (ignoreResponse) {
    await sendText(context, command + '\r\n');
    return null;
  }
  const response = waitForResponse(context);
  await sendText(context, command + '\r\n');
  return response;
}

/**
 * コマンドモードへ遷移させる。
 *
 * デバイスはCR+LFの受信でコマンドモードに入り、+OK mruby/cを返す。
 *
 * @return コマンドモードへ遷移できたかどうか。
 */
export async function ensureCommandMode(context: Context, retries = 30): Promise<boolean> {
  if (context.commandMode) return true;
  logInfo(context, 'Entering command mode...');
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await sendText(context, '\r\n');
    } catch (error) {
      logError(context, `Send error: ${(error as Error).message}`);
      return false;
    }
    await sleep(1000);
    if (context.commandMode) return true;
  }
  logError(context, `Command mode transition timed out (${retries}s).`);
  return false;
}

/** writeコマンドに付けるCRC-16を計算する。 */
export function mrbwriteCrc16(data: Uint8Array): number {
  let crc = 0x0000;
  for (let byteIndex = 0; byteIndex < data.length; byteIndex++) {
    crc ^= data[byteIndex];
    for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
      crc = (crc & 0x0001) ? ((crc >> 1) ^ 0x8408) : (crc >> 1);
    }
  }
  return (~crc) & 0xffff;
}

/**
 * バイトコードをボードへ書き込む。
 *
 * mrbwriteの手順はclear → (コマンドN CRC → バイナリ → +DONE) × n。
 * 受信内容の検証はファーム側に任せ、CRCを渡すだけにとどめる。
 *
 * @return 書き込めたかどうか。
 */
export async function writeBytecodes(context: Context, { libraries, tasks }: Bytecodes): Promise<boolean> {
  if (!await ensureCommandMode(context)) return false;
  if (tasks.length === 0) return false;

  const clearResponse = await sendCommand(context, 'clear');
  if (!clearResponse?.startsWith('+OK')) {
    logError(context, `clear failed: ${clearResponse}`);
    return false;
  }

  const entries = [
    ...libraries.map((bytecode) => ({ command: 'write_lib', bytecode })),
    ...tasks.map((bytecode) => ({ command: 'write', bytecode }))
  ];
  for (const { command, bytecode } of entries) {
    const crc = mrbwriteCrc16(bytecode).toString(16).padStart(4, '0');
    const writeResponse = await sendCommand(context, `${command} ${bytecode.length} ${crc}`);
    if (!writeResponse?.startsWith('+OK Write bytecode')) {
      logError(context, `${command} command failed: ${writeResponse}`);
      return false;
    }
    logInfo(context, `Sending bytecode (${bytecode.length} bytes)...`);
    const doneResponse = waitForResponse(context, 10000);
    await write(context, bytecode);
    const done = await doneResponse;
    if (done?.startsWith('+DONE')) {
      logInfo(context, 'Write completed.');
    } else if (done?.startsWith('-ERR')) {
      logError(context, `Write failed: ${done}`);
      return false;
    } else {
      logError(context, `Write response timeout or unexpected: ${done}`);
      return false;
    }
  }
  return true;
}

/** ボード上のプログラムを実行する。 */
export async function execute(context: Context) {
  if (!await ensureCommandMode(context)) return;
  context.lastCommand = 'execute';
  await sendCommand(context, 'execute', { ignoreResponse: true });
}

/* --- シリアル通信 --- */

export const connected = (context: Context) => context.serialPort !== null;

export function connect(context: Context, portPath: string, baudRate: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = new context.SerialPort({ path: portPath, baudRate }, (error) => {
      if (error) return reject(error);
      context.serialPort = port;
      port.on('data', (buffer: Buffer) => feed(context, new Uint8Array(buffer)));
      port.on('close', () => onClose(context));
      port.on('error', () => {});
      resolve();
    });
  });
}

export function onClose(context: Context) {
  if (!context.serialPort) return;
  context.serialPort = null;
  resetProtocol(context);
  logInfo(context, 'Disconnected.');
  refreshAll(context);
}

export function disconnect(context: Context): Promise<void> {
  return new Promise((resolve) => {
    const port = context.serialPort;
    if (!port) return resolve();
    context.serialPort = null;
    port.close(() => { resetProtocol(context); resolve(); });
  });
}

export function write(context: Context, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!context.serialPort) return reject(new Error('Not connected'));
    context.serialPort.write(Buffer.from(bytes), (error) => (error ? reject(error) : resolve()));
  });
}

/** デバイスをソフトリセットする。 */
export function sendBreak(context: Context): Promise<void> {
  return new Promise((resolve) => {
    const port = context.serialPort;
    if (!port) return resolve();
    port.set({ brk: true }, () => {
      setTimeout(() => port.set({ brk: false }, () => resolve()), 100);
    });
  });
}

/* --- mrbcコンパイラ --- */

/**
 * mrbcのEmscriptenモジュールを読み込む。
 *
 * ディレクトリが変われば読み直し、mrubyのバージョン切り替えに追従する。
 */
export async function loadMrbc(context: Context, directory: string): Promise<MrbcModule> {
  if (context.mrbc && context.mrbcDirectory === directory) return context.mrbc;
  const factory = require(path.join(directory, 'mrbc.js')) as MrbcFactory;
  context.mrbc = await factory({
    noInitialRun: true,
    print: (text: string) => context.output.append(text),
    printErr: (text: string) => context.output.append(`[stderr] ${text}`)
  });
  context.mrbcDirectory = directory;
  return context.mrbc;
}

export async function compile(context: Context, directory: string, source: string): Promise<Uint8Array | null> {
  const module = await loadMrbc(context, directory);
  if (!source.trim()) {
    logError(context, 'Source code is empty.');
    return null;
  }
  module.FS.writeFile('/input.rb', source);
  try { module.FS.unlink('/output.mrb'); } catch { /* 初回は存在しない。 */ }
  try {
    const exitCode = module.callMain(['-o', '/output.mrb', '/input.rb']);
    if (exitCode !== 0) {
      logError(context, `Compile failed (exit code ${exitCode}).`);
      return null;
    }
    return new Uint8Array(module.FS.readFile('/output.mrb'));
  } catch (error) {
    logError(context, `Compile error: ${(error as Error).message}`);
    return null;
  }
}

/* --- 設定の保存先 --- */

export const readDeviceConfig = (context: Context): DeviceConfig =>
  context.storage.get<DeviceConfig>('kaniburner.device') ?? {};

export const writeDeviceConfig = (context: Context, config: DeviceConfig) =>
  context.storage.update('kaniburner.device', config);

export function projectConfigPath(context: Context): string | null {
  const root = workspaceRoot(context);
  return root ? path.join(root, PROJECT_CONFIG_FILENAME) : null;
}

/**
 * プロジェクト設定を読む。
 *
 * @return ワークスペースを開いていない、またはファイルが無い場合は空。
 */
export function readProjectConfig(context: Context): ProjectConfig {
  const filepath = projectConfigPath(context);
  if (!filepath || !fs.existsSync(filepath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8')) as ProjectConfig;
  } catch (error) {
    logError(context, `Failed to read ${PROJECT_CONFIG_FILENAME}: ${(error as Error).message}`);
    return {};
  }
}

export function writeProjectConfig(context: Context, config: ProjectConfig) {
  const filepath = projectConfigPath(context);
  if (!filepath) {
    context.vscode.window.showWarningMessage('Kaniburner: プロジェクト設定を保存するにはフォルダを開いてください。');
    return;
  }
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify(config, null, 2) + '\n');
}

/** 欠落キーを既定値で補った設定を返す。 */
export function getSettings(context: Context): Settings {
  const device = readDeviceConfig(context);
  const project = readProjectConfig(context);
  return {
    version: project.compiler?.version ?? DEFAULT_VERSION,
    port: device.port ?? null,
    baud: device.baud ?? DEFAULT_BAUD,
    autoConnect: device.autoConnect ?? true,
    libraries: project.libraries ?? [],
    tasks: project.tasks ?? []
  };
}

export function updateVersion(context: Context, version: string) {
  const config = readProjectConfig(context);
  config.compiler = { version };
  writeProjectConfig(context, config);
  refreshAll(context);
}

export function updateDevice(context: Context, patch: DeviceConfig) {
  writeDeviceConfig(context, { ...readDeviceConfig(context), ...patch });
  refreshAll(context);
}

export function addProjectEntries(context: Context, key: ProjectKey, filenames: string[]) {
  const config = readProjectConfig(context);
  config[key] = [...(config[key] ?? []), ...filenames.map((filename) => ({ filename }))];
  writeProjectConfig(context, config);
  refreshAll(context);
}

export function removeProjectEntry(context: Context, key: ProjectKey, index: number) {
  const config = readProjectConfig(context);
  const entries = config[key];
  if (!entries?.[index]) return;
  entries.splice(index, 1);
  writeProjectConfig(context, config);
  refreshAll(context);
}

/** エントリを入れ替えて書き込み順を変える。 */
export function moveProjectEntry(context: Context, key: ProjectKey, index: number, delta: number) {
  const config = readProjectConfig(context);
  const entries = config[key];
  const destination = index + delta;
  if (!entries?.[index] || destination < 0 || destination >= entries.length) return;
  [entries[index], entries[destination]] = [entries[destination], entries[index]];
  writeProjectConfig(context, config);
  refreshAll(context);
}

/* --- コンパイラの解決 --- */

/**
 * 設定中のmrubyバージョンに対応するコンパイラのディレクトリを返す。
 *
 * @return 同梱されていないバージョンが設定されている場合はnull。
 */
export function compilerDirectory(context: Context): string | null {
  const { version } = getSettings(context);
  return AVAILABLE_VERSIONS.includes(version)
    ? path.join(context.extensionPath, 'media', `mruby-${version}`)
    : null;
}

/* --- ソース解決 --- */

export function workspaceRoot(context: Context): string | null {
  return context.vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

/**
 * ワークスペース内のファイルパスを絶対パスに変換する。
 *
 * @return ワークスペースを開いていない場合はnull。
 */
export function toAbsoluteFilepath(context: Context, filename: string): string | null {
  if (path.isAbsolute(filename)) return filename;
  const root = workspaceRoot(context);
  return root ? path.join(root, filename) : null;
}

/**
 * 直近の.rbドキュメントを記憶する。
 *
 * パネル操作でフォーカスが外れても、コンパイル対象を解決できるようにする。
 */
export function rememberEditor(context: Context, editor: vscode.TextEditor | undefined) {
  if (editor?.document.fileName.endsWith('.rb')) {
    context.lastRubyDocument = editor.document;
  }
}

export function activeRubyDocument(context: Context): vscode.TextDocument | null {
  const active = context.vscode.window.activeTextEditor;
  if (active?.document.fileName.endsWith('.rb')) return active.document;
  if (context.lastRubyDocument && !context.lastRubyDocument.isClosed) return context.lastRubyDocument;
  const visible = context.vscode.window.visibleTextEditors.find((editor) => editor.document.fileName.endsWith('.rb'));
  return visible?.document ?? null;
}

export function readSources(context: Context, entries: Entry[], kindLabel: string): Source[] | null {
  const sources: Source[] = [];
  for (const { filename } of entries) {
    const filepath = toAbsoluteFilepath(context, filename);
    try {
      if (!filepath) throw new Error('unresolved');
      sources.push({ filename, source: fs.readFileSync(filepath, 'utf8') });
    } catch {
      context.vscode.window.showWarningMessage(`Kaniburner: ${kindLabel} のファイルを開けません: ${filename}`);
      return null;
    }
  }
  return sources;
}

/**
 * コンパイル対象のタスクを読む。
 *
 * 設定のtasksを優先し、無ければアクティブな.rbを使う。
 *
 * @return 読めなかった場合はnull。
 */
export function resolveTaskSources(context: Context): Source[] | null {
  const { tasks } = getSettings(context);
  if (tasks.length > 0) return readSources(context, tasks, 'tasks');
  const document = activeRubyDocument(context);
  if (!document) {
    context.vscode.window.showWarningMessage('Kaniburner: .rbファイルを開いてください');
    return null;
  }
  return [{ filename: path.basename(document.fileName), source: document.getText() }];
}

/**
 * ワークスペース配下の.rbファイルのfilenameを返す。
 *
 * @return ワークスペース外、または.rb以外の場合はnull。
 */
export function toProjectFilename(context: Context, uri: vscode.Uri): string | null {
  const root = workspaceRoot(context);
  if (!root || !uri.fsPath.endsWith('.rb')) return null;
  const filename = path.relative(root, uri.fsPath);
  if (filename.startsWith('..') || path.isAbsolute(filename)) return null;
  return filename;
}

/** ディレクトリ配下の.rbファイルをパス順に返す。 */
function rubyFilepaths(directory: string): string[] {
  const filepaths: string[] = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const filepath = path.join(directory, entry.name);
    if (entry.isDirectory()) filepaths.push(...rubyFilepaths(filepath));
    else if (entry.name.endsWith('.rb')) filepaths.push(filepath);
  }
  return filepaths;
}

/** ディレクトリのURIを配下の.rbファイルへ展開する。 */
export function expandDirectories(context: Context, uris: vscode.Uri[]): vscode.Uri[] {
  const expanded: vscode.Uri[] = [];
  for (const uri of uris) {
    if (fs.statSync(uri.fsPath, { throwIfNoEntry: false })?.isDirectory()) {
      for (const filepath of rubyFilepaths(uri.fsPath)) expanded.push(context.vscode.Uri.file(filepath));
    } else {
      expanded.push(uri);
    }
  }
  return expanded;
}

/** 未登録のfilenameだけを重複なく返す。 */
export function unregisteredFilenames(context: Context, key: ProjectKey, uris: vscode.Uri[]): string[] {
  const registered = new Set(getSettings(context)[key].map((entry) => entry.filename));
  const filenames = new Set<string>();
  for (const uri of uris) {
    const filename = toProjectFilename(context, uri);
    if (filename && !registered.has(filename)) filenames.add(filename);
  }
  return [...filenames];
}

/** 開かれているタブのURIを返す。 */
export function openTabUris(context: Context): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  for (const group of context.vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
      if (uri) uris.push(uri);
    }
  }
  return uris;
}

export async function compileSources(context: Context, directory: string, sources: Source[]): Promise<Uint8Array[] | null> {
  const bytecodes: Uint8Array[] = [];
  for (const { filename, source } of sources) {
    const bytecode = await compile(context, directory, source);
    if (!bytecode) {
      logError(context, `Compile failed: ${filename}`);
      return null;
    }
    bytecodes.push(bytecode);
  }
  return bytecodes;
}

export async function compileAll(context: Context): Promise<Bytecodes | null> {
  const directory = compilerDirectory(context);
  if (!directory) {
    context.vscode.window.showErrorMessage(`Kaniburner: mruby ${getSettings(context).version} が見つかりません。`);
    return null;
  }
  const librarySources = readSources(context, getSettings(context).libraries, 'libraries');
  if (!librarySources) return null;
  const taskSources = resolveTaskSources(context);
  if (!taskSources) return null;

  logInfo(context, `Compiling (mruby ${getSettings(context).version})...`);
  const libraries = await compileSources(context, directory, librarySources);
  if (!libraries) return null;
  const tasks = await compileSources(context, directory, taskSources);
  if (!tasks) return null;
  const total = [...libraries, ...tasks].reduce((sum, bytecode) => sum + bytecode.length, 0);
  logInfo(context, `Compile succeeded. (${total} bytes)`);
  return { libraries, tasks };
}

/* --- 接続 --- */

/**
 * シリアルポートを選択させる。
 *
 * 選択された値は設定に保存される。
 *
 * @return 選択されなかった場合はnull。
 */
export async function pickPort(context: Context): Promise<string | null> {
  const cached = getSettings(context).port;
  let ports;
  try {
    ports = await context.SerialPort.list();
  } catch (error) {
    logError(context, `Failed to list ports: ${(error as Error).message}`);
    return null;
  }
  if (ports.length === 0) {
    context.vscode.window.showErrorMessage('Kaniburner: No serial ports found.');
    return null;
  }
  const items = ports.map((portInfo) => {
    const metadata = [
      portInfo.manufacturer,
      portInfo.vendorId && `VID:${portInfo.vendorId}`,
      portInfo.productId && `PID:${portInfo.productId}`
    ].filter(Boolean).join(' ');
    return { label: portInfo.path, description: metadata || undefined, picked: portInfo.path === cached };
  });
  const picked = await context.vscode.window.showQuickPick(items, {
    title: 'Kaniburner: Select serial port',
    placeHolder: cached ? `Last used: ${cached}` : 'Pick a port'
  });
  if (!picked) return null;
  updateDevice(context, { port: picked.label });
  return picked.label;
}

/**
 * 接続されている状態にする。
 *
 * 未接続なら設定のポートへ接続し、ポートが未設定なら選択させる。
 *
 * @return 接続できたかどうか。
 */
export async function ensureConnected(context: Context): Promise<boolean> {
  if (connected(context)) return true;
  const { baud } = getSettings(context);
  const portPath = getSettings(context).port ?? await pickPort(context);
  if (!portPath) return false;
  logInfo(context, `Connecting (${baud} baud, ${portPath})...`);
  try {
    await connect(context, portPath, baud);
    logInfo(context, 'Connected.');
    refreshAll(context);
    return true;
  } catch (error) {
    logError(context, `Connect failed: ${(error as Error).message}`);
    return false;
  }
}

/**
 * デバイスをソフトリセットし、コマンドモードへ入り直す。
 *
 * コマンドモード中はresetコマンド、実行モード中はBREAK信号を使う。
 * リセット中はポートが一時的に消えるため、再出現を最大30秒待って再接続する。
 *
 * @return コマンドモードへ入れたかどうか。
 */
export async function resetAndReconnect(context: Context): Promise<boolean> {
  if (!connected(context)) return false;
  const { port, baud } = getSettings(context);
  if (context.commandMode) {
    await sendCommand(context, 'reset', { ignoreResponse: true });
  } else {
    logInfo(context, '> break');
    await sendBreak(context);
  }
  resetProtocol(context);
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(1000);
    if (connected(context)) break;
    try {
      const ports = await context.SerialPort.list();
      if (port && ports.some((portInfo) => portInfo.path === port)) {
        await connect(context, port, baud);
        logInfo(context, 'Reconnected.');
        refreshAll(context);
        break;
      }
    } catch { /* リセット中はポートが消えるため、次の試行へ。 */ }
  }
  return connected(context) ? await ensureCommandMode(context) : false;
}

/**
 * 接続し、コマンドモードへ入る。
 *
 * 直接入れない場合はリセット後に入り直す。
 *
 * @return コマンドモードへ入れたかどうか。
 */
export async function ensureReady(context: Context): Promise<boolean> {
  if (!await ensureConnected(context)) return false;
  if (await ensureCommandMode(context, 3)) return true;
  return await resetAndReconnect(context);
}

/** 自動接続の設定。ポートが未設定なら接続先が定まらないため自動接続はしない。 */
export function autoConnectEnabled(context: Context): boolean {
  const { port, autoConnect } = getSettings(context);
  return port !== null && autoConnect;
}

/**
 * 設定のポートを監視し、現れた瞬間に接続する。
 *
 * serialportに挿抜の通知は無いため、一覧を定期取得して前回との差を見る。
 * 前回も見えていたポートには接続しないため、手動で切断した後は挿し直すまで繋ぎ直さない。
 */
export async function pollAutoConnect(context: Context) {
  if (context.running > 0 || connected(context) || !autoConnectEnabled(context)) return;
  const { port, baud } = getSettings(context);
  let present;
  try {
    present = (await context.SerialPort.list()).some((portInfo) => portInfo.path === port);
  } catch {
    return;
  }
  const appeared = present && !context.portPresent;
  context.portPresent = present;
  if (!appeared) return;
  logInfo(context, `Connecting (${baud} baud, ${port})...`);
  try {
    await connect(context, port as string, baud);
    logInfo(context, 'Auto-connected.');
    refreshAll(context);
    await ensureCommandMode(context, 3);
  } catch { /* 挿された直後は開けないことがある。次に挿し直された時へ委ねる。 */ }
}

/* --- ビュー --- */

export function createProvider(api: typeof vscode, build: (element?: Item) => Item[]): Provider {
  const emitter = new api.EventEmitter<void>();
  return {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (item) => item,
    getChildren: build,
    refresh: () => emitter.fire()
  };
}

/** 値を表示し、行内アクションで変更する設定行を作る。 */
export function settingItem(context: Context, label: string, value: string, contextValue: string, iconName: string): Item {
  const item = new context.vscode.TreeItem(label);
  item.description = value;
  item.contextValue = contextValue;
  item.iconPath = new context.vscode.ThemeIcon(iconName);
  return item;
}

export function buildDeviceView(context: Context, element?: Item): Item[] {
  if (element) return [];
  const settings = getSettings(context);
  const version = settingItem(context, 'mruby', settings.version, 'deviceVersion', 'check');
  if (!compilerDirectory(context)) {
    version.description = `${settings.version} (not found)`;
    version.iconPath = new context.vscode.ThemeIcon('warning', new context.vscode.ThemeColor('errorForeground'));
  }
  return [
    settingItem(context, 'Port', settings.port ?? '(none)', 'devicePort', 'plug'),
    settingItem(context, 'Baud', String(settings.baud), 'deviceBaud', 'pulse'),
    autoConnectItem(context, settings),
    version
  ];
}

/** 自動接続の設定行。実効値をチェックボックスに出す。 */
export function autoConnectItem(context: Context, settings: Settings): Item {
  const item: Item = new context.vscode.TreeItem('Auto connect');
  item.contextValue = 'deviceAutoConnect';
  item.iconPath = new context.vscode.ThemeIcon('sync');
  item.checkboxState = settings.port !== null && settings.autoConnect
    ? context.vscode.TreeItemCheckboxState.Checked
    : context.vscode.TreeItemCheckboxState.Unchecked;
  return item;
}

export function projectParent(context: Context, label: string, key: ProjectKey, count: number): Item {
  const item: Item = new context.vscode.TreeItem(label, context.vscode.TreeItemCollapsibleState.Expanded);
  item.contextValue = `${key}Parent`;
  item.key = key;
  item.description = String(count);
  item.iconPath = new context.vscode.ThemeIcon('folder');
  return item;
}

/**
 * 行の位置を返す。
 *
 * contextValueに含めることで、入れ替え先が無い端の行で上下ボタンを出し分ける。
 */
export function projectPosition(index: number, length: number): string {
  if (length === 1) return 'Only';
  if (index === 0) return 'First';
  if (index === length - 1) return 'Last';
  return 'Mid';
}

export function projectChildren(context: Context, key: ProjectKey, entries: Entry[]): Item[] {
  return entries.map(({ filename }, index) => {
    const item: Item = new context.vscode.TreeItem(filename);
    item.contextValue = `projectFile${projectPosition(index, entries.length)}`;
    item.iconPath = new context.vscode.ThemeIcon('file');
    item.key = key;
    item.index = index;
    const filepath = toAbsoluteFilepath(context, filename);
    if (filepath) {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [context.vscode.Uri.file(filepath)] };
    }
    return item;
  });
}

export function buildProjectView(context: Context, element?: Item): Item[] {
  if (!workspaceRoot(context)) return [];
  const settings = getSettings(context);
  if (!element) {
    return [
      projectParent(context, 'Libraries', 'libraries', settings.libraries.length),
      projectParent(context, 'Tasks', 'tasks', settings.tasks.length)
    ];
  }
  return element.key ? projectChildren(context, element.key, settings[element.key]) : [];
}

/* --- コマンド --- */

/**
 * ツールバーのボタンの可否と、ConnectとDisconnectの出し分けに使う接続状態を更新する。
 *
 * デバイスは未接続 / コマンドモード / 実行モードの3状態を取り、実行モードから戻す手段はBreakのみ。
 * Execute Allは内部で復帰まで行うため接続中は常に押せる。
 * Disconnectは待機中の脱出口のためrunningでは無効化しない。
 */
export function refreshButtons(context: Context) {
  const isConnected = connected(context);
  const ready = isConnected && context.commandMode;
  const compilerReady = compilerDirectory(context) !== null;
  const idle = context.running === 0;
  const setContext = (key: string, value: boolean) =>
    context.vscode.commands.executeCommand('setContext', `kaniburner.${key}`, value);
  const setEnabled = (name: string, enabled: boolean) => setContext(`can${name}`, enabled);
  setContext('connected', isConnected);
  setContext('runMode', isConnected && !context.commandMode);
  setEnabled('ExecuteAll', idle && isConnected && compilerReady);
  setEnabled('Compile', idle && compilerReady);
  setEnabled('Connect', idle && !isConnected);
  setEnabled('Disconnect', isConnected);
  setEnabled('Write', idle && ready && compilerReady);
  setEnabled('Execute', idle && ready);
  setEnabled('Reset', idle && isConnected);
  setEnabled('Break', idle && isConnected);
}

export function refreshAll(context: Context) {
  context.projectProvider.refresh();
  context.deviceProvider.refresh();
  refreshButtons(context);
}

/** 操作を実行する。実行中はボタンを無効化する。 */
export async function runAction(context: Context, action: () => Promise<void>) {
  context.running++;
  context.output.show(true);
  refreshAll(context);
  try {
    await action();
  } finally {
    context.running--;
    refreshAll(context);
  }
}

export async function selectVersion(context: Context) {
  const picked = await context.vscode.window.showQuickPick(AVAILABLE_VERSIONS, {
    title: 'Kaniburner: Select mruby version'
  });
  if (picked) updateVersion(context, picked);
}

export async function selectBaud(context: Context) {
  const picked = await context.vscode.window.showQuickPick(['9600', '19200', '115200', 'その他...'], {
    title: 'Kaniburner: Select baud rate'
  });
  if (!picked) return;
  if (picked !== 'その他...') {
    updateDevice(context, { baud: parseInt(picked, 10) });
    return;
  }
  const input = await context.vscode.window.showInputBox({
    title: 'Kaniburner: Baud rate',
    placeHolder: 'e.g. 57600',
    validateInput: (value) => (/^[1-9][0-9]*$/.test(value.trim()) ? null : '正の整数を入力してください')
  });
  if (input) updateDevice(context, { baud: parseInt(input.trim(), 10) });
}

/**
 * プロジェクトへファイルを追加する。
 *
 * エクスプローラー・タブのメニューからはURIが渡され、それ以外は開いているタブから選択させる。
 */
export async function addProjectFile(context: Context, key: ProjectKey, uris: vscode.Uri[]) {
  if (uris.length > 0) {
    const filenames = unregisteredFilenames(context, key, expandDirectories(context, uris));
    if (filenames.length === 0) {
      context.vscode.window.showInformationMessage('Kaniburner: 追加できる .rb ファイルがありません。');
      return;
    }
    addProjectEntries(context, key, filenames);
    return;
  }
  const candidates = unregisteredFilenames(context, key, openTabUris(context));
  if (candidates.length === 0) {
    context.vscode.window.showInformationMessage('Kaniburner: 追加できる未登録の .rb タブがありません。');
    return;
  }
  const picked = await context.vscode.window.showQuickPick(candidates, {
    title: key === 'libraries' ? 'Kaniburner: Add library' : 'Kaniburner: Add task'
  });
  if (picked) addProjectEntries(context, key, [picked]);
}

/**
 * コマンド引数からURIを取り出す。
 *
 * エクスプローラーは(uri, 選択中のuri[])、タブはuri、ツリーのボタンはItemを渡す。
 */
export function uriArguments(context: Context, target: unknown, targets: unknown): vscode.Uri[] {
  if (Array.isArray(targets)) return targets.filter((item): item is vscode.Uri => item instanceof context.vscode.Uri);
  return target instanceof context.vscode.Uri ? [target] : [];
}

let context: Context;

export function activate(extensionContext: vscode.ExtensionContext) {
  const api: typeof vscode = require('vscode');
  const output = api.window.createOutputChannel('Kaniburner');
  extensionContext.subscriptions.push(output);

  context = buildContext({
    vscode: api,
    SerialPort: require('serialport').SerialPort,
    storage: extensionContext.workspaceState,
    extensionPath: extensionContext.extensionPath,
    output
  });

  rememberEditor(context, api.window.activeTextEditor);
  extensionContext.subscriptions.push(api.window.onDidChangeActiveTextEditor((editor) => rememberEditor(context, editor)));

  const deviceView = api.window.createTreeView<Item>('kaniburner.device', { treeDataProvider: context.deviceProvider });
  extensionContext.subscriptions.push(
    api.window.registerTreeDataProvider('kaniburner.project', context.projectProvider),
    deviceView,
    deviceView.onDidChangeCheckboxState(({ items }) => {
      for (const [item, state] of items) {
        if (item.contextValue === 'deviceAutoConnect') {
          updateDevice(context, { autoConnect: state === api.TreeItemCheckboxState.Checked });
        }
      }
    })
  );
  refreshButtons(context);

  const timer = setInterval(() => pollAutoConnect(context), AUTO_CONNECT_INTERVAL);
  extensionContext.subscriptions.push({ dispose: () => clearInterval(timer) });

  // 手で編集された場合もビューへ反映する。
  const refresh = () => refreshAll(context);
  const watcher = api.workspace.createFileSystemWatcher(`**/${PROJECT_CONFIG_FILENAME}`);
  extensionContext.subscriptions.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));

  const register = (commandId: string, handler: (...args: any[]) => unknown) =>
    extensionContext.subscriptions.push(api.commands.registerCommand(commandId, handler));

  register('kaniburner.selectVersion', () => selectVersion(context));
  register('kaniburner.selectBaud', () => selectBaud(context));
  register('kaniburner.selectPort', () => pickPort(context));
  register('kaniburner.addLibrary', (target, targets) => addProjectFile(context, 'libraries', uriArguments(context, target, targets)));
  register('kaniburner.addTask', (target, targets) => addProjectFile(context, 'tasks', uriArguments(context, target, targets)));
  register('kaniburner.removeProjectFile', (node: Item) => {
    if (node?.key !== undefined && node.index !== undefined) {
      removeProjectEntry(context, node.key, node.index);
    }
  });
  register('kaniburner.moveProjectFileUp', (node: Item) => {
    if (node?.key !== undefined && node.index !== undefined) {
      moveProjectEntry(context, node.key, node.index, -1);
    }
  });
  register('kaniburner.moveProjectFileDown', (node: Item) => {
    if (node?.key !== undefined && node.index !== undefined) {
      moveProjectEntry(context, node.key, node.index, 1);
    }
  });

  register('kaniburner.compile', () => runAction(context, async () => { await compileAll(context); }));

  register('kaniburner.write', () => runAction(context, async () => {
    const compiled = await compileAll(context);
    if (!compiled) return;
    if (!await ensureReady(context)) return;
    await writeBytecodes(context, compiled);
  }));

  register('kaniburner.execute', () => runAction(context, async () => {
    if (!await ensureReady(context)) return;
    await execute(context);
  }));

  register('kaniburner.executeAll', () => runAction(context, async () => {
    const compiled = await compileAll(context);
    if (!compiled) return;
    if (!await ensureReady(context)) return;
    if (await writeBytecodes(context, compiled)) {
      await execute(context);
    }
  }));

  // ResetとBreakはツールバーの同じ枠をモードで出し分ける。押した時の動作はresetAndReconnectが分ける。
  const resetOrBreak = () => runAction(context, async () => {
    if (!connected(context)) {
      context.vscode.window.showWarningMessage('Kaniburner: Not connected.');
      return;
    }
    await resetAndReconnect(context);
  });
  register('kaniburner.reset', resetOrBreak);
  register('kaniburner.break', resetOrBreak);

  register('kaniburner.connect', () => runAction(context, async () => {
    if (connected(context)) {
      context.vscode.window.showInformationMessage('Kaniburner: Already connected.');
      return;
    }
    if (!await ensureConnected(context)) return;
    await ensureCommandMode(context, 3);
  }));

  register('kaniburner.disconnect', async () => {
    context.output.show(true);
    logInfo(context, 'Disconnecting...');
    await disconnect(context);
    refreshAll(context);
  });
}

export async function deactivate() {
  await disconnect(context);
}
