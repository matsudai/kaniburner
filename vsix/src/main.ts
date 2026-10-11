/**
 * kaniburner VS Code拡張。
 * mrbwriteプロトコル、mrbc(WASM)によるコンパイル、シリアル通信、UIを持つ。
 */
import type * as vscode from 'vscode';
import type { SerialPort } from 'serialport';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** MakefileのMRUBY_VERSIONSと一致させる。 */
const AVAILABLE_VERSIONS = ['3.4.0', '4.0.0'];
const RITE_COMPILERS: Record<string, string> = { RITE0300: '3.4.0', RITE0400: '4.0.0' };
const DEFAULT_VERSION = '4.0.0';
const DEFAULT_BAUD = 115200;
const PROJECT_CONFIG_FILENAME = '.vscode/kaniburner.json';
const CONNECT_TIMEOUT = 60000;
const OPEN_TIMEOUT = 5000;
const WRITE_TIMEOUT = 5000;
const DISCONNECT_WAIT_TIMEOUT = 500;
const CONNECT_INTERVAL = 1000;

type ProjectKey = 'libraries' | 'tasks';
type Action = 'connect' | 'restart' | 'write' | 'execute' | 'disconnect';
type Phase = 'selecting' | 'opening' | 'probing' | 'restarting' | 'waiting' | 'info' | 'compile' | 'writing' | 'execute' | 'closing';

interface Operation {
  action: Action;
  phase: Phase;
  controller: AbortController;
  disconnected: boolean;
}

interface Probe {
  port: SerialPort;
  operation: Operation | null;
}

/** filenameはワークスペースルートからの相対パス。 */
interface Entry {
  filename: string;
}

/** ユーザーストレージに保存する設定。 */
interface DeviceConfig {
  port?: string;
  baud?: number;
  autoDetect?: boolean;
  autoVerify?: boolean;
}

/** プロジェクト設定ファイルに保存する設定。 */
interface ProjectConfig {
  compiler?: { version?: string };
  libraries?: Entry[];
  tasks?: Entry[];
}

interface Settings {
  version: string;
  autoDetect: boolean;
  port: string | null;
  baud: number;
  autoConnect: boolean;
  autoVerify: boolean;
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

interface BoardInfo {
  mrubyc: string | null;
  rite: string | null;
  error: string | null;
}

interface VersionSelection {
  version: string;
  warning: string | null;
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
  statusBar: vscode.StatusBarItem;
}

/** 手続きが書き換える状態。 */
export interface State {
  lastRubyDocument: vscode.TextDocument | null;
  /* mrbwriteプロトコル */
  pending: string;
  commandMode: boolean;
  runMode: boolean;
  lastCommand: string | null;
  responseResolve: ((line: string | null) => void) | null;
  responseAccept: ((line: string) => boolean) | null;
  probe: Probe | null;
  boardInfo: BoardInfo | null;
  boardInfoRequest: Promise<void> | null;
  /* シリアル通信 */
  serialPort: SerialPort | null;
  autoConnect: boolean;
  /** 前回の監視で設定のポートが見えていたか。挿された瞬間だけ自動接続するために持つ。 */
  portPresent: boolean;
  /* mrbcコンパイラ */
  mrbc: MrbcModule | null;
  mrbcDirectory: string | null;
  running: number;
  operation: Operation | null;
}

export interface Context extends Dependencies {
  projectProvider: Provider;
  deviceProvider: Provider;
  get(): State;
  /* 状態の変更 */
  rememberEditor(editor: vscode.TextEditor | undefined): void;
  setPending(pending: string): void;
  enterCommandMode(): void;
  exitCommandMode(): void;
  enterRunMode(): void;
  beginExecute(): void;
  expectResponse(resolve: (line: string | null) => void, accept?: (line: string) => boolean): void;
  clearResponse(): void;
  setProbe(probe: Probe | null): void;
  setOperation(operation: Operation | null): void;
  setPhase(phase: Phase): void;
  clearProtocol(): void;
  setBoardInfo(info: BoardInfo): void;
  setBoardInfoRequest(request: Promise<void> | null): void;
  setSerialPort(port: SerialPort | null): void;
  setAutoConnect(autoConnect: boolean): void;
  setPortPresent(present: boolean): void;
  setMrbc(mrbc: MrbcModule, directory: string): void;
  beginAction(): void;
  endAction(): void;
  writeProjectConfig(config: ProjectConfig): void;
  writeDeviceConfig(config: DeviceConfig): void;
}

const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, milliseconds);
  signal?.addEventListener('abort', finish, { once: true });
  if (signal?.aborted) finish();
});

const active = (context: Context, operation: Operation | null) =>
  context.get().operation === operation && !operation?.controller.signal.aborted;

export const logInfo = (context: Context, message: string) => context.output.appendLine(`[info]  ${message}`);
export const logError = (context: Context, message: string) => { context.output.appendLine(`[error] ${message}`); context.output.show(true); };

/** 状態の変更は遷移関数で行い、描画に効くものは描画も更新する。 */
export function buildContext(dependencies: Dependencies): Context {
  let state: State = {
    lastRubyDocument: null,
    pending: '',
    commandMode: false,
    runMode: false,
    lastCommand: null,
    responseResolve: null,
    responseAccept: null,
    probe: null,
    boardInfo: null,
    boardInfoRequest: null,
    serialPort: null,
    autoConnect: false,
    portPresent: false,
    mrbc: null,
    mrbcDirectory: null,
    running: 0,
    operation: null
  };
  const update = (transition: (state: State) => State) => { state = transition(state); };
  const context: Context = {
    ...dependencies,
    projectProvider: createProvider(dependencies.vscode, (element) => buildProjectView(context, element)),
    deviceProvider: createProvider(dependencies.vscode, (element) => buildDeviceView(context, element)),
    get: () => state,
    rememberEditor: (editor) => { update((state) => rememberEditor(state, editor)); refreshButtons(context); },
    setPending: (pending) => update((state) => setPending(state, pending)),
    enterCommandMode: () => { update(enterCommandMode); refreshAll(context); },
    exitCommandMode: () => { update(exitCommandMode); refreshAll(context); },
    enterRunMode: () => { update(enterRunMode); refreshAll(context); },
    beginExecute: () => update(beginExecute),
    expectResponse: (resolve, accept) => update((state) => expectResponse(state, resolve, accept)),
    clearResponse: () => update(clearResponse),
    setProbe: (probe) => update((state) => ({ ...state, probe })),
    setOperation: (operation) => { update((state) => ({ ...state, operation })); refreshButtons(context); },
    setPhase: (phase) => {
      const { operation } = state;
      if (operation) operation.phase = phase;
      refreshButtons(context);
    },
    clearProtocol: () => { update(clearProtocol); refreshAll(context); },
    setBoardInfo: (info) => { update((state) => setBoardInfo(state, info)); refreshAll(context); },
    setBoardInfoRequest: (request) => { update((state) => setBoardInfoRequest(state, request)); refreshAll(context); },
    setSerialPort: (port) => { update((state) => setSerialPort(state, port)); refreshAll(context); },
    setAutoConnect: (autoConnect) => { update((state) => setAutoConnect(state, autoConnect)); refreshAll(context); },
    setPortPresent: (present) => update((state) => setPortPresent(state, present)),
    setMrbc: (mrbc, directory) => update((state) => setMrbc(state, mrbc, directory)),
    beginAction: () => { update(beginAction); refreshAll(context); },
    endAction: () => { update(endAction); refreshAll(context); },
    writeProjectConfig: (config) => { writeProjectConfig(context, config); refreshAll(context); },
    writeDeviceConfig: (config) => { writeDeviceConfig(context, config); refreshAll(context); }
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
  const lines = (context.get().pending + text).split('\r\n');
  const pending = lines.pop() ?? '';
  context.setPending(pending);
  for (const line of lines) handleLine(context, line, false);
  if (pending) handleLine(context, pending, true);
}

export const setPending = (state: State, pending: string): State => ({ ...state, pending });

export function handleLine(context: Context, line: string, isPartial: boolean) {
  checkCommandModePatterns(context, line);
  if (isPartial) return;
  const { responseResolve, responseAccept } = context.get();
  if (responseResolve
      && (!responseAccept || responseAccept(line))
      && (line.startsWith('+OK') || line.startsWith('-ERR') || line.startsWith('+DONE'))) {
    context.clearResponse();
    responseResolve(line);
  }
}

/** 受信テキストからコマンドモードの開始・終了を検出する。 */
export function checkCommandModePatterns(context: Context, text: string) {
  const { commandMode, probe, operation, serialPort } = context.get();
  if (/Kani-Board, Please push Enter key to mrbw(?:r)?ite mode/.test(text)) {
    resetProtocol(context, { preservePending: true });
  } else if (/Kani-Board, End mrbwrite mode/.test(text)) {
    resetProtocol(context, { preservePending: true });
  } else if (/Kani-Board, mruby\/c .* start/.test(text)) {
    resetProtocol(context, { preservePending: true });
    context.enterRunMode();
  } else if (!commandMode && probe && probe.port === serialPort
      && active(context, probe.operation) && /^\+OK mruby\/c\s*$/.test(text)) {
    context.enterCommandMode();
    if (operation?.action === 'connect' || operation?.action === 'restart') context.setPhase('info');
    logInfo(context, 'Command mode entered.');
  }
}

export const enterCommandMode = (state: State): State => ({ ...state, commandMode: true, runMode: false, lastCommand: null });
export const exitCommandMode = (state: State): State => ({ ...state, commandMode: false, runMode: false, lastCommand: null });
export const enterRunMode = (state: State): State => ({ ...state, commandMode: false, runMode: true, lastCommand: null });
/** executeの応答でコマンドモードを抜けるよう記録する。 */
export const beginExecute = (state: State): State => ({ ...state, lastCommand: 'execute' });
export const expectResponse = (state: State, resolve: (line: string | null) => void, accept?: (line: string) => boolean): State =>
  ({ ...state, responseResolve: resolve, responseAccept: accept ?? null });
export const clearResponse = (state: State): State => ({ ...state, responseResolve: null, responseAccept: null });
export const clearProtocol = (state: State): State =>
  ({ ...state, pending: '', commandMode: false, runMode: false, lastCommand: null, responseResolve: null, responseAccept: null, probe: null, boardInfo: null, boardInfoRequest: null });

/** プロトコル状態を初期化する。待機中の応答はnullで解決する。 */
export function resetProtocol(context: Context, { preservePending = false } = {}) {
  const { responseResolve, pending } = context.get();
  context.clearProtocol();
  if (preservePending) context.setPending(pending);
  responseResolve?.(null);
}

/**
 * ボードからの応答行を待つ。
 *
 * @return タイムアウトした場合はnull。
 */
export function waitForResponse(context: Context, timeout = 5000, accept?: (line: string) => boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const finish = (line: string | null) => {
      clearTimeout(timer);
      if (context.get().responseResolve === finish) context.clearResponse();
      resolve(line);
    };
    const timer = setTimeout(() => finish(null), timeout);
    context.expectResponse(finish, accept);
  });
}

export async function sendCommand(context: Context, command: string, { ignoreResponse = false } = {}): Promise<string | null> {
  logInfo(context, `> ${command}`);
  if (ignoreResponse) {
    await sendText(context, command + '\r\n');
    return null;
  }
  const accept = (line: string) => line.startsWith('-ERR') || (command === 'version'
    ? /^\+OK mruby\/c\s+\S+/.test(line)
    : command.startsWith('write') ? line.startsWith('+OK Write bytecode')
      : command === 'reset' ? /^\+OK\s*$/.test(line) : /^\+OK(?:\s+Execute)?\s*$/.test(line));
  const response = waitForResponse(context, 5000, accept);
  const resolve = context.get().responseResolve;
  try {
    await sendText(context, command + '\r\n');
  } catch (error) {
    resolve?.(null);
    throw error;
  }
  return response;
}

/**
 * コマンドモードへ遷移させる。
 *
 * デバイスはCR+LFの受信でコマンドモードに入り、+OK mruby/cを返す。
 *
 * @return コマンドモードへ遷移できたかどうか。
 */
export async function ensureCommandMode(context: Context, retries = 30, progress?: string): Promise<boolean> {
  if (context.get().commandMode) return true;
  const { serialPort: port, operation } = context.get();
  if (!port) return false;
  const probe = { port, operation };
  context.setProbe(probe);
  try {
    for (let attempt = 0; attempt < retries; attempt++) {
      if (!active(context, operation) || context.get().serialPort !== port) return false;
      context.setProbe(probe);
      logInfo(context, `Entering command mode... (${progress ?? `${attempt + 1}/${retries}`})`);
      await sendText(context, '\r\n');
      await sleep(CONNECT_INTERVAL, operation?.controller.signal);
      if (!active(context, operation) || context.get().serialPort !== port) return false;
      if (context.get().commandMode) return true;
    }
    if (retries > 1) logError(context, `Command mode transition timed out (${retries}s).`);
    return false;
  } catch (error) {
    const message = (error as Error).message;
    const retrying = operation?.action === 'connect' || operation?.action === 'restart';
    if (active(context, operation) && (!retrying || message !== 'Serial write timed out.')) {
      logError(context, `Send error: ${message}`);
    }
    return false;
  } finally {
    if (context.get().probe === probe) context.setProbe(null);
  }
}

export function parseBoardInfo(response: string | null): BoardInfo {
  const fields = response?.trim().split(/\s+/) ?? [];
  if (fields[0] !== '+OK' || fields[1] !== 'mruby/c') {
    return { mrubyc: null, rite: null, error: response === null ? 'versionコマンドの応答がありません。' : `versionコマンドの応答を読み取れません: ${response}` };
  }
  return {
    mrubyc: /^v\d+(?:\.\d+)*$/.test(fields[2] ?? '') ? fields[2] : null,
    rite: /^RITE\d{4}$/.test(fields[3] ?? '') ? fields[3] : null,
    error: null
  };
}

export const setBoardInfo = (state: State, boardInfo: BoardInfo): State => ({ ...state, boardInfo });
export const setBoardInfoRequest = (state: State, boardInfoRequest: Promise<void> | null): State => ({ ...state, boardInfoRequest });

export async function readBoardInfo(context: Context): Promise<void> {
  const { serialPort, commandMode, boardInfo, boardInfoRequest } = context.get();
  if (!serialPort || !commandMode) return;
  if (boardInfoRequest) return boardInfoRequest;
  if (boardInfo) return;

  const request = Promise.resolve().then(async () => {
    if (context.get().serialPort !== serialPort || context.get().boardInfoRequest !== request) return;
    let info: BoardInfo;
    try {
      context.setPending('');
      info = parseBoardInfo(await sendCommand(context, 'version'));
    } catch (error) {
      if (context.get().boardInfoRequest === request) {
        const { responseResolve } = context.get();
        context.clearResponse();
        responseResolve?.(null);
      }
      info = { mrubyc: null, rite: null, error: `versionコマンドの送信に失敗しました: ${(error as Error).message}` };
    }
    if (context.get().serialPort === serialPort && context.get().boardInfoRequest === request) {
      context.setBoardInfo(info);
    }
  });
  context.setBoardInfoRequest(request);
  try {
    await request;
  } finally {
    if (context.get().boardInfoRequest === request) context.setBoardInfoRequest(null);
  }
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
 * mrbwriteの手順はclear → (コマンドN [CRC] → バイナリ → +DONE) × n。
 * 受信内容の検証はファーム側に任せ、CRCを渡すだけにとどめる。
 *
 * @return 書き込めたかどうか。
 */
export async function writeBytecodes(context: Context, { libraries, tasks }: Bytecodes): Promise<boolean> {
  const { serialPort: port, operation } = context.get();
  const valid = () => active(context, operation) && context.get().serialPort === port;
  if (!port || !context.get().commandMode || tasks.length === 0) return false;
  context.setPhase('writing');
  try {
    const cleared = await sendCommand(context, 'clear');
    if (!valid()) return false;
    if (!cleared?.startsWith('+OK')) {
      if (cleared === null) resetProtocol(context);
      logError(context, `clear failed: ${cleared}`);
      return false;
    }
    const entries = [
      ...libraries.map((bytecode) => ({ command: 'write_lib', bytecode })),
      ...tasks.map((bytecode) => ({ command: 'write', bytecode }))
    ];
    const { autoVerify } = getSettings(context);
    for (const { command, bytecode } of entries) {
      if (!valid() || !context.get().commandMode) return false;
      const crc = autoVerify ? ` ${mrbwriteCrc16(bytecode).toString(16).padStart(4, '0')}` : '';
      const response = await sendCommand(context, `${command} ${bytecode.length}${crc}`);
      if (!valid()) return false;
      if (!response?.startsWith('+OK Write bytecode')) {
        if (response === null) resetProtocol(context);
        logError(context, `${command} command failed: ${response}`);
        return false;
      }
      logInfo(context, `Sending bytecode (${bytecode.length} bytes)...`);
      const doneResponse = waitForResponse(context, 10000, (line) => line.startsWith('+DONE') || line.startsWith('-ERR'));
      await write(context, bytecode);
      const done = await doneResponse;
      if (!valid()) return false;
      if (done?.startsWith('+DONE')) {
        logInfo(context, 'Write completed.');
      } else {
        if (done === null) resetProtocol(context);
        logError(context, `Write failed: ${done}`);
        return false;
      }
    }
    return true;
  } catch (error) {
    if (valid()) {
      resetProtocol(context);
      logError(context, `Write failed: ${(error as Error).message}`);
    }
    return false;
  }
}

/** ボード上のプログラムを実行する。 */
export async function execute(context: Context) {
  const { serialPort: port, operation } = context.get();
  if (!port || !context.get().commandMode) return;
  context.setPhase('execute');
  context.beginExecute();
  try {
    const response = await sendCommand(context, 'execute');
    if (!active(context, operation) || context.get().serialPort !== port) return;
    if (response?.startsWith('-ERR')) {
      context.enterCommandMode();
      logError(context, `Execute failed: ${response}`);
    } else {
      const runMode = context.get().runMode || (response !== null && context.get().lastCommand === 'execute');
      resetProtocol(context, { preservePending: true });
      if (runMode) context.enterRunMode();
      if (response === null && !runMode) logError(context, 'Execute response timed out.');
      else logInfo(context, 'Command mode exited.');
    }
  } catch (error) {
    if (active(context, operation) && context.get().serialPort === port) {
      resetProtocol(context);
      logError(context, `Execute failed: ${(error as Error).message}`);
    }
  }
}

/* --- シリアル通信 --- */

export const connected = (context: Context) => context.get().serialPort !== null;

export const setSerialPort = (state: State, serialPort: SerialPort | null): State =>
  ({ ...state, serialPort, runMode: false, boardInfo: null, boardInfoRequest: null });

export function connect(context: Context, portPath: string, baudRate: number): Promise<void> {
  const { operation } = context.get();
  return new Promise((resolve, reject) => {
    let finished = false;
    let opened = false;
    const signal = operation?.controller.signal;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => {
      finish(new Error('Connection cancelled.'));
      if (opened) port.close(() => {});
    };
    const timer = setTimeout(() => {
      finish(new Error('Serial port open timed out.'));
      if (opened) port.close(() => {});
    }, OPEN_TIMEOUT);
    const port = new context.SerialPort({ path: portPath, baudRate }, (error) => {
      if (error) return finish(error);
      opened = true;
      if (finished || !active(context, operation)) {
        port.close(() => {});
        return finish(new Error('Connection cancelled.'));
      }
      port.on('data', (buffer: Buffer) => {
        if (context.get().serialPort === port) feed(context, new Uint8Array(buffer));
      });
      port.on('close', () => {
        opened = false;
        if (!finished) finish(new Error('Serial port closed while opening.'));
        onClose(context, port);
      });
      port.on('error', (error) => {
        if (context.get().serialPort === port && context.get().operation?.action !== 'disconnect') {
          resetProtocol(context);
          logError(context, `Serial error: ${error.message}`);
        }
      });
      port.set({ brk: false, dtr: true, rts: true }, (error) => {
        if (finished) return;
        if (error) {
          finish(error);
          port.close(() => {});
          return;
        }
        if (!active(context, operation)) return abort();
        context.setSerialPort(port);
        finish();
      });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function onClose(context: Context, port = context.get().serialPort) {
  if (!port || context.get().serialPort !== port) return;
  const { operation } = context.get();
  context.setSerialPort(null);
  resetProtocol(context);
  if ((operation?.action === 'connect' || operation?.action === 'restart') && operation.phase !== 'info') {
    operation.disconnected = true;
    context.setPhase('waiting');
  } else if (operation?.action !== 'disconnect') {
    stopOperation(context);
  }
  if (operation?.action !== 'disconnect') logInfo(context, 'Disconnected.');
}

export async function disconnect(context: Context): Promise<void> {
  if (context.get().operation?.action === 'disconnect') return;
  stopOperation(context);
  context.setAutoConnect(false);
  const port = context.get().serialPort;
  if (!port) return;
  await runAction(context, async () => {
    context.setPhase('closing');
    resetProtocol(context);
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, DISCONNECT_WAIT_TIMEOUT);
      port.write(Buffer.alloc(0), (error) => {
        if (finished) return;
        if (error) finish(); else port.drain(finish);
      });
    });
    if (context.get().serialPort !== port) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Serial port close timed out.')), 5000);
      port.close((error) => {
        clearTimeout(timer);
        if (context.get().serialPort === port && (!error || !port.isOpen)) context.setSerialPort(null);
        if (error) reject(error); else resolve();
      });
    });
  }, 'disconnect');
}

export function write(context: Context, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const port = context.get().serialPort;
    if (!port) return reject(new Error('Not connected'));
    const timer = setTimeout(() => reject(new Error('Serial write timed out.')), WRITE_TIMEOUT);
    port.write(Buffer.from(bytes), (error) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    });
  });
}

/** デバイスをソフトリセットする。 */
export async function sendBreak(context: Context): Promise<void> {
  const port = context.get().serialPort;
  if (!port) return;
  const set = (brk: boolean) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Break signal timed out.')), 5000);
    port.set({ brk, dtr: true, rts: true }, (error) => {
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    });
  });
  try {
    await set(true);
    await sleep(100);
  } finally {
    if (context.get().serialPort === port) await set(false);
  }
}

/* --- mrbcコンパイラ --- */

/**
 * mrbcのEmscriptenモジュールを読み込む。
 *
 * ディレクトリが変われば読み直し、mrubyのバージョン切り替えに追従する。
 */
export async function loadMrbc(context: Context, directory: string): Promise<MrbcModule> {
  const { mrbc, mrbcDirectory } = context.get();
  if (mrbc && mrbcDirectory === directory) return mrbc;
  const factory = require(path.join(directory, 'mrbc.js')) as MrbcFactory;
  const module = await factory({
    noInitialRun: true,
    print: (text: string) => context.output.append(text),
    printErr: (text: string) => context.output.append(`[stderr] ${text}`)
  });
  context.setMrbc(module, directory);
  return module;
}

export const setMrbc = (state: State, mrbc: MrbcModule, mrbcDirectory: string): State => ({ ...state, mrbc, mrbcDirectory });

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
    context.vscode.window.showWarningMessage('kaniburner: プロジェクト設定を保存するにはフォルダを開いてください。');
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
    autoDetect: device.autoDetect ?? true,
    port: device.port ?? null,
    baud: device.baud ?? DEFAULT_BAUD,
    autoConnect: context.get().autoConnect,
    autoVerify: device.autoVerify ?? true,
    libraries: project.libraries ?? [],
    tasks: project.tasks ?? []
  };
}

export function updateCompiler(context: Context, patch: NonNullable<ProjectConfig['compiler']>) {
  const config = readProjectConfig(context);
  config.compiler = { ...config.compiler, ...patch };
  context.writeProjectConfig(config);
}

export function updateDevice(context: Context, patch: DeviceConfig) {
  context.writeDeviceConfig({ ...readDeviceConfig(context), ...patch });
}

export function addProjectEntries(context: Context, key: ProjectKey, filenames: string[]) {
  const config = readProjectConfig(context);
  config[key] = [...(config[key] ?? []), ...filenames.map((filename) => ({ filename }))];
  context.writeProjectConfig(config);
}

export function removeProjectEntry(context: Context, key: ProjectKey, index: number) {
  const config = readProjectConfig(context);
  const entries = config[key];
  if (!entries?.[index]) return;
  entries.splice(index, 1);
  context.writeProjectConfig(config);
}

/** エントリを入れ替えて書き込み順を変える。 */
export function moveProjectEntry(context: Context, key: ProjectKey, index: number, delta: number) {
  const config = readProjectConfig(context);
  const entries = config[key];
  const destination = index + delta;
  if (!entries?.[index] || destination < 0 || destination >= entries.length) return;
  [entries[index], entries[destination]] = [entries[destination], entries[index]];
  context.writeProjectConfig(config);
}

/* --- コンパイラの解決 --- */

export function resolveCompilerVersion(context: Context): VersionSelection {
  const { version, autoDetect } = getSettings(context);
  if (!autoDetect) return { version, warning: null };
  if (!connected(context)) return { version, warning: 'デバイスが接続されていません。' };
  const { boardInfo } = context.get();
  if (!boardInfo) return { version, warning: 'ボードのバージョン情報を取得していません。' };
  if (boardInfo.error) return { version, warning: boardInfo.error };
  if (!boardInfo.rite) return { version, warning: '対応するRITE形式を取得できません。' };
  const detected = RITE_COMPILERS[boardInfo.rite];
  return detected
    ? { version: detected, warning: null }
    : { version, warning: `${boardInfo.rite}に対応する同梱コンパイラがありません。` };
}

/**
 * 設定中のmrubyバージョンに対応するコンパイラのディレクトリを返す。
 *
 * @return 同梱されていないバージョンが設定されている場合はnull。
 */
export function compilerDirectory(context: Context): string | null {
  const { version } = resolveCompilerVersion(context);
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
export const rememberEditor = (state: State, editor: vscode.TextEditor | undefined): State =>
  editor?.document.fileName.endsWith('.rb') ? { ...state, lastRubyDocument: editor.document } : state;

export function activeRubyDocument(context: Context): vscode.TextDocument | null {
  const active = context.vscode.window.activeTextEditor;
  if (active?.document.fileName.endsWith('.rb')) return active.document;
  const { lastRubyDocument } = context.get();
  if (lastRubyDocument && !lastRubyDocument.isClosed) return lastRubyDocument;
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
      context.vscode.window.showWarningMessage(`kaniburner: ${kindLabel} のファイルを開けません: ${filename}`);
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
    context.vscode.window.showWarningMessage('kaniburner: .rbファイルを開いてください');
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
  const { version } = resolveCompilerVersion(context);
  const directory = compilerDirectory(context);
  if (!directory) {
    context.vscode.window.showErrorMessage(`kaniburner: mruby ${version} が見つかりません。`);
    return null;
  }
  const librarySources = readSources(context, getSettings(context).libraries, 'libraries');
  if (!librarySources) return null;
  const taskSources = resolveTaskSources(context);
  if (!taskSources) return null;

  logInfo(context, `Compiling (mruby ${version})...`);
  const libraries = await compileSources(context, directory, librarySources);
  if (!libraries) return null;
  const tasks = await compileSources(context, directory, taskSources);
  if (!tasks) return null;
  const total = [...libraries, ...tasks].reduce((sum, bytecode) => sum + bytecode.length, 0);
  logInfo(context, `Compile succeeded. (${total} bytes)`);
  return { libraries, tasks };
}

export async function compileAndWrite(context: Context) {
  if (!await ensureReady(context)) return;
  const { serialPort: port, operation } = context.get();
  context.setPhase('compile');
  const compiled = await compileAll(context);
  if (!compiled || !port || !active(context, operation) || context.get().serialPort !== port) return;
  await writeBytecodes(context, compiled);
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
    context.vscode.window.showErrorMessage('kaniburner: No serial ports found.');
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
    title: 'kaniburner: Select serial port',
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
export async function ensureConnected(context: Context, quiet = false): Promise<boolean> {
  if (connected(context)) return true;
  const { operation } = context.get();
  const { baud } = getSettings(context);
  const portPath = getSettings(context).port ?? await pickPort(context);
  if (!portPath || !active(context, operation)) return false;
  logInfo(context, `Connecting (${baud} baud, ${portPath})...`);
  try {
    await connect(context, portPath, baud);
    logInfo(context, quiet ? 'Auto-connected.' : 'Connected.');
    return true;
  } catch (error) {
    if (!quiet) logError(context, `Connect failed: ${(error as Error).message}`);
    return false;
  }
}

/** 接続し、mrbwriteを確立する。 */
export async function connectDevice(context: Context, quiet = false): Promise<boolean> {
  return await runAction(context, async (operation) => {
    context.setPhase('selecting');
    const { port, baud } = getSettings(context);
    const portPath = port ?? await pickPort(context);
    if (!portPath || !active(context, operation)) return false;
    return await establishDevice(context, portPath, baud, quiet);
  }, 'connect') ?? false;
}

/** Restart後のmrbwrite確立が済むまで、再接続の要求を保持する。 */
export async function restartAndReconnect(context: Context): Promise<boolean> {
  const port = context.get().serialPort;
  if (!port || !canAction(context, 'Restart')) return false;
  const commandMode = context.get().commandMode;
  stopOperation(context);
  return await runAction(context, () => establishDevice(context, port.path, port.baudRate, false, commandMode), 'restart') ?? false;
}

async function establishDevice(context: Context, portPath: string, baud: number, quiet = false, restart?: boolean): Promise<boolean> {
  const { operation } = context.get();
  if (!operation) return false;
  const started = Date.now();
  const progress = () => `${Math.floor((Date.now() - started) / 1000)}/${CONNECT_TIMEOUT / 1000}s`;
  const timer = setTimeout(() => {
    if (context.get().operation !== operation || operation.phase === 'info') return;
    stopOperation(context);
    if (!quiet) logError(context, `Connection attempt timed out (${CONNECT_TIMEOUT / 1000}s).`);
  }, CONNECT_TIMEOUT);
  resetProtocol(context);
  try {
    if (restart !== undefined) {
      context.setPhase('restarting');
      try {
        if (restart) {
          const response = await sendCommand(context, 'reset');
          if (!active(context, operation)) return false;
          if (!operation.disconnected && !response?.startsWith('+OK')) {
            logError(context, `Restart failed: ${response}`);
            return false;
          }
        } else {
          logInfo(context, '> break');
          await sendBreak(context);
        }
      } catch (error) {
        if (!operation.disconnected) throw error;
      }
      context.setPhase(connected(context) ? 'probing' : 'waiting');
      await sleep(CONNECT_INTERVAL, operation.controller.signal);
    }
    while (active(context, operation)) {
      const attempt = Date.now();
      if (!connected(context)) {
        context.setPhase('waiting');
        logInfo(context, `Listing ports (${portPath})... (${progress()})`);
        try {
          const ports = await context.SerialPort.list();
          if (!active(context, operation)) break;
          if (ports.some((info) => info.path === portPath)) {
            context.setPhase('opening');
            logInfo(context, `Connecting (${baud} baud, ${portPath})...`);
            await connect(context, portPath, baud);
            if (!active(context, operation)) break;
            logInfo(context, quiet ? 'Auto-connected.' : restart !== undefined ? 'Reconnected.' : 'Connected.');
          }
        } catch (error) {
          if (!quiet && active(context, operation)) logError(context, `Connect failed: ${(error as Error).message}`);
        }
      }
      if (active(context, operation) && connected(context)) {
        context.setPhase('probing');
        if (await ensureCommandMode(context, 1, progress()) && active(context, operation) && connected(context)) {
          clearTimeout(timer);
          context.setPhase('info');
          await readBoardInfo(context);
          return active(context, operation) && connected(context) && context.get().commandMode;
        }
      }
      const delay = CONNECT_INTERVAL - (Date.now() - attempt);
      if (delay > 0) await sleep(delay, operation.controller.signal);
    }
    return false;
  } catch (error) {
    if (active(context, operation)) {
      resetProtocol(context);
      logError(context, `Connection failed: ${(error as Error).message}`);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function prepareDevice(context: Context, retries = 30): Promise<boolean> {
  const { operation } = context.get();
  if (!await ensureCommandMode(context, retries) || !active(context, operation)) return false;
  context.setPhase('info');
  await readBoardInfo(context);
  return active(context, operation) && connected(context) && context.get().commandMode;
}

/** コマンド受付を確認済みかどうか。 */
export async function ensureReady(context: Context): Promise<boolean> {
  return connected(context) && context.get().commandMode;
}

/** 自動接続の設定。ポートが未設定なら接続先が定まらないため自動接続はしない。 */
export function autoConnectEnabled(context: Context): boolean {
  const { port, autoConnect } = getSettings(context);
  return port !== null && autoConnect;
}

export const setAutoConnect = (state: State, autoConnect: boolean): State => ({ ...state, autoConnect, portPresent: false });

/**
 * 設定のポートを監視し、現れた瞬間に接続する。
 *
 * serialportに挿抜の通知は無いため、一覧を定期取得して前回との差を見る。
 * 手動のCancel・DisconnectではAutoConnectを無効にし、終了した要求を再開させない。
 */
export async function pollAutoConnect(context: Context) {
  if (context.get().running > 0 || connected(context) || !autoConnectEnabled(context)) return;
  const { port, baud } = getSettings(context);
  let present;
  try {
    present = (await context.SerialPort.list()).some((portInfo) => portInfo.path === port);
  } catch {
    return;
  }
  if (context.get().running > 0 || connected(context) || !autoConnectEnabled(context)) return;
  if (getSettings(context).port !== port || getSettings(context).baud !== baud) return;
  const appeared = present && !context.get().portPresent;
  context.setPortPresent(present);
  if (!appeared) return;
  await connectDevice(context, true);
}

export const setPortPresent = (state: State, portPresent: boolean): State => ({ ...state, portPresent });

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
  const selected = resolveCompilerVersion(context);
  const version = settingItem(context, 'mruby', selected.version, 'deviceVersion', 'check');
  if (!compilerDirectory(context)) {
    version.description = `${selected.version} (not found)`;
    version.iconPath = new context.vscode.ThemeIcon('warning', new context.vscode.ThemeColor('errorForeground'));
  }
  const autoDetect = checkboxItem(context, 'Auto detect compiler', settings.autoDetect, 'deviceAutoDetect');
  if (selected.warning) {
    setItemWarning(context, autoDetect, `${selected.warning}\nmruby ${selected.version}を使用します。`);
  }
  return [
    settingItem(context, 'Port', settings.port ?? '(none)', 'devicePort', 'plug'),
    boardVersionItem(context),
    settingItem(context, 'Baud', String(settings.baud), 'deviceBaud', 'pulse'),
    checkboxItem(context, 'Auto connect', settings.autoConnect, 'deviceAutoConnect'),
    version,
    autoDetect,
    checkboxItem(context, 'Auto verify', settings.autoVerify, 'deviceAutoVerify')
  ];
}

export function boardVersionItem(context: Context): Item {
  const { serialPort, boardInfo, boardInfoRequest } = context.get();
  const value = !serialPort ? '(not connected)' : boardInfo?.mrubyc ?? (boardInfoRequest ? '(reading)' : '(unknown)');
  const item = settingItem(context, 'mruby/c VM', value, 'deviceVmVersion', 'circuit-board');
  if (serialPort) {
    item.tooltip = `接続先: ${serialPort.path}`;
    if (!boardInfo?.mrubyc && !boardInfoRequest) {
      setItemWarning(context, item, `${item.tooltip}\n${boardInfo?.error ?? 'VMのバージョンを取得できません。'}`);
    }
  }
  return item;
}

export function checkboxItem(context: Context, label: string, checked: boolean, contextValue: string): Item {
  const item: Item = new context.vscode.TreeItem(label);
  item.contextValue = contextValue;
  item.iconPath = new context.vscode.ThemeIcon('sync');
  item.checkboxState = checked
    ? context.vscode.TreeItemCheckboxState.Checked
    : context.vscode.TreeItemCheckboxState.Unchecked;
  return item;
}

export function setItemWarning(context: Context, item: Item, message: string) {
  item.iconPath = new context.vscode.ThemeIcon('warning', new context.vscode.ThemeColor('editorWarning.foreground'));
  item.tooltip = message;
  if (typeof item.checkboxState === 'number') item.checkboxState = { state: item.checkboxState, tooltip: message };
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

/** 状態と処理段階から、実行できる操作を決める。 */
export function canAction(context: Context, name: string): boolean {
  const { operation, running, commandMode } = context.get();
  const isConnected = connected(context);
  const idle = running === 0 && operation === null;
  const probing = operation?.phase === 'probing' && !operation.controller.signal.aborted;
  if (name === 'Connect') return idle && !isConnected;
  if (name === 'Cancel') return !!operation && !operation.controller.signal.aborted
    && ['connect', 'restart'].includes(operation.action) && ['waiting', 'opening', 'probing'].includes(operation.phase);
  if (name === 'Disconnect') return isConnected && (!operation || ['write', 'execute'].includes(operation.action));
  if (name === 'Restart') return isConnected && (idle || probing);
  if (name === 'Execute') return idle && isConnected && commandMode;
  if (name === 'Write') return idle && isConnected && commandMode && compilerDirectory(context) !== null
    && (getSettings(context).tasks.length > 0 || activeRubyDocument(context) !== null);
  return false;
}

export function refreshButtons(context: Context) {
  const setContext = (key: string, value: boolean) =>
    context.vscode.commands.executeCommand('setContext', `kaniburner.${key}`, value);
  setContext('connected', connected(context));
  for (const name of ['Compile', 'Connect', 'Cancel', 'Disconnect', 'Write', 'Execute', 'Restart']) {
    setContext(`can${name}`, canAction(context, name));
  }
}

export function refreshAll(context: Context) {
  context.projectProvider.refresh();
  context.deviceProvider.refresh();
  refreshButtons(context);
  refreshStatusBar(context);
}

export function refreshStatusBar(context: Context) {
  const { serialPort, commandMode, runMode } = context.get();
  const status = !serialPort ? 'Offline' : commandMode ? 'Command' : runMode ? 'Run' : 'Connected';
  const icon = { Offline: 'debug-disconnect', Connected: 'plug', Command: 'terminal', Run: 'play' }[status];
  context.statusBar.text = `$(${icon}) kaniburner`;
  context.statusBar.tooltip = serialPort
    ? `kaniburner: ${status}\n${serialPort.path} (${serialPort.baudRate} baud)`
    : 'kaniburner: Offline\nBoard not connected.';
  context.statusBar.accessibilityInformation = { label: `kaniburner: ${status}` };
}

export function stopOperation(context: Context) {
  const { operation } = context.get();
  if (!operation) return;
  context.setOperation(null);
  operation.controller.abort();
  resetProtocol(context);
  context.endAction();
}

export function cancelConnection(context: Context) {
  if (!canAction(context, 'Cancel')) return;
  context.setAutoConnect(false);
  stopOperation(context);
  logInfo(context, 'Connection attempt cancelled.');
}

/** 操作を実行する。 */
export async function runAction<T>(context: Context, action: (operation: Operation) => Promise<T>, kind: Action = 'write'): Promise<T | undefined> {
  if (context.get().operation || context.get().running > 0) return;
  const operation: Operation = { action: kind, phase: 'compile', controller: new AbortController(), disconnected: false };
  context.beginAction();
  context.setOperation(operation);
  context.output.show(true);
  let cancel: () => void;
  const cancelled = new Promise<undefined>((resolve) => {
    cancel = () => resolve(undefined);
    operation.controller.signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([action(operation), cancelled]);
  } finally {
    operation.controller.signal.removeEventListener('abort', cancel!);
    if (context.get().operation === operation) {
      context.setOperation(null);
      context.endAction();
    }
  }
}

export const beginAction = (state: State): State => ({ ...state, running: state.running + 1 });
export const endAction = (state: State): State => ({ ...state, running: state.running - 1 });

export async function selectVersion(context: Context) {
  const picked = await context.vscode.window.showQuickPick(AVAILABLE_VERSIONS, {
    title: 'kaniburner: Select mruby version'
  });
  if (picked) {
    updateCompiler(context, { version: picked });
    updateDevice(context, { autoDetect: false });
  }
}

export async function selectBaud(context: Context) {
  const picked = await context.vscode.window.showQuickPick(['9600', '19200', '115200', 'その他...'], {
    title: 'kaniburner: Select baud rate'
  });
  if (!picked) return;
  if (picked !== 'その他...') {
    updateDevice(context, { baud: parseInt(picked, 10) });
    return;
  }
  const input = await context.vscode.window.showInputBox({
    title: 'kaniburner: Baud rate',
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
      context.vscode.window.showInformationMessage('kaniburner: 追加できる .rb ファイルがありません。');
      return;
    }
    addProjectEntries(context, key, filenames);
    return;
  }
  const candidates = unregisteredFilenames(context, key, openTabUris(context));
  if (candidates.length === 0) {
    context.vscode.window.showInformationMessage('kaniburner: 追加できる未登録の .rb タブがありません。');
    return;
  }
  const picked = await context.vscode.window.showQuickPick(candidates, {
    title: key === 'libraries' ? 'kaniburner: Add library' : 'kaniburner: Add task'
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
  const output = api.window.createOutputChannel('kaniburner');
  const statusBar = api.window.createStatusBarItem('kaniburner.connection', api.StatusBarAlignment.Left);
  statusBar.name = 'kaniburner';
  statusBar.command = { command: 'workbench.action.quickOpen', title: 'kaniburner commands', arguments: ['>kaniburner: '] };
  extensionContext.subscriptions.push(output, statusBar);

  context = buildContext({
    vscode: api,
    SerialPort: require('serialport').SerialPort,
    storage: extensionContext.workspaceState,
    extensionPath: extensionContext.extensionPath,
    output,
    statusBar
  });

  context.rememberEditor(api.window.activeTextEditor);
  extensionContext.subscriptions.push(api.window.onDidChangeActiveTextEditor((editor) => context.rememberEditor(editor)));

  const deviceView = api.window.createTreeView<Item>('kaniburner.device', { treeDataProvider: context.deviceProvider });
  extensionContext.subscriptions.push(
    api.window.registerTreeDataProvider('kaniburner.project', context.projectProvider),
    deviceView,
    deviceView.onDidChangeCheckboxState(({ items }) => {
      for (const [item, state] of items) {
        if (item.contextValue === 'deviceAutoConnect') {
          context.setAutoConnect(state === api.TreeItemCheckboxState.Checked);
        } else if (item.contextValue === 'deviceAutoDetect') {
          updateDevice(context, { autoDetect: state === api.TreeItemCheckboxState.Checked });
        } else if (item.contextValue === 'deviceAutoVerify') {
          updateDevice(context, { autoVerify: state === api.TreeItemCheckboxState.Checked });
        }
      }
    })
  );
  refreshButtons(context);
  refreshStatusBar(context);
  statusBar.show();

  const timer = setInterval(() => pollAutoConnect(context), CONNECT_INTERVAL);
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

  register('kaniburner.write', async () => {
    if (canAction(context, 'Write')) await runAction(context, () => compileAndWrite(context), 'write');
  });
  register('kaniburner.execute', async () => {
    if (canAction(context, 'Execute')) await runAction(context, () => execute(context), 'execute');
  });
  register('kaniburner.restart', () => restartAndReconnect(context));
  register('kaniburner.connect', async () => {
    if (canAction(context, 'Connect')) await connectDevice(context);
  });
  register('kaniburner.cancel', () => cancelConnection(context));
  register('kaniburner.disconnect', async () => {
    if (!canAction(context, 'Disconnect')) return;
    logInfo(context, 'Disconnecting...');
    try {
      await disconnect(context);
    } catch (error) {
      logError(context, `Disconnect failed: ${(error as Error).message}`);
    }
  });
}

export async function deactivate() {
  await disconnect(context);
}
