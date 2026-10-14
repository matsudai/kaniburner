/**
 * kaniburner VS Code拡張。
 * mrbwriteプロトコル、mrbc(WASM)によるコンパイル、シリアル通信、UIを持つ。
 */
import * as path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import * as fs from 'node:fs';
import type { SerialPort } from 'serialport';
import type * as vscode from 'vscode';

/** MakefileのMRUBY_VERSIONSと一致させる。 */
export const AVAILABLE_VERSIONS = ['3.4.0', '4.0.0'];
const RITE_COMPILERS: Record<string, string> = { RITE0300: '3.4.0', RITE0400: '4.0.0' };
const CONNECT_RETRIES = 30;
const CONNECT_INTERVAL = 1000;
const OPEN_TIMEOUT = 5000;
const WRITE_TIMEOUT = 5000;
export const PROJECT_CONFIG_FILENAME = '.vscode/kaniburner.json';
export type ProjectKey = 'libraries' | 'tasks';
export type Action = 'connect' | 'restart' | 'write' | 'execute' | 'disconnect';
export interface Operation { readonly id: number; readonly action: Action; readonly phase: 'waiting' | 'probing' | 'info' | null }
/** filenameはワークスペースルートからの相対パス。 */
export interface Entry { filename: string }
export interface DeviceConfig { port?: string; baud?: number; autoDetect?: boolean; autoVerify?: boolean }
export interface ProjectConfig { compiler?: { version?: string }; libraries?: Entry[]; tasks?: Entry[] }
export interface Settings {
  version: string; autoDetect: boolean; port: string | null; baud: number;
  autoConnect: boolean; autoVerify: boolean; libraries: Entry[]; tasks: Entry[];
}
export interface Source { filename: string; source: string }
export interface Bytecodes { libraries: Uint8Array[]; tasks: Uint8Array[] }
export interface BoardInfo { readonly mrubyc: string | null; readonly rite: string | null; readonly error: string | null }
export interface VersionSelection { version: string; warning: string | null }
export interface Connection { readonly id: number; readonly path: string; readonly baud: number }
export interface State {
  readonly connection: Connection | null;
  readonly mode: 'unknown' | 'command' | 'run';
  readonly operation: Operation | null;
  readonly boardInfo: BoardInfo | null;
  readonly boardInfoLoading: boolean;
  readonly autoConnect: boolean;
  readonly disposed: boolean;
}
export interface PortInfo { path: string; manufacturer?: string; vendorId?: string; productId?: string }
export interface Port {
  readonly path: string;
  readonly baudRate: number;
  readonly isOpen: boolean;
  write(bytes: Uint8Array, callback: (error?: Error | null) => void): unknown;
  drain(callback: (error?: Error | null) => void): unknown;
  set(options: { brk: boolean; dtr: boolean; rts: boolean }, callback: (error?: Error | null) => void): unknown;
  close(callback: (error?: Error | null) => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}
export interface SerialTransport {
  list(): Promise<PortInfo[]>;
  create(portPath: string, baud: number, opened: (error?: Error | null) => void): Port;
}
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface Compiler { compile(directory: string, source: string): Promise<Uint8Array | null> }
export interface ProjectStore {
  readConfig(): ProjectConfig;
  writeConfig(config: ProjectConfig): void;
  readFile(filepath: string): string;
  expandPaths(filepaths: string[]): string[];
}
export interface ViewModel {
  state: State;
  settings: Settings;
  selected: VersionSelection;
  compilerAvailable: boolean;
  root: string | null;
  actions: Record<string, boolean>;
}
export interface Host {
  append(text: string): void;
  appendLine(text: string): void;
  showOutput(): void;
  beginAction(): void;
  notify(level: 'info' | 'warning' | 'error', message: string): void;
  readRubySource(): Source | null;
  workspaceRoot(): string | null;
  readDeviceConfig(): DeviceConfig;
  writeDeviceConfig(config: DeviceConfig): unknown;
  pickPort(ports: PortInfo[], cached: string | null): Promise<string | null>;
  pickVersion(versions: string[]): Promise<string | null>;
  pickBaud(): Promise<string | null>;
  inputBaud(): Promise<string | null>;
  pickFile(filenames: string[], key: ProjectKey): Promise<string | null>;
  openFilePaths(): string[];
  render(model: ViewModel): void;
  attach(context: Context): void;
  dispose(): void;
}
export interface Dependencies {
  host?: Partial<Host>;
  serial: SerialTransport;
  clock?: Clock;
  compiler?: Compiler;
  project?: ProjectStore;
  extensionPath?: string;
}
interface Owner { operationId: number | null; sessionId: number | null; epoch: number }
interface OperationRuntime {
  id: number;
  controller: AbortController;
  finish(value: unknown): void;
  disconnected: boolean;
}
interface Session {
  id: number; port: Port; decoder: TextDecoder; pending: string;
  listeners: Array<[string, (...args: any[]) => void]>;
  control: Promise<void>;
}
interface Candidate { id: number; port: Port | null; cancel(): void }
interface RequestRuntime {
  id: number; owner: Owner; accept(line: string): boolean;
  finish(line: string | null): void;
}
interface Probe { owner: Owner; accept(): void; cancel(): void }
export interface Runtime {
  operation: OperationRuntime | null;
  session: Session | null;
  candidates: Map<number, Candidate>;
  io: Map<number, { sessionId: number; cancel(): void }>;
  request: RequestRuntime | null;
  command: { id: number; owner: Owner } | null;
  probe: Probe | null;
  protocolEpoch: number;
  portPresent: boolean;
  boardInfoRequest: Promise<void> | null;
  timers: Set<unknown>;
  monitorTimer: unknown | null;
  monitorRequest: number | null;
  monitorGeneration: number;
  monitorStarted: boolean;
  disposeRequest: Promise<void> | null;
  nextId: number;
}
export interface Context {
  readonly host: Host;
  readonly serial: SerialTransport;
  readonly clock: Clock;
  readonly compiler: Compiler;
  readonly project: ProjectStore;
  readonly extensionPath: string;
  readonly runtime: Runtime;
  get(): State;
  transition(state: State): void;
}
const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
};
const emptyHost: Host = {
  append() {}, appendLine() {}, showOutput() {}, beginAction() {}, notify() {},
  readRubySource: () => null, workspaceRoot: () => null, readDeviceConfig: () => ({}), writeDeviceConfig() {},
  pickPort: async () => null, pickVersion: async () => null, pickBaud: async () => null,
  inputBaud: async () => null, pickFile: async () => null, openFilePaths: () => [], render() {}, attach() {}, dispose() {}
};
const freezeState = (state: State): State => Object.freeze({ ...state,
  operation: state.operation && Object.freeze({ ...state.operation }),
  connection: state.connection && Object.freeze({ ...state.connection }),
  boardInfo: state.boardInfo && Object.freeze({ ...state.boardInfo })
});

export function buildContext(dependencies: Dependencies): Context {
  let state = freezeState({ connection: null, mode: 'unknown', operation: null,
    boardInfo: null, boardInfoLoading: false, autoConnect: false, disposed: false });
  const host = { ...emptyHost, ...dependencies.host };
  const context: Context = {
    host, serial: dependencies.serial, clock: dependencies.clock ?? systemClock,
    extensionPath: dependencies.extensionPath ?? '',
    compiler: dependencies.compiler ?? createCompiler(host),
    project: dependencies.project ?? createProjectStore(host),
    runtime: { operation: null, session: null, candidates: new Map(), io: new Map(), request: null, command: null, probe: null,
      protocolEpoch: 0, portPresent: false,
      boardInfoRequest: null, timers: new Set(), monitorTimer: null, monitorRequest: null,
      monitorGeneration: 0, monitorStarted: false, disposeRequest: null, nextId: 0 },
    get: () => state,
    transition(next) {
      if (next === state) return;
      state = freezeState(next);
      if (!state.disposed) refreshAll(context);
    }
  };
  return context;
}
const owner = (context: Context): Owner => ({ operationId: context.get().operation?.id ?? null,
  sessionId: context.get().connection?.id ?? null, epoch: context.runtime.protocolEpoch });
const valid = (context: Context, token: Owner) => !context.get().disposed && (context.get().operation?.id ?? null) === token.operationId
  && (context.get().connection?.id ?? null) === token.sessionId && context.runtime.protocolEpoch === token.epoch;
const active = (context: Context, id: number) => !context.get().disposed && context.get().operation?.id === id;
const nextId = (context: Context) => ++context.runtime.nextId;
export const logInfo = (context: Context, message: string) => context.host.appendLine(`[info]  ${message}`);
export const logError = (context: Context, message: string) => { context.host.appendLine(`[error] ${message}`); context.host.showOutput(); };
function schedule(context: Context, milliseconds: number, callback: () => void) {
  const timer = context.clock.setTimeout(() => {
    context.runtime.timers.delete(timer);
    callback();
  }, milliseconds);
  context.runtime.timers.add(timer);
  return timer;
}
function clearTimer(context: Context, timer: unknown) {
  context.clock.clearTimeout(timer);
  context.runtime.timers.delete(timer);
}
function sleep(context: Context, milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimer(context, timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = schedule(context, milliseconds, finish);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}
function setPhase(context: Context, id: number, phase: Operation['phase']) {
  const state = context.get();
  if (state.operation?.id === id) context.transition({ ...state, operation: { ...state.operation, phase } });
}
function finishOperation(context: Context, id: number, value: unknown) {
  const operation = context.runtime.operation;
  if (!operation || operation.id !== id) return;
  context.runtime.operation = null;
  context.runtime.probe?.cancel();
  context.runtime.probe = null;
  context.runtime.request?.finish(null);
  context.transition({ ...context.get(), operation: null });
  operation.controller.abort();
  operation.finish(value);
}
function beginOperation<T>(context: Context, action: Action): { id: number; promise: Promise<T | undefined> } | null {
  if (context.get().operation || context.get().disposed) return null;
  const id = nextId(context);
  let finish!: (value: unknown) => void;
  const promise = new Promise<T | undefined>((resolve) => { finish = (value) => resolve(value as T | undefined); });
  context.runtime.operation = { id, finish, controller: new AbortController(), disconnected: false };
  context.runtime.monitorGeneration++;
  context.transition({ ...context.get(), operation: { id, action, phase: null } });
  context.host.showOutput();
  context.host.beginAction();
  return { id, promise };
}
export async function runAction<T>(context: Context, action: (operation: Operation) => Promise<T>, kind: Action = 'write'): Promise<T | undefined> {
  const started = beginOperation<T>(context, kind);
  if (!started) return;
  Promise.resolve().then(() => active(context, started.id) ? action(context.get().operation!) : undefined)
    .then((value) => finishOperation(context, started.id, value), (error) => {
      if (active(context, started.id)) logError(context, (error as Error).message);
      finishOperation(context, started.id, undefined);
    });
  return started.promise;
}
export function stopOperation(context: Context) {
  const operation = context.get().operation;
  if (!operation) return;
  resetProtocol(context);
  finishOperation(context, operation.id, false);
}

const encoder = new TextEncoder();
export const connected = (context: Context) => context.get().connection !== null;
export const sendText = (context: Context, text: string) => write(context, encoder.encode(text));
export function feed(context: Context, bytes: Uint8Array) {
  const session = context.runtime.session;
  if (!session || context.get().disposed) return;
  const text = session.decoder.decode(bytes, { stream: true });
  if (text) context.host.append(text);
  const lines = (session.pending + text).split('\r\n');
  session.pending = lines.pop() ?? '';
  for (const line of lines) {
    if (context.runtime.session !== session) break;
    handleLine(context, line, false);
  }
}
export function handleLine(context: Context, line: string, isPartial = false) {
  if (isPartial) return;
  checkCommandModePatterns(context, line);
  const request = context.runtime.request;
  if (request && valid(context, request.owner) && request.accept(line)
      && (line.startsWith('+OK') || line.startsWith('-ERR') || line.startsWith('+DONE'))) request.finish(line);
}
export function checkCommandModePatterns(context: Context, text: string) {
  const probe = context.runtime.probe;
  if (/Kani-Board, Please push Enter key to mrbw(?:r)?ite mode/.test(text)
      || /Kani-Board, End mrbwrite mode/.test(text)
      || /Kani-Board, mruby\/c .* start/.test(text)) {
    const run = /Kani-Board, mruby\/c .* start/.test(text);
    resetProtocol(context, run ? 'run' : 'unknown');
  } else if (probe && valid(context, probe.owner) && /^\+OK mruby\/c\s*$/.test(text)) {
    probe.accept();
    logInfo(context, 'Command mode entered.');
  }
}
export function resetProtocol(context: Context, mode: State['mode'] = 'unknown') {
  const { runtime } = context;
  const probe = runtime.probe;
  runtime.protocolEpoch++;
  runtime.probe = null;
  runtime.boardInfoRequest = null;
  probe?.cancel();
  runtime.request?.finish(null);
  const operation = context.get().operation;
  const establishing = operation && ['connect', 'restart'].includes(operation.action);
  context.transition({ ...context.get(), mode, boardInfo: null, boardInfoLoading: false,
    operation: establishing && probe ? { ...operation, phase: connected(context) ? 'probing' : 'waiting' } : operation });
  if (establishing && operation.phase === 'info' && !probe) finishOperation(context, operation.id, false);
}
export function waitForResponse(context: Context, timeout = 5000, accept = (_line: string) => true): Promise<string | null> {
  if (context.runtime.request) return Promise.reject(new Error('Another response is pending.'));
  const token = owner(context);
  if (!token.sessionId || context.get().disposed) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = nextId(context);
    let finished = false;
    const finish = (line: string | null) => {
      if (finished) return;
      finished = true;
      clearTimer(context, timer);
      if (context.runtime.request?.id === id) context.runtime.request = null;
      resolve(line);
    };
    const timer = schedule(context, timeout, () => finish(null));
    context.runtime.request = { id, owner: token, accept, finish };
  });
}
export async function sendCommand(context: Context, command: string, { ignoreResponse = false } = {}): Promise<string | null> {
  const token = owner(context);
  const pending = context.runtime.command;
  if (!valid(context, token) || !connected(context) || context.runtime.request || (pending && valid(context, pending.owner))) return null;
  const commandId = nextId(context);
  context.runtime.command = { id: commandId, owner: token };
  logInfo(context, `> ${command}`);
  try {
    if (ignoreResponse) { await sendText(context, command + '\r\n'); return null; }
    const accept = (line: string) => line.startsWith('-ERR') || (command === 'version'
      ? /^\+OK mruby\/c\s+\S+/.test(line)
      : command.startsWith('write') ? line.startsWith('+OK Write bytecode')
        : command === 'reset' ? /^\+OK\s*$/.test(line) : /^\+OK(?:\s+Execute)?\s*$/.test(line));
    const response = waitForResponse(context, 5000, accept);
    const request = context.runtime.request as RequestRuntime | null;
    try { await sendText(context, command + '\r\n'); }
    catch (error) { request?.finish(null); throw error; }
    const line = await response;
    return valid(context, token) || (command === 'reset' && token.operationId !== null && active(context, token.operationId)) ? line : null;
  } finally { if (context.runtime.command?.id === commandId) context.runtime.command = null; }
}
export function parseBoardInfo(response: string | null): BoardInfo {
  const fields = response?.trim().split(/\s+/) ?? [];
  if (fields[0] !== '+OK' || fields[1] !== 'mruby/c') {
    return { mrubyc: null, rite: null, error: response === null ? 'versionコマンドの応答がありません。' : `versionコマンドの応答を読み取れません: ${response}` };
  }
  return { mrubyc: /^v\d+(?:\.\d+)*$/.test(fields[2] ?? '') ? fields[2] : null,
    rite: /^RITE\d{4}$/.test(fields[3] ?? '') ? fields[3] : null, error: null };
}
export async function readBoardInfo(context: Context): Promise<void> {
  if (!connected(context) || context.get().mode !== 'command' || context.get().boardInfo) return;
  if (context.runtime.boardInfoRequest) return context.runtime.boardInfoRequest;
  const token = owner(context);
  context.transition({ ...context.get(), boardInfoLoading: true });
  const request = Promise.resolve().then(async () => {
    if (!valid(context, token)) return;
    let info: BoardInfo;
    try {
      context.runtime.session!.pending = '';
      info = parseBoardInfo(await sendCommand(context, 'version'));
    } catch (error) { info = { mrubyc: null, rite: null, error: `versionコマンドの送信に失敗しました: ${(error as Error).message}` }; }
    if (valid(context, token)) context.transition({ ...context.get(), boardInfo: info, boardInfoLoading: false });
  });
  context.runtime.boardInfoRequest = request;
  try { await request; }
  finally { if (context.runtime.boardInfoRequest === request) context.runtime.boardInfoRequest = null; }
}
/** writeコマンドに付けるCRC-16を計算する。 */
export function mrbwriteCrc16(data: Uint8Array): number {
  let crc = 0x0000;
  for (let byteIndex = 0; byteIndex < data.length; byteIndex++) {
    crc ^= data[byteIndex];
    for (let bitIndex = 0; bitIndex < 8; bitIndex++) crc = (crc & 0x0001) ? ((crc >> 1) ^ 0x8408) : (crc >> 1);
  }
  return (~crc) & 0xffff;
}
export async function writeBytecodes(context: Context, { libraries, tasks }: Bytecodes, autoVerify = getSettings(context).autoVerify): Promise<boolean> {
  const token = owner(context);
  if (!token.sessionId || context.get().mode !== 'command' || tasks.length === 0
      || (context.get().operation && context.get().operation?.action !== 'write')) return false;
  try {
    const cleared = await sendCommand(context, 'clear');
    if (!valid(context, token)) return false;
    if (!cleared?.startsWith('+OK')) {
      if (cleared === null) resetProtocol(context);
      logError(context, `clear failed: ${cleared}`);
      return false;
    }
    const entries = [...libraries.map((bytecode) => ({ command: 'write_lib', bytecode })),
      ...tasks.map((bytecode) => ({ command: 'write', bytecode }))];
    for (const { command, bytecode } of entries) {
      if (!valid(context, token) || context.get().mode !== 'command') return false;
      const crc = autoVerify ? ` ${mrbwriteCrc16(bytecode).toString(16).padStart(4, '0')}` : '';
      const response = await sendCommand(context, `${command} ${bytecode.length}${crc}`);
      if (!valid(context, token) || context.get().mode !== 'command') return false;
      if (!response?.startsWith('+OK Write bytecode')) {
        if (response === null) resetProtocol(context);
        logError(context, `${command} command failed: ${response}`);
        return false;
      }
      logInfo(context, `Sending bytecode (${bytecode.length} bytes)...`);
      const doneResponse = waitForResponse(context, 10000, (line) => line.startsWith('+DONE') || line.startsWith('-ERR'));
      await write(context, bytecode);
      const done = await doneResponse;
      if (!valid(context, token)) return false;
      if (done?.startsWith('+DONE')) logInfo(context, 'Write completed.');
      else {
        if (done === null) resetProtocol(context);
        logError(context, `Write failed: ${done}`);
        return false;
      }
    }
    return true;
  } catch (error) {
    if (valid(context, token)) { resetProtocol(context); logError(context, `Write failed: ${(error as Error).message}`); }
    return false;
  }
}
export async function execute(context: Context) {
  const token = owner(context);
  if (!token.sessionId || context.get().mode !== 'command'
      || (context.get().operation && context.get().operation?.action !== 'execute')) return;
  try {
    const response = await sendCommand(context, 'execute');
    if (!valid(context, token)) return;
    if (response?.startsWith('-ERR')) logError(context, `Execute failed: ${response}`);
    else {
      resetProtocol(context, response ? 'run' : 'unknown');
      if (response === null) logError(context, 'Execute response timed out.');
      else logInfo(context, 'Command mode exited.');
    }
  } catch (error) {
    if (valid(context, token)) { resetProtocol(context); logError(context, `Execute failed: ${(error as Error).message}`); }
  }
}

function removeSessionListeners(session: Session) {
  for (const [event, listener] of session.listeners) session.port.removeListener(event, listener);
  session.listeners.length = 0;
}
export function connect(context: Context, portPath: string, baudRate: number): Promise<void> {
  if (context.get().disposed || connected(context)) return Promise.reject(new Error('Connection unavailable.'));
  const operationId = context.get().operation?.id ?? null;
  const signal = context.runtime.operation?.controller.signal;
  const id = nextId(context);
  return new Promise((resolve, reject) => {
    let finished = false;
    let opened = false;
    let adopted = false;
    let port: Port;
    const session: Session = { id, port: null as unknown as Port, decoder: new TextDecoder(), pending: '', listeners: [], control: Promise.resolve() };
    const cleanup = () => { removeSessionListeners(session); context.runtime.candidates.delete(id); };
    const discard = () => {
      if (!opened) return;
      opened = false;
      try { port.close(() => cleanup()); } catch { cleanup(); }
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimer(context, timer);
      signal?.removeEventListener('abort', abort);
      if (error) { reject(error); discard(); } else resolve();
    };
    const abort = () => finish(new Error('Connection cancelled.'));
    const timer = schedule(context, OPEN_TIMEOUT, () => finish(new Error('Serial port open timed out.')));
    const usable = () => !context.get().disposed && !connected(context) && (context.get().operation?.id ?? null) === operationId;
    const onOpened = (error?: Error | null) => {
      if (adopted) return;
      if (error) { finish(error); cleanup(); return; }
      opened = true;
      if (finished || !usable()) { discard(); finish(new Error('Connection cancelled.')); return; }
      try {
        port.set({ brk: false, dtr: true, rts: true }, (error) => {
          if (adopted) return;
          if (finished || !usable()) { discard(); finish(new Error('Connection cancelled.')); return; }
          if (error) { finish(error); return; }
          adopted = true;
          context.runtime.session = session;
          context.runtime.candidates.delete(id);
          context.runtime.protocolEpoch++;
          context.runtime.monitorGeneration++;
          context.transition({ ...context.get(), connection: { id, path: portPath, baud: baudRate },
            mode: 'unknown', boardInfo: null, boardInfoLoading: false });
          finish();
        });
      } catch (error) { finish(error as Error); }
    };
    try {
      port = context.serial.create(portPath, baudRate, (error) => queueMicrotask(() => onOpened(error)));
      session.port = port;
      const listen = (event: string, listener: (...args: any[]) => void) => {
        session.listeners.push([event, listener]);
        port.on(event, listener);
      };
      listen('data', (bytes: Uint8Array) => { if (context.runtime.session === session) feed(context, bytes); });
      listen('close', () => {
        opened = false;
        if (adopted) onClose(context, port);
        else finish(new Error('Serial port closed while opening.'));
        cleanup();
      });
      listen('error', (error: Error) => {
        if (!adopted) { finish(error); return; }
        if (context.runtime.session === session && context.get().operation?.action !== 'disconnect') {
          resetProtocol(context);
          logError(context, `Serial error: ${error.message}`);
        }
      });
      context.runtime.candidates.set(id, { id, port, cancel: abort });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted || context.get().disposed) abort();
    } catch (error) { finish(error as Error); context.runtime.candidates.delete(id); }
  });
}
export function onClose(context: Context, port = context.runtime.session?.port) {
  const { runtime } = context;
  const session = runtime.session;
  if (!session || session.port !== port) return;
  runtime.session = null;
  removeSessionListeners(session);
  runtime.protocolEpoch++;
  runtime.probe?.cancel();
  runtime.probe = null;
  runtime.boardInfoRequest = null;
  runtime.request?.finish(null);
  for (const io of runtime.io.values()) if (io.sessionId === session.id) io.cancel();
  const operation = context.get().operation;
  const retry = operation && ['connect', 'restart'].includes(operation.action) && operation.phase !== 'info';
  if (retry) runtime.operation!.disconnected = true;
  context.transition({ ...context.get(), connection: null, mode: 'unknown', boardInfo: null, boardInfoLoading: false,
    operation: retry && operation.phase !== null ? { ...operation, phase: 'waiting' } : operation });
  if (!retry && operation && operation.action !== 'disconnect') finishOperation(context, operation.id, false);
  if (operation?.action !== 'disconnect') logInfo(context, 'Disconnected.');
}
export function write(context: Context, bytes: Uint8Array): Promise<void> {
  const session = context.runtime.session;
  const token = owner(context);
  if (!session || !valid(context, token)) return Promise.reject(new Error('Not connected'));
  const signal = context.runtime.operation?.controller.signal;
  const id = nextId(context);
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error | null) => {
      if (finished) return;
      finished = true;
      clearTimer(context, timer);
      signal?.removeEventListener('abort', abort);
      context.runtime.io.delete(id);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new Error('Serial write cancelled.'));
    const timer = schedule(context, WRITE_TIMEOUT, () => finish(new Error('Serial write timed out.')));
    signal?.addEventListener('abort', abort, { once: true });
    context.runtime.io.set(id, { sessionId: session.id, cancel: abort });
    try {
      if (!valid(context, token)) return abort();
      session.port.write(Buffer.from(bytes), finish);
    } catch (error) { finish(error as Error); }
  });
}
export function sendBreak(context: Context): Promise<void> {
  const session = context.runtime.session;
  if (!session) return Promise.resolve();
  const token = owner(context);
  const id = nextId(context);
  const signal = context.runtime.operation?.controller.signal;
  let finish!: (error?: Error | null) => void;
  let timer: unknown;
  let finished = false;
  const result = new Promise<void>((resolve, reject) => {
    finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimer(context, timer);
      signal?.removeEventListener('abort', abort);
      context.runtime.io.delete(id);
      if (error) reject(error); else resolve();
    };
  });
  const abort = () => finish(new Error('Break signal cancelled.'));
  const arm = () => {
    clearTimer(context, timer);
    if (!finished) timer = schedule(context, 5000, () => finish(new Error('Break signal timed out.')));
  };
  const set = (brk: boolean) => new Promise<void>((resolve, reject) => {
    let completed = false;
    arm();
    try {
      session.port.set({ brk, dtr: true, rts: true }, (error) => {
        if (completed) return;
        completed = true;
        clearTimer(context, timer);
        if (error) reject(error); else resolve();
      });
    } catch (error) { reject(error); }
  });
  arm();
  signal?.addEventListener('abort', abort, { once: true });
  context.runtime.io.set(id, { sessionId: session.id, cancel: abort });
  const task = session.control.catch(() => {}).then(async () => {
    if (!valid(context, token) || finished) return;
    try { await set(true); await sleep(context, 100, signal); }
    finally { if (context.runtime.session === session) await set(false); }
  });
  session.control = task;
  task.then(() => finish(), (error) => finish(error));
  return result;
}
function closePort(context: Context, session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error | null) => {
      if (finished) return;
      finished = true;
      clearTimer(context, timer);
      if (error) reject(error); else resolve();
    };
    const timer = schedule(context, 5000, () => finish(new Error('Serial port close timed out.')));
    try {
      session.port.close((error) => {
        if (context.runtime.session === session && (!error || !session.port.isOpen)) onClose(context, session.port);
        finish(error);
      });
    } catch (error) { finish(error as Error); }
  });
}
export async function disconnect(context: Context): Promise<void> {
  if (context.get().operation?.action === 'disconnect') return;
  if (!canAction(context, 'Disconnect')) return;
  stopOperation(context);
  setAutoConnect(context, false);
  const session = context.runtime.session;
  if (!session) return;
  await runAction(context, async () => {
    resetProtocol(context);
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearTimer(context, timer); resolve(); };
      const timer = schedule(context, 500, finish);
      try {
        session.port.write(Buffer.alloc(0), (error) => {
          if (finished) return;
          if (error) finish(); else { try { session.port.drain(finish); } catch { finish(); } }
        });
      } catch { finish(); }
    });
    if (context.runtime.session === session) await closePort(context, session);
  }, 'disconnect');
}

async function probeConnection(context: Context, id: number, attempt: number): Promise<boolean> {
  const operation = context.runtime.operation!;
  setPhase(context, id, 'probing');
  const token = owner(context);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, operation.controller.signal]);
  let acknowledged = false;
  const probe: Probe = {
    owner: token,
    accept() {
      acknowledged = true;
      const state = context.get();
      context.transition({ ...state, mode: 'command', operation: { ...state.operation!, phase: 'info' } });
    },
    cancel: () => controller.abort()
  };
  context.runtime.probe = probe;
  logInfo(context, `Entering command mode... (${attempt}/${CONNECT_RETRIES})`);
  try {
    await sendText(context, '\r\n');
    if (!valid(context, token)) return false;
    await sleep(context, CONNECT_INTERVAL, signal);
    return valid(context, token) && acknowledged;
  } catch {
    if (valid(context, token) && acknowledged) {
      resetProtocol(context);
      finishOperation(context, id, false);
    }
    return false;
  } finally {
    controller.abort();
    if (context.runtime.probe === probe) context.runtime.probe = null;
  }
}
async function establishDevice(context: Context, id: number, portPath: string, baud: number, quiet: boolean): Promise<boolean> {
  const signal = context.runtime.operation!.controller.signal;
  for (let attempt = 1; attempt <= CONNECT_RETRIES && active(context, id); attempt++) {
    const started = context.clock.now();
    if (!connected(context)) {
      setPhase(context, id, 'waiting');
      logInfo(context, `Listing ports (${portPath})... (${attempt}/${CONNECT_RETRIES})`);
      let ports: PortInfo[] = [];
      try { ports = await context.serial.list(); } catch {}
      if (!active(context, id)) return false;
      if (ports.some((port) => port.path === portPath)) {
        logInfo(context, `Connecting (${baud} baud, ${portPath})...`);
        try {
          await connect(context, portPath, baud);
          if (!active(context, id)) return false;
          logInfo(context, quiet ? 'Auto-connected.' : 'Connected.');
        } catch (error) {
          if (active(context, id) && !quiet) logError(context, `Connect failed: ${(error as Error).message}`);
        }
      }
    }
    if (!active(context, id)) return false;
    if (connected(context) && await probeConnection(context, id, attempt)) {
      const token = owner(context);
      await readBoardInfo(context);
      return valid(context, token) && context.get().mode === 'command';
    }
    if (!active(context, id)) return false;
    await sleep(context, Math.max(0, CONNECT_INTERVAL - (context.clock.now() - started)), signal);
  }
  if (active(context, id)) {
    if (!quiet) logError(context, `Connection failed after ${CONNECT_RETRIES} attempts.`);
    resetProtocol(context);
  }
  return false;
}
export async function pickPort(context: Context): Promise<string | null> {
  const operationId = context.get().operation?.id ?? null;
  const eligible = () => !context.get().disposed && (context.get().operation?.id ?? null) === operationId;
  let ports: PortInfo[];
  try { ports = await context.serial.list(); }
  catch (error) { if (eligible()) logError(context, `Failed to list ports: ${(error as Error).message}`); return null; }
  if (!eligible()) return null;
  if (!ports.length) { context.host.notify('error', 'kaniburner: No serial ports found.'); return null; }
  const picked = await context.host.pickPort(ports, getSettings(context).port);
  if (!picked || !eligible()) return null;
  updateDevice(context, { port: picked });
  return picked;
}
export async function connectDevice(context: Context, quiet = false): Promise<boolean> {
  if (!canAction(context, 'Connect')) return false;
  const started = beginOperation<boolean>(context, 'connect')!;
  const { port, baud } = getSettings(context);
  const select = async () => {
    const portPath = port ?? await pickPort(context);
    if (!active(context, started.id)) return;
    if (!portPath) { finishOperation(context, started.id, false); return; }
    finishOperation(context, started.id, await establishDevice(context, started.id, portPath, baud, quiet));
  };
  void select().catch((error) => { if (active(context, started.id)) logError(context, error.message); finishOperation(context, started.id, false); });
  return await started.promise ?? false;
}
export async function restartAndReconnect(context: Context): Promise<boolean> {
  if (!canAction(context, 'Restart')) return false;
  const connection = context.get().connection!;
  const command = context.get().mode === 'command';
  stopOperation(context);
  resetProtocol(context);
  const started = beginOperation<boolean>(context, 'restart')!;
  const operation = context.runtime.operation!;
  const restart = async () => {
    try {
      if (command) {
        const response = await sendCommand(context, 'reset');
        if (!active(context, started.id)) return;
        if (!operation.disconnected && !response?.startsWith('+OK')) {
          logError(context, `Restart failed: ${response}`);
          finishOperation(context, started.id, false);
          return;
        }
      } else { logInfo(context, '> break'); await sendBreak(context); }
    } catch (error) {
      if (!active(context, started.id)) return;
      if (!operation.disconnected) {
        resetProtocol(context);
        logError(context, `Connection failed: ${(error as Error).message}`);
        finishOperation(context, started.id, false);
        return;
      }
    }
    if (!active(context, started.id)) return;
    setPhase(context, started.id, connected(context) ? 'probing' : 'waiting');
    await sleep(context, CONNECT_INTERVAL, operation.controller.signal);
    if (!active(context, started.id)) return;
    finishOperation(context, started.id, await establishDevice(context, started.id, connection.path, connection.baud, false));
  };
  void restart().catch((error) => { if (active(context, started.id)) logError(context, error.message); finishOperation(context, started.id, false); });
  return await started.promise ?? false;
}
export function cancelConnection(context: Context) {
  if (!canAction(context, 'Cancel')) return;
  setAutoConnect(context, false);
  stopOperation(context);
  logInfo(context, 'Connection attempt cancelled.');
}
export async function ensureReady(context: Context): Promise<boolean> { return connected(context) && context.get().mode === 'command'; }
export const autoConnectEnabled = (context: Context) => getSettings(context).port !== null && context.get().autoConnect;
export function setAutoConnect(context: Context, enabled: boolean) {
  context.runtime.monitorGeneration++;
  context.runtime.portPresent = false;
  context.transition({ ...context.get(), autoConnect: enabled });
}
export async function pollAutoConnect(context: Context) {
  const { runtime } = context;
  if (context.get().disposed || runtime.monitorRequest !== null || context.get().operation || connected(context) || !autoConnectEnabled(context)) return;
  const { port, baud } = getSettings(context);
  const generation = runtime.monitorGeneration;
  const id = nextId(context);
  runtime.monitorRequest = id;
  try {
    const present = (await context.serial.list()).some((info) => info.path === port);
    if (context.get().disposed || runtime.monitorGeneration !== generation || context.get().operation || connected(context) || !autoConnectEnabled(context)) return;
    if (getSettings(context).port !== port || getSettings(context).baud !== baud) return;
    const appeared = present && !runtime.portPresent;
    runtime.portPresent = present;
    if (appeared) await connectDevice(context, true);
  } catch {}
  finally { if (runtime.monitorRequest === id) runtime.monitorRequest = null; }
}
export function startAutoConnect(context: Context) {
  if (context.runtime.monitorStarted || context.get().disposed) return;
  context.runtime.monitorStarted = true;
  const tick = () => {
    if (context.get().disposed) return;
    context.runtime.monitorTimer = schedule(context, CONNECT_INTERVAL, tick);
    void pollAutoConnect(context);
  };
  context.runtime.monitorTimer = schedule(context, CONNECT_INTERVAL, tick);
}
export function disposeContext(context: Context): Promise<void> {
  if (context.runtime.disposeRequest) return context.runtime.disposeRequest;
  const dispose = async () => {
    stopOperation(context);
    context.transition({ ...context.get(), disposed: true, autoConnect: false });
    context.runtime.portPresent = false;
    context.runtime.monitorGeneration++;
    if (context.runtime.monitorTimer !== null) clearTimer(context, context.runtime.monitorTimer);
    for (const candidate of context.runtime.candidates.values()) candidate.cancel();
    for (const io of context.runtime.io.values()) io.cancel();
    context.runtime.request?.finish(null);
    const session = context.runtime.session;
    if (session) {
      try { await closePort(context, session); }
      catch (error) { logError(context, `Disconnect failed: ${(error as Error).message}`); }
      removeSessionListeners(session);
      if (context.runtime.session === session) onClose(context, session.port);
    }
    for (const timer of context.runtime.timers) clearTimer(context, timer);
    context.host.dispose();
  };
  context.runtime.disposeRequest = dispose();
  return context.runtime.disposeRequest;
}

function settingsChanged(context: Context) {
  context.runtime.monitorGeneration++;
  context.runtime.portPresent = false;
  refreshAll(context);
}
export const readDeviceConfig = (context: Context): DeviceConfig => context.host.readDeviceConfig();
export function writeDeviceConfig(context: Context, config: DeviceConfig) {
  const result = context.host.writeDeviceConfig(config);
  settingsChanged(context);
  return result;
}
export const workspaceRoot = (context: Context) => context.host.workspaceRoot();
export function projectConfigPath(context: Context): string | null {
  const root = workspaceRoot(context);
  return root ? path.join(root, PROJECT_CONFIG_FILENAME) : null;
}
export const readProjectConfig = (context: Context): ProjectConfig => context.project.readConfig();
export function writeProjectConfig(context: Context, config: ProjectConfig) {
  context.project.writeConfig(config);
  settingsChanged(context);
}
export function getSettings(context: Context): Settings {
  const device = readDeviceConfig(context);
  const project = readProjectConfig(context);
  return { version: project.compiler?.version ?? '4.0.0', autoDetect: device.autoDetect ?? true,
    port: device.port ?? null, baud: device.baud ?? 115200, autoConnect: context.get().autoConnect,
    autoVerify: device.autoVerify ?? true, libraries: project.libraries ?? [], tasks: project.tasks ?? [] };
}
export function updateCompiler(context: Context, patch: NonNullable<ProjectConfig['compiler']>) {
  const config = readProjectConfig(context);
  writeProjectConfig(context, { ...config, compiler: { ...config.compiler, ...patch } });
}
export function updateDevice(context: Context, patch: DeviceConfig) { writeDeviceConfig(context, { ...readDeviceConfig(context), ...patch }); }
export function addProjectEntries(context: Context, key: ProjectKey, filenames: string[]) {
  const config = readProjectConfig(context);
  writeProjectConfig(context, { ...config, [key]: [...(config[key] ?? []), ...filenames.map((filename) => ({ filename }))] });
}
export function removeProjectEntry(context: Context, key: ProjectKey, index: number) {
  const config = readProjectConfig(context);
  if (!config[key]?.[index]) return;
  writeProjectConfig(context, { ...config, [key]: config[key]!.filter((_, position) => position !== index) });
}
export function moveProjectEntry(context: Context, key: ProjectKey, index: number, delta: number) {
  const config = readProjectConfig(context);
  const entries = [...(config[key] ?? [])];
  const destination = index + delta;
  if (!entries[index] || destination < 0 || destination >= entries.length) return;
  [entries[index], entries[destination]] = [entries[destination], entries[index]];
  writeProjectConfig(context, { ...config, [key]: entries });
}
export function resolveCompilerVersion(context: Context): VersionSelection {
  const { version, autoDetect } = getSettings(context);
  if (!autoDetect) return { version, warning: null };
  if (!connected(context)) return { version, warning: 'デバイスが接続されていません。' };
  const { boardInfo } = context.get();
  if (!boardInfo) return { version, warning: 'ボードのバージョン情報を取得していません。' };
  if (boardInfo.error) return { version, warning: boardInfo.error };
  if (!boardInfo.rite) return { version, warning: '対応するRITE形式を取得できません。' };
  const detected = RITE_COMPILERS[boardInfo.rite];
  return detected ? { version: detected, warning: null }
    : { version, warning: `${boardInfo.rite}に対応する同梱コンパイラがありません。` };
}
export function compilerDirectory(context: Context): string | null {
  const { version } = resolveCompilerVersion(context);
  return AVAILABLE_VERSIONS.includes(version) ? path.join(context.extensionPath, 'media', `mruby-${version}`) : null;
}
export function toAbsoluteFilepath(context: Context, filename: string): string | null {
  if (path.isAbsolute(filename)) return filename;
  const root = workspaceRoot(context);
  return root ? path.join(root, filename) : null;
}
export function readSources(context: Context, entries: Entry[], kindLabel: string): Source[] | null {
  const sources: Source[] = [];
  for (const { filename } of entries) {
    const filepath = toAbsoluteFilepath(context, filename);
    try {
      if (!filepath) throw new Error('unresolved');
      sources.push({ filename, source: context.project.readFile(filepath) });
    } catch {
      context.host.notify('warning', `kaniburner: ${kindLabel} のファイルを開けません: ${filename}`);
      return null;
    }
  }
  return sources;
}
export function resolveTaskSources(context: Context): Source[] | null {
  const { tasks } = getSettings(context);
  if (tasks.length) return readSources(context, tasks, 'tasks');
  const source = context.host.readRubySource();
  if (!source) { context.host.notify('warning', 'kaniburner: .rbファイルを開いてください'); return null; }
  return [source];
}
export function toProjectFilename(context: Context, filepath: string): string | null {
  const root = workspaceRoot(context);
  if (!root || !filepath.endsWith('.rb')) return null;
  const filename = path.relative(root, filepath);
  if (filename.startsWith('..') || path.isAbsolute(filename)) return null;
  return filename;
}
export const expandDirectories = (context: Context, filepaths: string[]) => context.project.expandPaths(filepaths);
export function unregisteredFilenames(context: Context, key: ProjectKey, filepaths: string[]): string[] {
  const registered = new Set(getSettings(context)[key].map((entry) => entry.filename));
  const filenames = new Set<string>();
  for (const filepath of filepaths) {
    const filename = toProjectFilename(context, filepath);
    if (filename && !registered.has(filename)) filenames.add(filename);
  }
  return [...filenames];
}
export async function selectVersion(context: Context) {
  const picked = await context.host.pickVersion(AVAILABLE_VERSIONS);
  if (picked && !context.get().disposed) { updateCompiler(context, { version: picked }); updateDevice(context, { autoDetect: false }); }
}
export async function selectBaud(context: Context) {
  const picked = await context.host.pickBaud();
  if (!picked || context.get().disposed) return;
  if (picked !== 'その他...') { updateDevice(context, { baud: parseInt(picked, 10) }); return; }
  const input = await context.host.inputBaud();
  if (input && !context.get().disposed) updateDevice(context, { baud: parseInt(input.trim(), 10) });
}
export async function addProjectFile(context: Context, key: ProjectKey, filepaths: string[]) {
  if (filepaths.length) {
    const filenames = unregisteredFilenames(context, key, expandDirectories(context, filepaths));
    if (!filenames.length) { context.host.notify('info', 'kaniburner: 追加できる .rb ファイルがありません。'); return; }
    addProjectEntries(context, key, filenames);
    return;
  }
  const candidates = unregisteredFilenames(context, key, context.host.openFilePaths());
  if (!candidates.length) { context.host.notify('info', 'kaniburner: 追加できる未登録の .rb タブがありません。'); return; }
  const picked = await context.host.pickFile(candidates, key);
  if (picked && !context.get().disposed) addProjectEntries(context, key, [picked]);
}

export const compile = (context: Context, directory: string, source: string) => context.compiler.compile(directory, source);
export async function compileSources(context: Context, directory: string, sources: Source[]): Promise<Uint8Array[] | null> {
  const token = owner(context);
  const bytecodes: Uint8Array[] = [];
  for (const { filename, source } of sources) {
    if (!valid(context, token)) return null;
    const bytecode = await compile(context, directory, source);
    if (!valid(context, token)) return null;
    if (!bytecode) { logError(context, `Compile failed: ${filename}`); return null; }
    bytecodes.push(bytecode);
  }
  return bytecodes;
}
export async function compileAll(context: Context): Promise<Bytecodes | null> {
  const { version } = resolveCompilerVersion(context);
  const directory = compilerDirectory(context);
  if (!directory) { context.host.notify('error', `kaniburner: mruby ${version} が見つかりません。`); return null; }
  const librarySources = readSources(context, getSettings(context).libraries, 'libraries');
  if (!librarySources) return null;
  const taskSources = resolveTaskSources(context);
  if (!taskSources) return null;
  const token = owner(context);
  logInfo(context, `Compiling (mruby ${version})...`);
  const libraries = await compileSources(context, directory, librarySources);
  if (!libraries || !valid(context, token)) return null;
  const tasks = await compileSources(context, directory, taskSources);
  if (!tasks || !valid(context, token)) return null;
  const total = [...libraries, ...tasks].reduce((sum, bytecode) => sum + bytecode.length, 0);
  logInfo(context, `Compile succeeded. (${total} bytes)`);
  return { libraries, tasks };
}
export async function compileAndWrite(context: Context) {
  if ((context.get().operation && context.get().operation?.action !== 'write') || !await ensureReady(context)) return;
  const token = owner(context);
  const { autoVerify } = getSettings(context);
  const compiled = await compileAll(context);
  if (!compiled || !valid(context, token)) return;
  await writeBytecodes(context, compiled, autoVerify);
}
export function canAction(context: Context, name: string): boolean {
  const { operation, mode, disposed } = context.get();
  if (disposed) return false;
  const isConnected = connected(context);
  const idle = operation === null;
  const probing = operation?.phase === 'probing';
  if (name === 'Connect') return idle && !isConnected;
  if (name === 'Cancel') return !!operation && ['connect', 'restart'].includes(operation.action)
    && (operation.phase === 'waiting' || operation.phase === 'probing');
  if (name === 'Disconnect') return isConnected && (!operation || ['write', 'execute'].includes(operation.action));
  if (name === 'Restart') return isConnected && (idle || probing);
  if (name === 'Execute') return idle && isConnected && mode === 'command';
  if (name === 'Write') return idle && isConnected && mode === 'command' && compilerDirectory(context) !== null
    && (getSettings(context).tasks.length > 0 || context.host.readRubySource() !== null);
  return false;
}
export function refreshAll(context: Context) {
  const actions: Record<string, boolean> = { connected: connected(context) };
  for (const name of ['Compile', 'Connect', 'Cancel', 'Disconnect', 'Write', 'Execute', 'Restart']) actions[`can${name}`] = canAction(context, name);
  context.host.render({ state: context.get(), settings: getSettings(context), selected: resolveCompilerVersion(context),
    compilerAvailable: compilerDirectory(context) !== null, root: workspaceRoot(context), actions });
}

interface MrbcModule {
  FS: { writeFile(path: string, data: string): void; unlink(path: string): void; readFile(path: string): Uint8Array };
  callMain(args: string[]): number;
}
type MrbcFactory = (options: Record<string, unknown>) => Promise<MrbcModule>;
export function createCompiler(host: Pick<Host, 'append' | 'appendLine' | 'showOutput'>): Compiler {
  const modules = new Map<string, Promise<MrbcModule>>();
  const error = (message: string) => { host.appendLine(`[error] ${message}`); host.showOutput(); };
  return {
    async compile(directory, source) {
      if (!source.trim()) { error('Source code is empty.'); return null; }
      let loading = modules.get(directory);
      if (!loading) {
        const factory = require(path.join(directory, 'mrbc.js')) as MrbcFactory;
        loading = factory({ noInitialRun: true, print: (text: string) => host.append(text), printErr: (text: string) => host.append(`[stderr] ${text}`) });
        modules.set(directory, loading);
      }
      let module: MrbcModule;
      try { module = await loading; }
      catch (failure) { modules.delete(directory); throw failure; }
      module.FS.writeFile('/input.rb', source);
      try { module.FS.unlink('/output.mrb'); } catch { /* 初回は存在しない。 */ }
      try {
        const exitCode = module.callMain(['-o', '/output.mrb', '/input.rb']);
        if (exitCode !== 0) { error(`Compile failed (exit code ${exitCode}).`); return null; }
        return new Uint8Array(module.FS.readFile('/output.mrb'));
      } catch (failure) { error(`Compile error: ${(failure as Error).message}`); return null; }
    }
  };
}
export function createProjectStore(host: Pick<Host, 'workspaceRoot' | 'appendLine' | 'showOutput' | 'notify'>): ProjectStore {
  const configPath = () => { const root = host.workspaceRoot(); return root ? path.join(root, '.vscode/kaniburner.json') : null; };
  const rubyFilepaths = (directory: string): string[] => {
    const filepaths: string[] = [];
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filepath = path.join(directory, entry.name);
      if (entry.isDirectory()) filepaths.push(...rubyFilepaths(filepath));
      else if (entry.name.endsWith('.rb')) filepaths.push(filepath);
    }
    return filepaths;
  };
  return {
    readConfig() {
      const filepath = configPath();
      if (!filepath || !fs.existsSync(filepath)) return {};
      try { return JSON.parse(fs.readFileSync(filepath, 'utf8')) as ProjectConfig; }
      catch (error) { host.appendLine(`[error] Failed to read .vscode/kaniburner.json: ${(error as Error).message}`); host.showOutput(); return {}; }
    },
    writeConfig(config) {
      const filepath = configPath();
      if (!filepath) { host.notify('warning', 'kaniburner: プロジェクト設定を保存するにはフォルダを開いてください。'); return; }
      fs.mkdirSync(path.dirname(filepath), { recursive: true });
      fs.writeFileSync(filepath, JSON.stringify(config, null, 2) + '\n');
    },
    readFile: (filepath) => fs.readFileSync(filepath, 'utf8'),
    expandPaths: (filepaths) => filepaths.flatMap((filepath) => fs.statSync(filepath, { throwIfNoEntry: false })?.isDirectory() ? rubyFilepaths(filepath) : [filepath])
  };
}
export function createSerialTransport(Port: typeof SerialPort): SerialTransport {
  return { list: () => Port.list(), create: (portPath, baudRate, opened) => new Port({ path: portPath, baudRate }, opened) };
}

export type Item = vscode.TreeItem & { key?: ProjectKey; index?: number };
export type Provider = vscode.TreeDataProvider<Item> & { refresh(): void; dispose(): void };
export interface VscodeHost extends Host {
  readonly api: typeof vscode;
  model: ViewModel | null;
  readonly projectProvider: Provider;
  readonly deviceProvider: Provider;
  readonly statusBar: vscode.StatusBarItem;
  rememberEditor(editor: vscode.TextEditor | undefined): void;
  activeRubyDocument(): vscode.TextDocument | null;
}

export function createProvider(api: typeof vscode, build: (element?: Item) => Item[]): Provider {
  const emitter = new api.EventEmitter<void>();
  return {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (item) => item,
    getChildren: build,
    refresh: () => emitter.fire(),
    dispose: () => emitter.dispose()
  };
}

/** 値を表示し、行内アクションで変更する設定行を作る。 */
export function settingItem(context: VscodeHost, label: string, value: string, contextValue: string, iconName: string): Item {
  const item = new context.api.TreeItem(label);
  item.description = value;
  item.contextValue = contextValue;
  item.iconPath = new context.api.ThemeIcon(iconName);
  return item;
}

export function buildDeviceView(context: VscodeHost, element?: Item): Item[] {
  if (element) return [];
  const settings = context.model!.settings;
  const selected = context.model!.selected;
  const version = settingItem(context, 'mruby', selected.version, 'deviceVersion', 'check');
  if (!context.model!.compilerAvailable) {
    version.description = `${selected.version} (not found)`;
    version.iconPath = new context.api.ThemeIcon('warning', new context.api.ThemeColor('errorForeground'));
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

export function boardVersionItem(context: VscodeHost): Item {
  const { connection, boardInfo, boardInfoLoading } = context.model!.state;
  const value = !connection ? '(not connected)' : boardInfo?.mrubyc ?? (boardInfoLoading ? '(reading)' : '(unknown)');
  const item = settingItem(context, 'mruby/c VM', value, 'deviceVmVersion', 'circuit-board');
  if (connection) {
    item.tooltip = `接続先: ${connection.path}`;
    if (!boardInfo?.mrubyc && !boardInfoLoading) {
      setItemWarning(context, item, `${item.tooltip}\n${boardInfo?.error ?? 'VMのバージョンを取得できません。'}`);
    }
  }
  return item;
}

export function checkboxItem(context: VscodeHost, label: string, checked: boolean, contextValue: string): Item {
  const item: Item = new context.api.TreeItem(label);
  item.contextValue = contextValue;
  item.iconPath = new context.api.ThemeIcon('sync');
  item.checkboxState = checked
    ? context.api.TreeItemCheckboxState.Checked
    : context.api.TreeItemCheckboxState.Unchecked;
  return item;
}

export function setItemWarning(context: VscodeHost, item: Item, message: string) {
  item.iconPath = new context.api.ThemeIcon('warning', new context.api.ThemeColor('editorWarning.foreground'));
  item.tooltip = message;
  if (typeof item.checkboxState === 'number') item.checkboxState = { state: item.checkboxState, tooltip: message };
}

export function projectParent(context: VscodeHost, label: string, key: ProjectKey, count: number): Item {
  const item: Item = new context.api.TreeItem(label, context.api.TreeItemCollapsibleState.Expanded);
  item.contextValue = `${key}Parent`;
  item.key = key;
  item.description = String(count);
  item.iconPath = new context.api.ThemeIcon('folder');
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

export function projectChildren(context: VscodeHost, key: ProjectKey, entries: Entry[]): Item[] {
  return entries.map(({ filename }, index) => {
    const item: Item = new context.api.TreeItem(filename);
    item.contextValue = `projectFile${projectPosition(index, entries.length)}`;
    item.iconPath = new context.api.ThemeIcon('file');
    item.key = key;
    item.index = index;
    const filepath = path.isAbsolute(filename) ? filename : context.model!.root ? path.join(context.model!.root, filename) : null;
    if (filepath) {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [context.api.Uri.file(filepath)] };
    }
    return item;
  });
}

export function buildProjectView(context: VscodeHost, element?: Item): Item[] {
  if (!context.model!.root) return [];
  const settings = context.model!.settings;
  if (!element) {
    return [
      projectParent(context, 'Libraries', 'libraries', settings.libraries.length),
      projectParent(context, 'Tasks', 'tasks', settings.tasks.length)
    ];
  }
  return element.key ? projectChildren(context, element.key, settings[element.key]) : [];
}

export function refreshStatusBar(host: VscodeHost) {
  if (!host.model) return;
  const { connection, mode } = host.model.state;
  const status = !connection ? 'Offline' : mode === 'command' ? 'Command' : mode === 'run' ? 'Run' : 'Connected';
  const icon = { Offline: 'debug-disconnect', Connected: 'plug', Command: 'terminal', Run: 'play' }[status];
  host.statusBar.text = `$(${icon}) kaniburner`;
  host.statusBar.tooltip = connection ? `kaniburner: ${status}\n${connection.path} (${connection.baud} baud)`
    : 'kaniburner: Offline\nBoard not connected.';
  host.statusBar.accessibilityInformation = { label: `kaniburner: ${status}` };
}
export function uriArguments(api: typeof vscode, target: unknown, targets: unknown): string[] {
  const uris = Array.isArray(targets) ? targets.filter((item): item is vscode.Uri => item instanceof api.Uri)
    : target instanceof api.Uri ? [target] : [];
  return uris.map((uri) => uri.fsPath);
}
export function createVscodeHost(api: typeof vscode, extensionContext: vscode.ExtensionContext): VscodeHost {
  const output = api.window.createOutputChannel('kaniburner');
  const statusBar = api.window.createStatusBarItem('kaniburner.connection', api.StatusBarAlignment.Left);
  statusBar.name = 'kaniburner';
  statusBar.command = { command: 'workbench.action.quickOpen', title: 'kaniburner commands', arguments: ['>kaniburner: '] };
  let lastRubyDocument: vscode.TextDocument | null = null;
  let disposed = false;
  const subscriptions: vscode.Disposable[] = [output, statusBar];
  const host: VscodeHost = {
    api, model: null, statusBar,
    projectProvider: createProvider(api, (element) => host.model ? buildProjectView(host, element) : []),
    deviceProvider: createProvider(api, (element) => host.model ? buildDeviceView(host, element) : []),
    append: (text) => { if (!disposed) output.append(text); },
    appendLine: (text) => { if (!disposed) output.appendLine(text); },
    showOutput: () => { if (!disposed) output.show(true); },
    beginAction: () => { void api.commands.executeCommand('setContext', 'outputView.scrollLock', false); },
    notify: (level, message) => {
      if (level === 'error') void api.window.showErrorMessage(message);
      else if (level === 'warning') void api.window.showWarningMessage(message);
      else void api.window.showInformationMessage(message);
    },
    rememberEditor(editor) { if (editor?.document.fileName.endsWith('.rb')) lastRubyDocument = editor.document; },
    activeRubyDocument() {
      const active = api.window.activeTextEditor;
      if (active?.document.fileName.endsWith('.rb')) return active.document;
      if (lastRubyDocument && !lastRubyDocument.isClosed) return lastRubyDocument;
      return api.window.visibleTextEditors.find((editor) => editor.document.fileName.endsWith('.rb'))?.document ?? null;
    },
    readRubySource() {
      const document = host.activeRubyDocument();
      return document ? { filename: path.basename(document.fileName), source: document.getText() } : null;
    },
    workspaceRoot: () => api.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
    readDeviceConfig: () => extensionContext.workspaceState.get<DeviceConfig>('kaniburner.device') ?? {},
    writeDeviceConfig: (config) => extensionContext.workspaceState.update('kaniburner.device', config),
    async pickPort(ports, cached) {
      const items = ports.map((port) => ({ label: port.path,
        description: [port.manufacturer, port.vendorId && `VID:${port.vendorId}`, port.productId && `PID:${port.productId}`].filter(Boolean).join(' ') || undefined,
        picked: port.path === cached }));
      const picked = await api.window.showQuickPick(items, { title: 'kaniburner: Select serial port', placeHolder: cached ? `Last used: ${cached}` : 'Pick a port' });
      return picked?.label ?? null;
    },
    pickVersion: async (versions) => await api.window.showQuickPick(versions, { title: 'kaniburner: Select mruby version' }) ?? null,
    pickBaud: async () => await api.window.showQuickPick(['9600', '19200', '115200', 'その他...'], { title: 'kaniburner: Select baud rate' }) ?? null,
    inputBaud: async () => await api.window.showInputBox({ title: 'kaniburner: Baud rate', placeHolder: 'e.g. 57600',
      validateInput: (value) => (/^[1-9][0-9]*$/.test(value.trim()) ? null : '正の整数を入力してください') }) ?? null,
    pickFile: async (filenames, key) => await api.window.showQuickPick(filenames, { title: key === 'libraries' ? 'kaniburner: Add library' : 'kaniburner: Add task' }) ?? null,
    openFilePaths() {
      const filepaths: string[] = [];
      for (const group of api.window.tabGroups.all) for (const tab of group.tabs) {
        const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
        if (uri) filepaths.push(uri.fsPath);
      }
      return filepaths;
    },
    render(model) {
      if (disposed) return;
      host.model = model;
      host.projectProvider.refresh();
      host.deviceProvider.refresh();
      for (const [key, value] of Object.entries(model.actions)) void api.commands.executeCommand('setContext', `kaniburner.${key}`, value);
      refreshStatusBar(host);
    },
    attach(context) {
      extensionContext.subscriptions.push({ dispose: () => { void disposeContext(context); } });
      host.rememberEditor(api.window.activeTextEditor);
      subscriptions.push(api.window.onDidChangeActiveTextEditor((editor) => { host.rememberEditor(editor); refreshAll(context); }));
      const deviceView = api.window.createTreeView<Item>('kaniburner.device', { treeDataProvider: host.deviceProvider });
      subscriptions.push(api.window.registerTreeDataProvider('kaniburner.project', host.projectProvider), deviceView,
        deviceView.onDidChangeCheckboxState(({ items }) => {
          for (const [item, state] of items) {
            if (item.contextValue === 'deviceAutoConnect') setAutoConnect(context, state === api.TreeItemCheckboxState.Checked);
            else if (item.contextValue === 'deviceAutoDetect') updateDevice(context, { autoDetect: state === api.TreeItemCheckboxState.Checked });
            else if (item.contextValue === 'deviceAutoVerify') updateDevice(context, { autoVerify: state === api.TreeItemCheckboxState.Checked });
          }
        }));
      statusBar.show();
      const refresh = () => settingsChanged(context);
      const watcher = api.workspace.createFileSystemWatcher(`**/${PROJECT_CONFIG_FILENAME}`);
      subscriptions.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
      const register = (id: string, handler: (...args: any[]) => unknown) => subscriptions.push(api.commands.registerCommand(id, handler));
      register('kaniburner.selectVersion', () => selectVersion(context));
      register('kaniburner.selectBaud', () => selectBaud(context));
      register('kaniburner.selectPort', () => pickPort(context));
      register('kaniburner.addLibrary', (target, targets) => addProjectFile(context, 'libraries', uriArguments(api, target, targets)));
      register('kaniburner.addTask', (target, targets) => addProjectFile(context, 'tasks', uriArguments(api, target, targets)));
      register('kaniburner.removeProjectFile', (node: Item) => {
        if (node?.key !== undefined && node.index !== undefined) removeProjectEntry(context, node.key, node.index);
      });
      register('kaniburner.moveProjectFileUp', (node: Item) => {
        if (node?.key !== undefined && node.index !== undefined) moveProjectEntry(context, node.key, node.index, -1);
      });
      register('kaniburner.moveProjectFileDown', (node: Item) => {
        if (node?.key !== undefined && node.index !== undefined) moveProjectEntry(context, node.key, node.index, 1);
      });
      register('kaniburner.write', () => { if (canAction(context, 'Write')) return runAction(context, () => compileAndWrite(context), 'write'); });
      register('kaniburner.execute', () => { if (canAction(context, 'Execute')) return runAction(context, () => execute(context), 'execute'); });
      register('kaniburner.restart', () => restartAndReconnect(context));
      register('kaniburner.connect', () => connectDevice(context));
      register('kaniburner.cancel', () => cancelConnection(context));
      register('kaniburner.disconnect', async () => {
        if (!canAction(context, 'Disconnect')) return;
        logInfo(context, 'Disconnecting...');
        try { await disconnect(context); } catch (error) { logError(context, `Disconnect failed: ${(error as Error).message}`); }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const disposable of subscriptions.splice(0)) disposable.dispose();
      host.projectProvider.dispose();
      host.deviceProvider.dispose();
    }
  };
  extensionContext.subscriptions.push({ dispose: () => host.dispose() });
  return host;
}

function buildExtensionContext(extensionContext: vscode.ExtensionContext): Context {
  return buildContext({ host: createVscodeHost(require('vscode'), extensionContext),
    serial: createSerialTransport(require('serialport').SerialPort), extensionPath: extensionContext.extensionPath });
}

let extension: Context | undefined;
export function activate(extensionContext: vscode.ExtensionContext) {
  extension = buildExtensionContext(extensionContext);
  extension.host.attach(extension);
  startAutoConnect(extension);
  refreshAll(extension);
}
export async function deactivate() { if (extension) await disposeContext(extension); extension = undefined; }
