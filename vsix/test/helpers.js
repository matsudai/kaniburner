/**
 * テスト用の偽の依存。
 * vscodeは未定義メンバーの参照で失敗させ、テストが想定していないAPI利用を検知する。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildContext } = require('../out/main.js');

function strict(name, object) {
  return new Proxy(object, {
    get(target, key) {
      if (key in target || typeof key === 'symbol' || key === 'then') return target[key];
      throw new Error(`unexpected ${name}.${String(key)}`);
    }
  });
}

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; }
  static file(fsPath) { return new Uri(fsPath); }
}

class TreeItem {
  constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; }
}

class ThemeIcon {
  constructor(id, color) { this.id = id; this.color = color; }
}

class ThemeColor {
  constructor(id) { this.id = id; }
}

class EventEmitter {
  constructor() { this.fired = 0; this.event = () => {}; }
  fire() { this.fired++; }
}

/** デバイスの応答。書き込まれたテキストに対する返信を返す。 */
function mrbwriteDevice(text) {
  if (text === '\r\n') return '+OK mruby/c\r\n';
  if (text.startsWith('clear')) return '+OK\r\n';
  if (text.startsWith('write')) return '+OK Write bytecode\r\n';
  if (text.startsWith('execute')) return '+OK Execute\r\n';
  if (text.startsWith('reset')) return '';
  return '+DONE\r\n';
}

/**
 * serialportのSerialPortの偽物を作る。
 *
 * @param ports list()が返すポート一覧。
 * @param openError 接続時に返すエラー。
 * @param device 書き込みに対して同期的に返信する関数。
 */
function createSerialPort({ ports = [], openError = null, device = mrbwriteDevice } = {}) {
  return class SerialPort {
    static instances = [];
    static list() { return Promise.resolve(ports); }

    constructor({ path: portPath, baudRate }, callback) {
      this.path = portPath;
      this.baudRate = baudRate;
      this.listeners = {};
      this.written = [];
      this.sets = [];
      this.closed = false;
      SerialPort.instances.push(this);
      queueMicrotask(() => callback(openError));
    }

    on(event, listener) { this.listeners[event] = listener; }

    write(buffer, callback) {
      this.written.push(buffer.toString('latin1'));
      callback(null);
      const reply = device(buffer.toString('latin1'));
      if (reply) this.receive(reply);
    }

    set(options, callback) { this.sets.push(options); callback(); }

    close(callback) {
      this.closed = true;
      callback();
      this.listeners.close?.();
    }

    receive(text) { this.listeners.data(Buffer.from(text)); }
  };
}

/**
 * Contextを組み立てる。
 *
 * @param window vscode.windowに生やすメンバー。
 * @param root ワークスペースルート。
 */
function createContext({ window = {}, root = null, device = {}, SerialPort = createSerialPort(), extensionPath = '/ext' } = {}) {
  const output = {
    lines: [],
    text: '',
    shown: 0,
    append(text) { this.text += text; },
    appendLine(line) { this.lines.push(line); },
    show() { this.shown++; }
  };
  const storage = {
    data: { 'kaniburner.device': device },
    get(key) { return this.data[key]; },
    update(key, value) { this.data[key] = value; return Promise.resolve(); }
  };
  const commands = {
    calls: [],
    executeCommand(...args) { this.calls.push(args); }
  };
  const vscode = strict('vscode', {
    Uri, TreeItem, ThemeIcon, ThemeColor, EventEmitter,
    TreeItemCollapsibleState: { Expanded: 1 },
    commands,
    window: strict('vscode.window', window),
    workspace: strict('vscode.workspace', { workspaceFolders: root ? [{ uri: new Uri(root) }] : undefined })
  });
  return buildContext({ vscode, SerialPort, storage, extensionPath, output });
}

/** setContextで設定された値をまとめる。 */
function contextValues(context) {
  const values = {};
  for (const [command, key, value] of context.vscode.commands.calls) {
    if (command === 'setContext') values[key] = value;
  }
  return values;
}

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kaniburner-'));
}

function readProjectConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.vscode/kaniburner.json'), 'utf8'));
}

function writeProjectConfig(root, config) {
  fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vscode/kaniburner.json'), JSON.stringify(config));
}

/** 保留中のマイクロタスクとI/Oコールバックを流す。 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 偽のタイマーを進める。前後でPromiseの解決を進める。 */
async function advance(t, milliseconds) {
  await flush();
  t.mock.timers.tick(milliseconds);
  await flush();
}

module.exports = {
  strict, Uri, TreeItem, EventEmitter, mrbwriteDevice, createSerialPort, createContext, contextValues,
  makeWorkspace, readProjectConfig, writeProjectConfig, flush, advance
};
