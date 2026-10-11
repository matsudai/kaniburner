const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const main = require('../out/main.js');

const encode = (text) => new TextEncoder().encode(text);

/**
 * テスト用の偽の依存。
 * vscodeは未定義メンバーの参照で失敗させ、テストが想定していないAPI利用を検知する。
 */
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
  if (text === 'version\r\n') return '+OK mruby/c v3.3 RITE0300 MRBW1.2\r\n';
  if (text.startsWith('clear')) return '+OK\r\n';
  if (text.startsWith('write')) return '+OK Write bytecode\r\n';
  if (text.startsWith('execute')) return '+OK Execute\r\n';
  if (text.startsWith('reset')) return '+OK\r\n';
  return '+DONE\r\n';
}

/**
 * serialportのSerialPortの偽物を作る。
 *
 * @param ports list()が返すポート一覧。
 * @param openError 接続時に返すエラー。
 * @param setError 制御信号の設定時に返すエラー。
 * @param device 書き込みに対して同期的に返信する関数。
 */
function createSerialPort({ ports = [{ path: '/dev/x' }], openError = null, setError = null, device = mrbwriteDevice } = {}) {
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
      if (buffer.length === 0) return callback(null);
      this.written.push(buffer.toString('latin1'));
      callback(null);
      const reply = device(buffer.toString('latin1'));
      if (reply) this.receive(reply);
    }

    set(options, callback) { this.sets.push(options); callback(setError); }

    drain(callback) { callback(null); }

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
  const statusBar = { text: '', tooltip: undefined, shown: 0, show() { this.shown++; }, dispose() {} };
  const vscode = strict('vscode', {
    Uri, TreeItem, ThemeIcon, ThemeColor, EventEmitter,
    StatusBarAlignment: { Left: 1, Right: 2 },
    TreeItemCollapsibleState: { Expanded: 1 },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    commands,
    window: strict('vscode.window', { activeTextEditor: undefined, visibleTextEditors: [], ...window }),
    workspace: strict('vscode.workspace', { workspaceFolders: root ? [{ uri: new Uri(root) }] : undefined })
  });
  return main.buildContext({ vscode, SerialPort, storage, extensionPath, output, statusBar });
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

describe('#mrbwriteCrc16', () => {
  it('空データでは0xffffになること', () => {
    assert.equal(main.mrbwriteCrc16(new Uint8Array([])), 0xffff);
  });

  it('1,2,3ではa408になること', () => {
    assert.equal(main.mrbwriteCrc16(new Uint8Array([1, 2, 3])).toString(16), 'a408');
  });
});

describe('#feed', () => {
  let context;
  beforeEach(() => { context = createContext(); });

  it('受信テキストをoutputへ書くこと', () => {
    main.feed(context, encode('abc'));
    assert.equal(context.output.text, 'abc');
  });

  it('CRLFで完結した行で応答を解決し、末尾の未完行をpendingに残すこと', async () => {
    const response = main.waitForResponse(context);
    main.feed(context, encode('+OK first\r\n+OK sec'));
    assert.equal(await response, '+OK first');
    assert.equal(context.get().pending, '+OK sec');
  });

  it('分割して届いた行をつなげること', async () => {
    main.feed(context, encode('+O'));
    const response = main.waitForResponse(context);
    main.feed(context, encode('K done\r\n'));
    assert.equal(await response, '+OK done');
    assert.equal(context.get().pending, '');
  });

  it('検証中は未完の行でもコマンドモードを検出すること', async () => {
    await main.connect(context, '/dev/x', 9600);
    context.setProbe({ port: context.get().serialPort, operation: null });
    main.feed(context, encode('+OK mruby/c'));
    assert.equal(context.get().commandMode, true);
  });
});

describe('#handleLine', () => {
  let context;
  beforeEach(() => { context = createContext(); });

  for (const prefix of ['+OK', '-ERR', '+DONE']) {
    it(`${prefix}で始まる完結行で待機中の応答を解決すること`, async () => {
      const response = main.waitForResponse(context);
      main.handleLine(context, `${prefix} x`, false);
      assert.equal(await response, `${prefix} x`);
      assert.equal(context.get().responseResolve, null);
    });
  }

  it('部分行では応答を解決しないこと', () => {
    main.waitForResponse(context);
    main.handleLine(context, '+OK x', true);
    assert.notEqual(context.get().responseResolve, null);
  });

  it('応答以外の行では解決しないこと', () => {
    main.waitForResponse(context);
    main.handleLine(context, 'hello', false);
    assert.notEqual(context.get().responseResolve, null);
  });
});

describe('#checkCommandModePatterns', () => {
  let context;
  beforeEach(() => { context = createContext(); });

  it('検証中の+OK mruby/cでコマンドモードに入りビューを更新すること', async () => {
    await main.connect(context, '/dev/x', 9600);
    context.setProbe({ port: context.get().serialPort, operation: null });
    main.checkCommandModePatterns(context, '+OK mruby/c');
    assert.equal(context.get().commandMode, true);
    assert.ok(context.output.lines.includes('[info]  Command mode entered.'));
    assert.ok(context.vscode.commands.calls.length > 0);
  });

  it('受信パターンだけでExecuteの成否を変更しないこと', () => {
    context.enterCommandMode();
    context.beginExecute();
    main.checkCommandModePatterns(context, '+OK Execute');
    assert.equal(context.get().commandMode, true);
    assert.equal(context.get().lastCommand, 'execute');
  });

  it('execute以外の+OKではコマンドモードを維持すること', () => {
    context.enterCommandMode();
    main.checkCommandModePatterns(context, '+OK');
    assert.equal(context.get().commandMode, true);
  });

  it('コマンドモード中の+OK mruby/cでは抜けないこと', () => {
    context.enterCommandMode();
    context.beginExecute();
    main.checkCommandModePatterns(context, '+OK mruby/c');
    assert.equal(context.get().commandMode, true);
  });
});

describe('#resetProtocol', () => {
  it('状態を初期化し、待機中の応答をnullで解決すること', async () => {
    const context = createContext();
    context.setPending('x');
    context.enterCommandMode();
    context.beginExecute();
    const response = main.waitForResponse(context);
    main.resetProtocol(context);
    assert.equal(await response, null);
    const { pending, commandMode, lastCommand, responseResolve } = context.get();
    assert.deepEqual([pending, commandMode, lastCommand, responseResolve], ['', false, null, null]);
  });
});

describe('#waitForResponse', () => {
  it('タイムアウトするとnullを返すこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext();
    const response = main.waitForResponse(context, 5000);
    await advance(t, 5000);
    assert.equal(await response, null);
    assert.equal(context.get().responseResolve, null);
  });

  it('解決後はタイマーを止めること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext();
    const response = main.waitForResponse(context, 5000);
    main.handleLine(context, '+OK', false);
    await advance(t, 5000);
    assert.equal(await response, '+OK');
  });
});

describe('#sendCommand', () => {
  let context;
  beforeEach(async () => {
    context = createContext();
    await main.connect(context, '/dev/fake', 9600);
  });

  it('CRLFを付けて送り、応答を返すこと', async () => {
    assert.equal(await main.sendCommand(context, 'clear'), '+OK');
    assert.deepEqual(context.get().serialPort.written, ['clear\r\n']);
    assert.ok(context.output.lines.includes('[info]  > clear'));
  });

  it('ignoreResponseでは応答を待たずnullを返すこと', async () => {
    assert.equal(await main.sendCommand(context, 'execute', { ignoreResponse: true }), null);
    assert.equal(context.get().responseResolve, null);
  });
});

describe('#ensureCommandMode', () => {
  it('既にコマンドモードなら何も送らずtrueを返すこと', async () => {
    const context = createContext();
    context.enterCommandMode();
    assert.equal(await main.ensureCommandMode(context), true);
    assert.equal(context.output.lines.length, 0);
  });

  it('CRLFを送ってコマンドモードに入ること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    const result = main.ensureCommandMode(context, 3);
    await advance(t, 1000);
    assert.equal(await result, true);
    assert.deepEqual(context.get().serialPort.written, ['\r\n']);
    assert.ok(context.output.lines.includes('[info]  Entering command mode... (1/3)'));
  });

  it('再試行を使い切るとfalseを返すこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ SerialPort: createSerialPort({ device: () => '' }) });
    await main.connect(context, '/dev/fake', 9600);
    const result = main.ensureCommandMode(context, 2);
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await result, false);
    assert.deepEqual(context.get().serialPort.written, ['\r\n', '\r\n']);
    assert.deepEqual(context.output.lines.slice(0, 2), [
      '[info]  Entering command mode... (1/2)',
      '[info]  Entering command mode... (2/2)'
    ]);
    assert.ok(context.output.lines.includes('[error] Command mode transition timed out (2s).'));
  });

  it('未接続では確立を試行しないこと', async () => {
    const context = createContext();
    assert.equal(await main.ensureCommandMode(context, 3), false);
    assert.equal(context.output.lines.length, 0);
  });

  it('接続試行以外では送信タイムアウトを記録すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    context.get().serialPort.write = () => {};
    const result = main.ensureCommandMode(context, 1);
    await advance(t, 5000);
    assert.equal(await result, false);
    assert.ok(context.output.lines.includes('[error] Send error: Serial write timed out.'));
  });

  it('Connect・Restart中もタイムアウト以外の送信エラーは記録すること', async () => {
    for (const action of ['connect', 'restart']) {
      const context = createContext();
      await main.connect(context, '/dev/fake', 9600);
      context.get().serialPort.write = (_, callback) => callback(new Error('busy'));
      assert.equal(await main.runAction(context, () => main.ensureCommandMode(context, 1), action), false);
      assert.ok(context.output.lines.includes('[error] Send error: busy'));
    }
  });
});

describe('#parseBoardInfo', () => {
  it('VMのバージョンとRITE形式を読み取ること', () => {
    assert.deepEqual(main.parseBoardInfo('+OK mruby/c v3.3 RITE0300 MRBW1.2'), {
      mrubyc: 'v3.3', rite: 'RITE0300', error: null
    });
  });

  it('通信プロトコルのバージョンに依存しないこと', () => {
    for (const suffix of ['', ' MRBW1.2', ' MRBW1.3']) {
      assert.deepEqual(main.parseBoardInfo(`+OK mruby/c v4.0 RITE0400${suffix}`), {
        mrubyc: 'v4.0', rite: 'RITE0400', error: null
      });
    }
  });

  it('RITE形式が無くてもVMのバージョンを読み取ること', () => {
    assert.deepEqual(main.parseBoardInfo('+OK mruby/c v3.3'), { mrubyc: 'v3.3', rite: null, error: null });
  });

  it('起動メッセージからバージョンを補完しないこと', () => {
    assert.deepEqual(main.parseBoardInfo('+OK mruby/c'), { mrubyc: null, rite: null, error: null });
  });

  it('不明な応答では原因を返すこと', () => {
    for (const response of [null, '-ERR Illegal command.', '+DONE']) {
      const info = main.parseBoardInfo(response);
      assert.equal(info.mrubyc, null);
      assert.equal(info.rite, null);
      assert.ok(info.error);
    }
  });
});

describe('#readBoardInfo', () => {
  it('自動判定がOFFでも取得し、同じ接続では再利用すること', async () => {
    const context = createContext({ device: { autoDetect: false } });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    await main.readBoardInfo(context);
    await main.readBoardInfo(context);
    assert.deepEqual(context.get().boardInfo, { mrubyc: 'v3.3', rite: 'RITE0300', error: null });
    assert.deepEqual(context.get().serialPort.written, ['version\r\n']);
    assert.equal(main.resolveCompilerVersion(context).version, '4.0.0');
  });

  it('取得中の要求を共有し、分割された応答を待つこと', async () => {
    const context = createContext({ SerialPort: createSerialPort({ device: () => '' }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    context.setPending('+OK mruby/c');
    const first = main.readBoardInfo(context);
    const second = main.readBoardInfo(context);
    await flush();
    const port = context.get().serialPort;
    assert.deepEqual(port.written, ['version\r\n']);
    port.receive('+OK mruby/c v3.3 RITE');
    assert.equal(context.get().boardInfo, null);
    port.receive('0300 MRBW1.2\r\n');
    await Promise.all([first, second]);
    assert.equal(context.get().boardInfo.rite, 'RITE0300');
    assert.equal(context.get().boardInfoRequest, null);
  });

  it('応答が無くてもコマンドモードの準備は成功すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ SerialPort: createSerialPort({ device: () => '' }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const result = main.prepareDevice(context);
    await advance(t, 5000);
    assert.equal(await result, true);
    assert.match(context.get().boardInfo.error, /応答がありません/);
    assert.equal(context.get().responseResolve, null);
  });

  it('送信失敗の原因を保持し、応答待ちを終了すること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    context.get().serialPort.write = (_, callback) => callback(new Error('busy'));
    await main.readBoardInfo(context);
    assert.match(context.get().boardInfo.error, /busy/);
    assert.equal(context.get().responseResolve, null);
    assert.equal(context.get().boardInfoRequest, null);
  });

  it('切断で取得結果を破棄し、次の接続では取り直すこと', async () => {
    let response = '+OK mruby/c v3.3 RITE0300 MRBW1.2\r\n';
    const context = createContext({ SerialPort: createSerialPort({ device: () => response }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    await main.readBoardInfo(context);
    await main.disconnect(context);
    assert.equal(context.get().boardInfo, null);
    response = '+OK mruby/c v4.0 RITE0400 MRBW1.2\r\n';
    await main.connect(context, '/dev/y', 9600);
    context.enterCommandMode();
    await main.readBoardInfo(context);
    assert.equal(context.get().boardInfo.mrubyc, 'v4.0');
    assert.deepEqual(context.get().serialPort.written, ['version\r\n']);
  });

  it('取得中にリセットされた応答を新しい状態へ反映しないこと', async () => {
    const context = createContext({ SerialPort: createSerialPort({ device: () => '' }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const result = main.readBoardInfo(context);
    await flush();
    main.resetProtocol(context);
    const info = { mrubyc: 'v4.0', rite: 'RITE0400', error: null };
    context.setBoardInfo(info);
    await result;
    assert.deepEqual(context.get().boardInfo, info);
  });

  it('送信前に切断された要求では通信しないこと', async () => {
    const context = createContext();
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const port = context.get().serialPort;
    const result = main.readBoardInfo(context);
    await main.disconnect(context);
    await result;
    assert.deepEqual(port.written, []);
    assert.equal(context.get().boardInfo, null);
  });

  it('実行モードではversionを送らないこと', async () => {
    const context = createContext();
    await main.connect(context, '/dev/x', 9600);
    await main.readBoardInfo(context);
    assert.deepEqual(context.get().serialPort.written, []);
  });
});

describe('#writeBytecodes', () => {
  let context;
  beforeEach(async () => {
    context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    context.enterCommandMode();
  });

  it('tasksが空ならfalseを返すこと', async () => {
    assert.equal(await main.writeBytecodes(context, { libraries: [], tasks: [] }), false);
  });

  it('clear、writeコマンド、バイナリの順に送ること', async () => {
    const result = await main.writeBytecodes(context, { libraries: [], tasks: [new Uint8Array([1, 2, 3])] });
    assert.equal(result, true);
    assert.deepEqual(context.get().serialPort.written, ['clear\r\n', 'write 3 a408\r\n', '\x01\x02\x03']);
    assert.ok(context.output.lines.includes('[info]  Write completed.'));
  });

  it('librariesをwrite_libでtasksより先に送ること', async () => {
    await main.writeBytecodes(context, { libraries: [new Uint8Array([9])], tasks: [new Uint8Array([1])] });
    const commands = context.get().serialPort.written.filter((text) => text.startsWith('write'));
    assert.deepEqual(commands.map((text) => text.split(' ')[0]), ['write_lib', 'write']);
    assert.deepEqual(commands, ['write_lib 1 623e\r\n', 'write 1 ee76\r\n']);
  });

  it('自動検証がONならwriteとwrite_libの第2引数にCRC16を付けること', async () => {
    main.updateDevice(context, { autoVerify: true });
    const bytecode = new Uint8Array([1, 2, 3]);
    await main.writeBytecodes(context, { libraries: [bytecode], tasks: [bytecode] });
    const commands = context.get().serialPort.written.filter((text) => text.startsWith('write'));
    assert.deepEqual(commands, ['write_lib 3 a408\r\n', 'write 3 a408\r\n']);
    main.updateDevice(context, { autoVerify: false });
    await main.writeBytecodes(context, { libraries: [], tasks: [bytecode] });
    assert.equal(context.get().serialPort.written.at(-2), 'write 3\r\n');
  });

  it('clearが失敗するとfalseを返すこと', async () => {
    context = createContext({ SerialPort: createSerialPort({ device: () => '-ERR\r\n' }) });
    await main.connect(context, '/dev/fake', 9600);
    context.enterCommandMode();
    assert.equal(await main.writeBytecodes(context, { libraries: [], tasks: [new Uint8Array([1])] }), false);
    assert.ok(context.output.lines.includes('[error] clear failed: -ERR'));
  });

  it('バイナリ送信後に-ERRが返るとfalseを返すこと', async () => {
    const device = (text) => (text.startsWith('clear') ? '+OK\r\n' : text.startsWith('write') ? '+OK Write bytecode\r\n' : '-ERR crc\r\n');
    context = createContext({ SerialPort: createSerialPort({ device }) });
    await main.connect(context, '/dev/fake', 9600);
    context.enterCommandMode();
    assert.equal(await main.writeBytecodes(context, { libraries: [], tasks: [new Uint8Array([1])] }), false);
    assert.ok(context.output.lines.includes('[error] Write failed: -ERR crc'));
  });

  it('+DONEが返らないとfalseを返すこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const device = (text) => (text.startsWith('clear') ? '+OK\r\n' : text.startsWith('write') ? '+OK Write bytecode\r\n' : '');
    context = createContext({ SerialPort: createSerialPort({ device }) });
    await main.connect(context, '/dev/fake', 9600);
    context.enterCommandMode();
    const result = main.writeBytecodes(context, { libraries: [], tasks: [new Uint8Array([1])] });
    await flush();
    await advance(t, 10000);
    assert.equal(await result, false);
    assert.ok(context.output.lines.includes('[error] Write failed: null'));
  });
});

describe('#execute', () => {
  it('lastCommandをexecuteにしてexecuteを送ること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    context.enterCommandMode();
    await main.runAction(context, () => main.execute(context), 'execute');
    assert.deepEqual(context.get().serialPort.written, ['execute\r\n']);
    assert.equal(context.get().commandMode, false);
    assert.equal(context.get().runMode, true);
    assert.equal(context.get().operation, null);
    assert.equal(context.statusBar.text, '$(play) kaniburner');
    assert.equal(context.statusBar.tooltip, 'kaniburner: Run\n/dev/fake (9600 baud)');
    assert.deepEqual(context.statusBar.accessibilityInformation, { label: 'kaniburner: Run' });
  });

  it('Execute拒否ではCommand表示を維持すること', async () => {
    const context = createContext({ SerialPort: createSerialPort({ device: () => '-ERR Illegal command.\r\n' }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    await main.execute(context);
    assert.equal(context.get().runMode, false);
    assert.equal(context.statusBar.text, '$(terminal) kaniburner');
  });

  it('ExecuteタイムアウトではRunを表示しないこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ SerialPort: createSerialPort({ device: () => '' }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const result = main.execute(context);
    assert.equal(context.statusBar.text, '$(terminal) kaniburner');
    await advance(t, 5000);
    await result;
    assert.equal(context.get().runMode, false);
    assert.equal(context.statusBar.text, '$(plug) kaniburner');
  });

  it('Execute応答より先に実行開始通知を受けてもRunを保持すること', async () => {
    const context = createContext({ SerialPort: createSerialPort({ device: () => 'Kani-Board, mruby/c v3.3 start\r\n' }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    await main.execute(context);
    assert.equal(context.get().runMode, true);
    assert.equal(context.statusBar.text, '$(play) kaniburner');
    assert.ok(!context.output.lines.includes('[error] Execute response timed out.'));
  });

  it('Execute応答直後の再起動通知をRunで上書きしないこと', async () => {
    const context = createContext({ SerialPort: createSerialPort({ device: () => '+OK Execute\r\nKani-Board, Please push Enter key to mrbwrite mode\r\n' }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    await main.execute(context);
    assert.equal(context.get().runMode, false);
    assert.equal(context.statusBar.text, '$(plug) kaniburner');
  });

  it('Execute成功後に分割受信した実行開始通知でRunになること', async () => {
    const context = createContext({ SerialPort: createSerialPort({ device: () => '+OK \r\n' }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    await main.runAction(context, () => main.execute(context), 'execute');
    const port = context.get().serialPort;
    port.receive('\r\nKani-Board, End mrbwrite mode\r\nKani-Board, mruby/c v4.0.0 st');
    port.receive('art\r\n');
    assert.equal(context.get().runMode, true);
    assert.equal(context.statusBar.text, '$(play) kaniburner');
    assert.equal(context.statusBar.tooltip, 'kaniburner: Run\n/dev/x (9600 baud)');
  });

  it('Execute応答と通知の任意の受信境界でもRunになること', async () => {
    const reply = '+OK \r\n\r\nKani-Board, End mrbwrite mode\r\nKani-Board, mruby/c v4.0.0 start\r\n';
    for (let split = 0; split <= reply.length; split++) {
      const context = createContext({ SerialPort: createSerialPort({ device: () => '' }) });
      await main.connect(context, '/dev/x', 9600);
      context.enterCommandMode();
      const result = main.runAction(context, () => main.execute(context), 'execute');
      const port = context.get().serialPort;
      port.receive(reply.slice(0, split));
      await flush();
      port.receive(reply.slice(split));
      await result;
      assert.equal(context.get().runMode, true, `split=${split}`);
      assert.equal(context.statusBar.text, '$(play) kaniburner', `split=${split}`);
    }
  });
});

describe('#connect', () => {
  it('ポートを開いてserialPortに保持すること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    assert.equal(context.get().serialPort.path, '/dev/fake');
    assert.equal(context.get().serialPort.baudRate, 9600);
    assert.deepEqual(context.get().serialPort.sets, [{ brk: false, dtr: true, rts: true }]);
    assert.equal(main.connected(context), true);
  });

  it('受信データをプロトコルへ渡すこと', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    context.get().serialPort.receive('+OK mruby/c');
    assert.equal(context.get().commandMode, false);
    assert.equal(context.output.text, '+OK mruby/c');
  });

  it('開けなかった場合はrejectし、未接続のままにすること', async () => {
    const context = createContext({ SerialPort: createSerialPort({ openError: new Error('busy') }) });
    await assert.rejects(main.connect(context, '/dev/fake', 9600), { message: 'busy' });
    assert.equal(main.connected(context), false);
  });

  it('制御信号を設定できなかった場合はポートを閉じてrejectすること', async () => {
    const SerialPort = createSerialPort({ setError: new Error('set failed') });
    const context = createContext({ SerialPort });
    await assert.rejects(main.connect(context, '/dev/fake', 9600), { message: 'set failed' });
    assert.equal(SerialPort.instances[0].closed, true);
    assert.equal(main.connected(context), false);
  });
});

describe('#onClose', () => {
  it('接続中なら切断状態にしてプロトコルを初期化すること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    context.enterCommandMode();
    main.onClose(context);
    assert.equal(main.connected(context), false);
    assert.equal(context.get().commandMode, false);
    assert.ok(context.output.lines.includes('[info]  Disconnected.'));
  });

  it('未接続なら何もしないこと', () => {
    const context = createContext();
    main.onClose(context);
    assert.equal(context.output.lines.length, 0);
  });
});

describe('#disconnect', () => {
  it('ポートを閉じてプロトコルを初期化すること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    const port = context.get().serialPort;
    context.enterCommandMode();
    await main.disconnect(context);
    assert.equal(port.closed, true);
    assert.equal(main.connected(context), false);
    assert.equal(context.get().commandMode, false);
  });

  it('自分で閉じた場合はDisconnectedを記録しないこと', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    await main.disconnect(context);
    assert.ok(!context.output.lines.includes('[info]  Disconnected.'));
  });

  it('未接続なら何もしないこと', async () => {
    const context = createContext();
    await main.disconnect(context);
    assert.equal(main.connected(context), false);
  });

  it('送信とdrainが完了するまでポートを閉じないこと', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    const port = context.get().serialPort;
    let write, drain;
    port.write = (_, callback) => { write = callback; };
    port.drain = (callback) => { drain = callback; };
    const result = main.disconnect(context);
    assert.equal(port.closed, false);
    assert.equal(main.canAction(context, 'Disconnect'), false);
    assert.equal(drain, undefined);
    write();
    await flush();
    assert.equal(port.closed, false);
    drain();
    await result;
    assert.equal(port.closed, true);
    assert.equal(main.connected(context), false);
  });

  it('送信とdrainの共通の0.5秒期限で切断し、中断通知をエラーにしないこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    const port = context.get().serialPort;
    let write, drain;
    port.write = (_, callback) => { write = callback; };
    port.drain = (callback) => { drain = callback; };
    const close = port.close.bind(port);
    port.close = (callback) => {
      port.listeners.error(new Error('Writing to COM port (GetOverlappedResult): Operation aborted'));
      close(callback);
    };
    const result = main.disconnect(context);
    await advance(t, 400);
    write();
    await advance(t, 99);
    assert.equal(port.closed, false);
    await advance(t, 1);
    await result;
    drain();
    assert.equal(port.closed, true);
    assert.equal(main.connected(context), false);
    assert.equal(context.output.lines.some((line) => line.startsWith('[error]')), false);
  });

  it('送信待ちの期限超過後の遅い完了でdrainを始めないこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    const port = context.get().serialPort;
    let write;
    port.write = (_, callback) => { write = callback; };
    const drain = t.mock.method(port, 'drain');
    const result = main.disconnect(context);
    await advance(t, 500);
    await result;
    write();
    assert.equal(port.closed, true);
    assert.equal(drain.mock.callCount(), 0);
  });

  it('Disconnect以外のシリアルエラーは記録し、closeの失敗はrejectすること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    const port = context.get().serialPort;
    port.isOpen = true;
    port.listeners.error(new Error('read failed'));
    assert.ok(context.output.lines.includes('[error] Serial error: read failed'));
    port.close = (callback) => callback(new Error('close failed'));
    await assert.rejects(main.disconnect(context), /close failed/);
    assert.equal(context.get().serialPort, port);
    assert.equal(main.canAction(context, 'Disconnect'), true);
  });

  it('closeの期限超過はrejectすること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    context.get().serialPort.close = () => {};
    const result = assert.rejects(main.disconnect(context), /Serial port close timed out/);
    await advance(t, 5000);
    await result;
    assert.equal(context.get().operation, null);
    assert.equal(context.get().running, 0);
  });
});

describe('#write', () => {
  it('未接続ならrejectすること', async () => {
    const context = createContext();
    await assert.rejects(main.write(context, new Uint8Array([1])), { message: 'Not connected' });
  });

  it('バイト列をポートへ書くこと', async () => {
    const context = createContext({ SerialPort: createSerialPort({ device: () => '' }) });
    await main.connect(context, '/dev/fake', 9600);
    await main.write(context, new Uint8Array([0x41, 0x42]));
    assert.deepEqual(context.get().serialPort.written, ['AB']);
  });

  it('通常の送信は0.5秒を超えても5秒までは完了を待つこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    let write, status = null;
    context.get().serialPort.write = (_, callback) => { write = callback; };
    const result = main.write(context, new Uint8Array([1])).then(
      () => { status = 'written'; },
      (error) => { status = error; }
    );
    await advance(t, 4999);
    assert.equal(status, null);
    write();
    await result;
    assert.equal(status, 'written');
  });
});

describe('#sendBreak', () => {
  it('BREAKをオンにしてからオフにすること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    await main.sendBreak(context);
    assert.deepEqual(context.get().serialPort.sets, [
      { brk: false, dtr: true, rts: true },
      { brk: true, dtr: true, rts: true },
      { brk: false, dtr: true, rts: true }
    ]);
  });

  it('未接続なら何もしないこと', async () => {
    const context = createContext();
    await main.sendBreak(context);
  });
});

/**
 * 偽のmrbc.jsを置く。
 *
 * ソースをそのままバイト列にして出力する。"fail"でexit 1、"throw"で例外。
 */
function installMrbc(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'mrbc.js'), `
    module.exports = async (options) => {
      const files = {};
      return {
        loads: (module.exports.loads = (module.exports.loads ?? 0) + 1),
        FS: {
          writeFile: (name, data) => { files[name] = data; },
          unlink: (name) => { if (!(name in files)) throw new Error('ENOENT'); delete files[name]; },
          readFile: (name) => Buffer.from(files[name])
        },
        callMain: (args) => {
          const source = files[args[2]];
          if (source === 'throw') throw new Error('boom');
          if (source === 'fail') return 1;
          options.print('compiled');
          files[args[1]] = source;
          return 0;
        }
      };
    };
  `);
}

describe('#loadMrbc', () => {
  let root, context;
  beforeEach(() => { root = makeWorkspace(); context = createContext(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('ディレクトリのmrbc.jsを読み込むこと', async () => {
    installMrbc(path.join(root, 'a'));
    const module = await main.loadMrbc(context, path.join(root, 'a'));
    assert.equal(typeof module.callMain, 'function');
    assert.equal(context.get().mrbcDirectory, path.join(root, 'a'));
  });

  it('同じディレクトリなら読み直さないこと', async () => {
    installMrbc(path.join(root, 'a'));
    const first = await main.loadMrbc(context, path.join(root, 'a'));
    const second = await main.loadMrbc(context, path.join(root, 'a'));
    assert.equal(first, second);
  });

  it('別のディレクトリなら読み直すこと', async () => {
    installMrbc(path.join(root, 'a'));
    installMrbc(path.join(root, 'b'));
    const first = await main.loadMrbc(context, path.join(root, 'a'));
    const second = await main.loadMrbc(context, path.join(root, 'b'));
    assert.notEqual(first, second);
    assert.equal(context.get().mrbcDirectory, path.join(root, 'b'));
  });
});

describe('#compile', () => {
  let root, context;
  beforeEach(() => { root = makeWorkspace(); installMrbc(root); context = createContext(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('バイトコードを返すこと', async () => {
    const bytecode = await main.compile(context, root, 'puts 1');
    assert.deepEqual(bytecode, new Uint8Array(Buffer.from('puts 1')));
    assert.equal(context.output.text, 'compiled');
  });

  it('空のソースではnullを返すこと', async () => {
    assert.equal(await main.compile(context, root, '  \n'), null);
    assert.ok(context.output.lines.includes('[error] Source code is empty.'));
  });

  it('exit codeが0以外ならnullを返すこと', async () => {
    assert.equal(await main.compile(context, root, 'fail'), null);
    assert.ok(context.output.lines.includes('[error] Compile failed (exit code 1).'));
  });

  it('例外が起きたらnullを返すこと', async () => {
    assert.equal(await main.compile(context, root, 'throw'), null);
    assert.ok(context.output.lines.includes('[error] Compile error: boom'));
  });
});

describe('#compileSources', () => {
  let root, context;
  beforeEach(() => { root = makeWorkspace(); installMrbc(root); context = createContext(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('すべてのソースをコンパイルして順に返すこと', async () => {
    const bytecodes = await main.compileSources(context, root, [
      { filename: 'a.rb', source: 'a' },
      { filename: 'b.rb', source: 'b' }
    ]);
    assert.deepEqual(bytecodes.map((bytecode) => Buffer.from(bytecode).toString()), ['a', 'b']);
  });

  it('失敗したファイル名を記録してnullを返すこと', async () => {
    const bytecodes = await main.compileSources(context, root, [
      { filename: 'a.rb', source: 'a' },
      { filename: 'b.rb', source: 'fail' }
    ]);
    assert.equal(bytecodes, null);
    assert.ok(context.output.lines.includes('[error] Compile failed: b.rb'));
  });
});

describe('#getSettings', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('欠落キーを既定値で補うこと', () => {
    const context = createContext({ root });
    assert.deepEqual(main.getSettings(context), {
      version: '4.0.0', autoDetect: true, port: null, baud: 115200, autoConnect: false, autoVerify: true, libraries: [], tasks: []
    });
  });

  it('保存された設定を返すこと', () => {
    writeProjectConfig(root, { compiler: { version: '3.4.0' }, libraries: [{ filename: 'lib.rb' }], tasks: [{ filename: 'main.rb' }] });
    const context = createContext({ root, device: { port: '/dev/x', baud: 9600, autoDetect: false, autoVerify: false } });
    assert.deepEqual(main.getSettings(context), {
      version: '3.4.0', autoDetect: false, port: '/dev/x', baud: 9600, autoConnect: false, autoVerify: false, libraries: [{ filename: 'lib.rb' }], tasks: [{ filename: 'main.rb' }]
    });
  });

  it('プロジェクト設定が壊れていれば空として扱い記録すること', () => {
    fs.mkdirSync(path.join(root, '.vscode'));
    fs.writeFileSync(path.join(root, '.vscode/kaniburner.json'), '{');
    const context = createContext({ root });
    assert.equal(main.getSettings(context).version, '4.0.0');
    assert.match(context.output.lines[0], /^\[error\] Failed to read \.vscode\/kaniburner\.json: /);
  });

  it('ワークスペースを開いていなければプロジェクト設定は空になること', () => {
    const context = createContext();
    assert.deepEqual(main.getSettings(context).tasks, []);
  });
});

describe('#updateCompiler', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('compiler.versionを書き込みビューを更新すること', () => {
    const context = createContext({ root });
    main.updateCompiler(context, { version: '3.4.0' });
    assert.deepEqual(readProjectConfig(root), { compiler: { version: '3.4.0' } });
    assert.ok(context.vscode.commands.calls.length > 0);
  });

  it('他のキーを保持すること', () => {
    writeProjectConfig(root, { tasks: [{ filename: 'main.rb' }] });
    const context = createContext({ root });
    main.updateCompiler(context, { version: '3.4.0' });
    assert.deepEqual(readProjectConfig(root), { tasks: [{ filename: 'main.rb' }], compiler: { version: '3.4.0' } });
  });

  it('ワークスペースを開いていなければ警告すること', () => {
    const warnings = [];
    const context = createContext({ window: { showWarningMessage: (message) => warnings.push(message) } });
    main.updateCompiler(context, { version: '3.4.0' });
    assert.deepEqual(warnings, ['kaniburner: プロジェクト設定を保存するにはフォルダを開いてください。']);
  });
});

describe('#updateDevice', () => {
  it('差分をマージして保存すること', () => {
    const context = createContext({ device: { port: '/dev/x', baud: 9600 } });
    main.updateDevice(context, { baud: 115200 });
    assert.deepEqual(context.storage.data['kaniburner.device'], { port: '/dev/x', baud: 115200 });
  });
});

describe('#addProjectEntries', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('末尾に追加すること', () => {
    writeProjectConfig(root, { tasks: [{ filename: 'a.rb' }] });
    const context = createContext({ root });
    main.addProjectEntries(context, 'tasks', ['b.rb', 'c.rb']);
    assert.deepEqual(readProjectConfig(root).tasks, [{ filename: 'a.rb' }, { filename: 'b.rb' }, { filename: 'c.rb' }]);
  });

  it('キーが無ければ作ること', () => {
    const context = createContext({ root });
    main.addProjectEntries(context, 'libraries', ['lib.rb']);
    assert.deepEqual(readProjectConfig(root).libraries, [{ filename: 'lib.rb' }]);
  });
});

describe('#removeProjectEntry', () => {
  let root;
  beforeEach(() => {
    root = makeWorkspace();
    writeProjectConfig(root, { tasks: [{ filename: 'a.rb' }, { filename: 'b.rb' }] });
  });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('指定位置を削除すること', () => {
    const context = createContext({ root });
    main.removeProjectEntry(context, 'tasks', 0);
    assert.deepEqual(readProjectConfig(root).tasks, [{ filename: 'b.rb' }]);
  });

  it('範囲外なら何もしないこと', () => {
    const context = createContext({ root });
    main.removeProjectEntry(context, 'tasks', 2);
    main.removeProjectEntry(context, 'libraries', 0);
    assert.deepEqual(readProjectConfig(root).tasks, [{ filename: 'a.rb' }, { filename: 'b.rb' }]);
  });
});

describe('#moveProjectEntry', () => {
  let root;
  beforeEach(() => {
    root = makeWorkspace();
    writeProjectConfig(root, { tasks: [{ filename: 'a.rb' }, { filename: 'b.rb' }, { filename: 'c.rb' }] });
  });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('隣と入れ替えること', () => {
    const context = createContext({ root });
    main.moveProjectEntry(context, 'tasks', 1, 1);
    assert.deepEqual(readProjectConfig(root).tasks.map((entry) => entry.filename), ['a.rb', 'c.rb', 'b.rb']);
  });

  it('端では何もしないこと', () => {
    const context = createContext({ root });
    main.moveProjectEntry(context, 'tasks', 0, -1);
    main.moveProjectEntry(context, 'tasks', 2, 1);
    assert.deepEqual(readProjectConfig(root).tasks.map((entry) => entry.filename), ['a.rb', 'b.rb', 'c.rb']);
  });
});

describe('#resolveCompilerVersion', () => {
  let root, context;
  beforeEach(async () => {
    root = makeWorkspace();
    context = createContext({ root, window: { activeTextEditor: { document: document('/main.rb', 'puts 1') } } });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
  });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('手動選択ではボード情報にかかわらず設定値を使うこと', () => {
    main.updateDevice(context, { autoDetect: false });
    context.setBoardInfo(main.parseBoardInfo('+OK mruby/c v3.3 RITE0300'));
    assert.deepEqual(main.resolveCompilerVersion(context), { version: '4.0.0', warning: null });
  });

  it('自動判定ではRITE形式に対応するコンパイラへ切り替えること', () => {
    main.updateCompiler(context, { version: '4.0.0' });
    context.setBoardInfo(main.parseBoardInfo('+OK mruby/c v3.3 RITE0300'));
    assert.deepEqual(main.resolveCompilerVersion(context), { version: '3.4.0', warning: null });
    assert.equal(main.compilerDirectory(context), path.join('/ext', 'media', 'mruby-3.4.0'));
    context.setBoardInfo(main.parseBoardInfo('+OK mruby/c v4.0 RITE0400'));
    assert.deepEqual(main.resolveCompilerVersion(context), { version: '4.0.0', warning: null });
    assert.deepEqual(readProjectConfig(root).compiler, { version: '4.0.0' });
  });

  it('取得後に自動判定を切り替えると使用バージョンも変わること', () => {
    context.setBoardInfo(main.parseBoardInfo('+OK mruby/c v3.3 RITE0300'));
    main.updateCompiler(context, { version: '4.0.0' });
    assert.equal(main.resolveCompilerVersion(context).version, '3.4.0');
    main.updateDevice(context, { autoDetect: false });
    assert.deepEqual(main.resolveCompilerVersion(context), { version: '4.0.0', warning: null });
    assert.equal(readProjectConfig(root).compiler.version, '4.0.0');
  });

  it('判定できなければ理由と手動設定のバージョンを返すこと', () => {
    main.updateCompiler(context, { version: '3.4.0' });
    for (const response of [null, '-ERR', '+OK mruby/c v3.3', '+OK mruby/c v3.3 RITE9999']) {
      context.setBoardInfo(main.parseBoardInfo(response));
      const selected = main.resolveCompilerVersion(context);
      assert.equal(selected.version, '3.4.0');
      assert.ok(selected.warning);
      assert.equal(contextValues(context)['kaniburner.canWrite'], true);
    }
  });

  it('切断後は手動設定へ戻り、Writeを無効にすること', async () => {
    main.updateCompiler(context, { version: '4.0.0' });
    context.setBoardInfo(main.parseBoardInfo('+OK mruby/c v3.3 RITE0300'));
    await main.disconnect(context);
    const selected = main.resolveCompilerVersion(context);
    assert.equal(selected.version, '4.0.0');
    assert.match(selected.warning, /接続されていません/);
    assert.equal(contextValues(context)['kaniburner.canCompile'], false);
  });
});

describe('#compilerDirectory', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('同梱バージョンならmedia配下のディレクトリを返すこと', () => {
    const context = createContext({ root, extensionPath: '/ext' });
    assert.equal(main.compilerDirectory(context), path.join('/ext', 'media', 'mruby-4.0.0'));
  });

  it('同梱されていないバージョンならnullを返すこと', () => {
    writeProjectConfig(root, { compiler: { version: '9.9.9' } });
    const context = createContext({ root });
    assert.equal(main.compilerDirectory(context), null);
  });
});

const document = (fileName, text = '', isClosed = false) => ({ fileName, isClosed, getText: () => text });

describe('#compileAndWrite', () => {
  let root, context;
  beforeEach(() => {
    root = makeWorkspace();
    installMrbc(path.join(root, 'media', 'mruby-3.4.0'));
    installMrbc(path.join(root, 'media', 'mruby-4.0.0'));
    context = createContext({ root, extensionPath: root, window: {
      activeTextEditor: { document: document(path.join(root, 'main.rb'), 'task') }
    } });
  });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('未接続ならコンパイルも書込みも行わないこと', async () => {
    await main.compileAndWrite(context);
    assert.equal(context.SerialPort.instances.length, 0);
    assert.equal(context.get().mrbcDirectory, null);
    assert.equal(context.output.lines.length, 0);
  });

  it('接続中は判定してからコンパイル・書き込みを行うこと', async () => {
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    await main.readBoardInfo(context);
    await main.compileAndWrite(context);
    assert.equal(context.get().mrbcDirectory, path.join(root, 'media', 'mruby-3.4.0'));
    assert.ok(context.output.lines.includes('[info]  Compiling (mruby 3.4.0)...'));
    assert.deepEqual(context.get().serialPort.written, ['version\r\n', 'clear\r\n', 'write 4 8fbe\r\n', 'task']);
  });

  it('判定が失敗しても設定中のコンパイラで書き込むこと', async () => {
    context.SerialPort = createSerialPort({ device: (text) => text === 'version\r\n' ? '-ERR Illegal command.\r\n' : mrbwriteDevice(text) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    await main.readBoardInfo(context);
    await main.compileAndWrite(context);
    assert.equal(context.get().mrbcDirectory, path.join(root, 'media', 'mruby-4.0.0'));
    assert.ok(main.resolveCompilerVersion(context).warning);
    assert.deepEqual(context.get().serialPort.written, ['version\r\n', 'clear\r\n', 'write 4 8fbe\r\n', 'task']);
  });

  it('判定がタイムアウトしても書き込みを続行すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    context.SerialPort = createSerialPort({ device: (text) => text === 'version\r\n' ? '' : mrbwriteDevice(text) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const result = main.readBoardInfo(context);
    await advance(t, 5000);
    await result;
    await main.compileAndWrite(context);
    assert.equal(context.get().mrbcDirectory, path.join(root, 'media', 'mruby-4.0.0'));
    assert.ok(context.output.lines.includes('[info]  Write completed.'));
  });

  it('コンパイル失敗時はclearもwriteも送らないこと', async () => {
    context.vscode.window.activeTextEditor.document = document(path.join(root, 'main.rb'), 'fail');
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    await main.readBoardInfo(context);
    await main.compileAndWrite(context);
    assert.deepEqual(context.get().serialPort.written, ['version\r\n']);
  });

  it('コンパイル中に切断されたら書き込まないこと', async () => {
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const port = context.get().serialPort;
    await main.readBoardInfo(context);
    context.output.append = () => { main.disconnect(context); };
    await main.compileAndWrite(context);
    assert.deepEqual(port.written, ['version\r\n']);
  });
});

describe('#workspaceRoot', () => {
  it('最初のワークスペースフォルダのパスを返すこと', () => {
    assert.equal(main.workspaceRoot(createContext({ root: '/ws' })), '/ws');
  });

  it('開いていなければnullを返すこと', () => {
    assert.equal(main.workspaceRoot(createContext()), null);
  });
});

describe('#toAbsoluteFilepath', () => {
  it('絶対パスはそのまま返すこと', () => {
    assert.equal(main.toAbsoluteFilepath(createContext(), '/abs/a.rb'), '/abs/a.rb');
  });

  it('相対パスはワークスペースルートと結合すること', () => {
    assert.equal(main.toAbsoluteFilepath(createContext({ root: '/ws' }), 'src/a.rb'), path.join('/ws', 'src/a.rb'));
  });

  it('ワークスペースを開いていなければnullを返すこと', () => {
    assert.equal(main.toAbsoluteFilepath(createContext(), 'a.rb'), null);
  });
});

describe('#rememberEditor', () => {
  it('.rbのドキュメントを記憶すること', () => {
    const context = createContext();
    context.rememberEditor({ document: document('/a.rb') });
    assert.equal(context.get().lastRubyDocument.fileName, '/a.rb');
  });

  it('.rb以外やエディタ無しでは記憶を変えないこと', () => {
    const context = createContext();
    context.rememberEditor({ document: document('/a.rb') });
    context.rememberEditor({ document: document('/b.txt') });
    context.rememberEditor(undefined);
    assert.equal(context.get().lastRubyDocument.fileName, '/a.rb');
  });
});

describe('#activeRubyDocument', () => {
  it('アクティブな.rbを優先すること', () => {
    const context = createContext({ window: { activeTextEditor: { document: document('/active.rb') } } });
    context.rememberEditor({ document: document('/last.rb') });
    assert.equal(main.activeRubyDocument(context).fileName, '/active.rb');
  });

  it('アクティブが.rbでなければ記憶したものを返すこと', () => {
    const context = createContext({ window: { activeTextEditor: { document: document('/a.txt') } } });
    context.rememberEditor({ document: document('/last.rb') });
    assert.equal(main.activeRubyDocument(context).fileName, '/last.rb');
  });

  it('記憶したものが閉じていれば表示中の.rbを返すこと', () => {
    const context = createContext({ window: {
      activeTextEditor: undefined,
      visibleTextEditors: [{ document: document('/v.txt') }, { document: document('/v.rb') }]
    } });
    context.rememberEditor({ document: document('/last.rb', '', true) });
    assert.equal(main.activeRubyDocument(context).fileName, '/v.rb');
  });

  it('候補が無ければnullを返すこと', () => {
    const context = createContext({ window: { activeTextEditor: undefined, visibleTextEditors: [] } });
    assert.equal(main.activeRubyDocument(context), null);
  });
});

describe('#readSources', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); fs.writeFileSync(path.join(root, 'a.rb'), 'puts 1'); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('ファイルを読んでfilenameと対にすること', () => {
    const context = createContext({ root });
    assert.deepEqual(main.readSources(context, [{ filename: 'a.rb' }], 'tasks'), [{ filename: 'a.rb', source: 'puts 1' }]);
  });

  it('開けないファイルがあれば警告してnullを返すこと', () => {
    const warnings = [];
    const context = createContext({ root, window: { showWarningMessage: (message) => warnings.push(message) } });
    assert.equal(main.readSources(context, [{ filename: 'a.rb' }, { filename: 'missing.rb' }], 'tasks'), null);
    assert.deepEqual(warnings, ['kaniburner: tasks のファイルを開けません: missing.rb']);
  });

  it('ワークスペースを開いていなければ警告してnullを返すこと', () => {
    const warnings = [];
    const context = createContext({ window: { showWarningMessage: (message) => warnings.push(message) } });
    assert.equal(main.readSources(context, [{ filename: 'a.rb' }], 'libraries'), null);
    assert.deepEqual(warnings, ['kaniburner: libraries のファイルを開けません: a.rb']);
  });
});

describe('#resolveTaskSources', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); fs.writeFileSync(path.join(root, 'a.rb'), 'puts 1'); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('設定のtasksを優先すること', () => {
    writeProjectConfig(root, { tasks: [{ filename: 'a.rb' }] });
    const context = createContext({ root });
    assert.deepEqual(main.resolveTaskSources(context), [{ filename: 'a.rb', source: 'puts 1' }]);
  });

  it('tasksが無ければアクティブな.rbを使うこと', () => {
    const context = createContext({ root, window: { activeTextEditor: { document: document('/x/main.rb', 'puts 2') } } });
    assert.deepEqual(main.resolveTaskSources(context), [{ filename: 'main.rb', source: 'puts 2' }]);
  });

  it('.rbが無ければ警告してnullを返すこと', () => {
    const warnings = [];
    const context = createContext({ root, window: {
      activeTextEditor: undefined, visibleTextEditors: [], showWarningMessage: (message) => warnings.push(message)
    } });
    assert.equal(main.resolveTaskSources(context), null);
    assert.deepEqual(warnings, ['kaniburner: .rbファイルを開いてください']);
  });
});

describe('#toProjectFilename', () => {
  it('ワークスペースからの相対パスにすること', () => {
    const context = createContext({ root: '/ws' });
    assert.equal(main.toProjectFilename(context, new Uri('/ws/src/a.rb')), path.join('src', 'a.rb'));
  });

  it('ワークスペース外ならnullを返すこと', () => {
    const context = createContext({ root: '/ws' });
    assert.equal(main.toProjectFilename(context, new Uri('/other/a.rb')), null);
  });

  it('.rb以外ならnullを返すこと', () => {
    const context = createContext({ root: '/ws' });
    assert.equal(main.toProjectFilename(context, new Uri('/ws/a.txt')), null);
  });

  it('ワークスペースを開いていなければnullを返すこと', () => {
    assert.equal(main.toProjectFilename(createContext(), new Uri('/ws/a.rb')), null);
  });
});

describe('#unregisteredFilenames', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('登録済みと対象外を除き、重複なく返すこと', () => {
    writeProjectConfig(root, { tasks: [{ filename: 'a.rb' }] });
    const context = createContext({ root });
    const uris = ['a.rb', 'b.rb', 'b.rb', 'c.txt', '../d.rb'].map((name) => new Uri(path.join(root, name)));
    assert.deepEqual(main.unregisteredFilenames(context, 'tasks', uris), ['b.rb']);
  });

  it('別のキーの登録は除外しないこと', () => {
    writeProjectConfig(root, { libraries: [{ filename: 'a.rb' }] });
    const context = createContext({ root });
    assert.deepEqual(main.unregisteredFilenames(context, 'tasks', [new Uri(path.join(root, 'a.rb'))]), ['a.rb']);
  });
});

describe('#openTabUris', () => {
  it('全グループのタブからURIを集めること', () => {
    const context = createContext({ window: { tabGroups: { all: [
      { tabs: [{ input: { uri: new Uri('/a.rb') } }, { input: {} }] },
      { tabs: [{ input: undefined }, { input: { uri: new Uri('/b.rb') } }] }
    ] } } });
    assert.deepEqual(main.openTabUris(context).map((uri) => uri.fsPath), ['/a.rb', '/b.rb']);
  });
});

const PORTS = [{ path: '/dev/a', manufacturer: 'Acme', vendorId: '1234', productId: '5678' }, { path: '/dev/b' }];

describe('#pickPort', () => {
  it('ポートが無ければエラーを表示してnullを返すこと', async () => {
    const errors = [];
    const context = createContext({ SerialPort: createSerialPort({ ports: [] }), window: { showErrorMessage: (message) => errors.push(message) } });
    assert.equal(await main.pickPort(context), null);
    assert.deepEqual(errors, ['kaniburner: No serial ports found.']);
  });

  it('一覧の取得に失敗したら記録してnullを返すこと', async () => {
    const SerialPort = createSerialPort();
    SerialPort.list = () => Promise.reject(new Error('denied'));
    const context = createContext({ SerialPort });
    assert.equal(await main.pickPort(context), null);
    assert.ok(context.output.lines.includes('[error] Failed to list ports: denied'));
  });

  it('前回のポートを選択済みにし、メタデータを説明に出すこと', async () => {
    let shown;
    const context = createContext({
      SerialPort: createSerialPort({ ports: PORTS }),
      device: { port: '/dev/b' },
      window: { showQuickPick: async (items) => { shown = items; return undefined; } }
    });
    assert.equal(await main.pickPort(context), null);
    assert.deepEqual(shown, [
      { label: '/dev/a', description: 'Acme VID:1234 PID:5678', picked: false },
      { label: '/dev/b', description: undefined, picked: true }
    ]);
  });

  it('選択したポートを保存して返すこと', async () => {
    const context = createContext({
      SerialPort: createSerialPort({ ports: PORTS }),
      window: { showQuickPick: async (items) => items[0] }
    });
    assert.equal(await main.pickPort(context), '/dev/a');
    assert.equal(context.storage.data['kaniburner.device'].port, '/dev/a');
  });
});

describe('#ensureConnected', () => {
  it('接続済みならtrueを返すこと', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    assert.equal(await main.ensureConnected(context), true);
    assert.equal(context.SerialPort.instances.length, 1);
  });

  it('設定のポートとボーレートで接続すること', async () => {
    const context = createContext({ device: { port: '/dev/x', baud: 115200 } });
    assert.equal(await main.ensureConnected(context), true);
    assert.equal(context.get().serialPort.path, '/dev/x');
    assert.equal(context.get().serialPort.baudRate, 115200);
    assert.ok(context.output.lines.includes('[info]  Connecting (115200 baud, /dev/x)...'));
    assert.ok(context.output.lines.includes('[info]  Connected.'));
  });

  it('ポートが未設定なら選択させること', async () => {
    const context = createContext({
      SerialPort: createSerialPort({ ports: PORTS }),
      window: { showQuickPick: async (items) => items[1] }
    });
    assert.equal(await main.ensureConnected(context), true);
    assert.equal(context.get().serialPort.path, '/dev/b');
  });

  it('選択されなければfalseを返すこと', async () => {
    const context = createContext({
      SerialPort: createSerialPort({ ports: PORTS }),
      window: { showQuickPick: async () => undefined }
    });
    assert.equal(await main.ensureConnected(context), false);
  });

  it('接続に失敗したら記録してfalseを返すこと', async () => {
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ openError: new Error('busy') }) });
    assert.equal(await main.ensureConnected(context), false);
    assert.ok(context.output.lines.includes('[error] Connect failed: busy'));
  });
});

describe('#restartAndReconnect', () => {
  it('未接続ならfalseを返すこと', async () => {
    assert.equal(await main.restartAndReconnect(createContext()), false);
  });

  it('コマンドモード中はresetを送り、再接続してコマンドモードへ入ること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ ports: [{ path: '/dev/x' }] }) });
    await main.connect(context, '/dev/x', 19200);
    const first = context.get().serialPort;
    context.enterCommandMode();
    const result = main.restartAndReconnect(context);
    await flush();
    assert.deepEqual(first.written, ['reset\r\n']);
    first.listeners.close();
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await result, true);
    assert.notEqual(context.get().serialPort, first);
    assert.ok(context.output.lines.includes('[info]  Reconnected.'));
    assert.equal(context.get().commandMode, true);
  });

  it('実行モード中はBREAKを送ること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ ports: [{ path: '/dev/x' }] }) });
    await main.connect(context, '/dev/x', 19200);
    const first = context.get().serialPort;
    const result = main.restartAndReconnect(context);
    await advance(t, 100);
    assert.deepEqual(first.sets, [
      { brk: false, dtr: true, rts: true },
      { brk: true, dtr: true, rts: true },
      { brk: false, dtr: true, rts: true }
    ]);
    assert.ok(context.output.lines.includes('[info]  > break'));
    first.listeners.close();
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await result, true);
  });

  it('ポートが再出現しなければfalseを返すこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ ports: [] }) });
    await main.connect(context, '/dev/x', 19200);
    context.enterCommandMode();
    const result = main.restartAndReconnect(context);
    await flush();
    context.get().serialPort.listeners.close();
    for (let second = 0; second < 60; second++) await advance(t, 1000);
    assert.equal(await result, false);
    assert.equal(context.SerialPort.instances.length, 1);
  });
});

describe('#connectionLifecycle', () => {
  it('Cancelでポートを残し、再送と遅い応答による確立を止めること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ device: () => '' }) });
    context.setAutoConnect(true);
    const result = main.connectDevice(context);
    await flush();
    const port = context.get().serialPort;
    assert.equal(main.canAction(context, 'Cancel'), true);
    assert.equal(main.canAction(context, 'Disconnect'), false);
    assert.equal(main.canAction(context, 'Restart'), true);
    main.cancelConnection(context);
    port.receive('+OK mruby/c\r\n');
    await advance(t, 10000);
    assert.equal(await result, false);
    assert.equal(context.get().serialPort, port);
    assert.equal(context.get().commandMode, false);
    assert.equal(context.get().autoConnect, false);
    assert.deepEqual(port.written, ['\r\n']);
    assert.equal(main.canAction(context, 'Disconnect'), true);
    assert.equal(context.get().running, 0);
  });

  it('Connect検証中の送信タイムアウトは記録せず、再試行すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const Base = createSerialPort();
    class SerialPort extends Base {
      write(buffer) { this.written.push(buffer.toString('latin1')); }
    }
    const context = createContext({ device: { port: '/dev/x' }, SerialPort });
    const result = main.connectDevice(context);
    await advance(t, 5000);
    assert.deepEqual(context.get().serialPort.written, ['\r\n', '\r\n']);
    assert.ok(context.output.lines.includes('[info]  Entering command mode... (5/60s)'));
    assert.ok(!context.output.lines.some((line) => line.startsWith('[error]')));
    assert.equal(main.canAction(context, 'Disconnect'), false);
    main.cancelConnection(context);
    assert.equal(await result, false);
    assert.equal(main.canAction(context, 'Disconnect'), true);
  });

  it('Restart検証中の送信タイムアウトは記録せず、Cancel後にDisconnectを許可すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext();
    await main.connect(context, '/dev/x', 9600);
    const port = context.get().serialPort;
    port.write = (buffer) => { port.written.push(buffer.toString('latin1')); };
    const result = main.restartAndReconnect(context);
    assert.equal(main.canAction(context, 'Disconnect'), false);
    await advance(t, 100);
    await advance(t, 1000);
    await advance(t, 5000);
    assert.deepEqual(port.written, ['\r\n', '\r\n']);
    assert.ok(context.output.lines.includes('[info]  Entering command mode... (6/60s)'));
    assert.ok(!context.output.lines.some((line) => line.startsWith('[error]')));
    assert.equal(main.canAction(context, 'Cancel'), true);
    assert.equal(main.canAction(context, 'Disconnect'), false);
    main.cancelConnection(context);
    assert.equal(await result, false);
    assert.equal(main.canAction(context, 'Disconnect'), true);
  });

  it('確立応答が先ならCancelで成功を覆さないこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ device: { port: '/dev/x' } });
    const result = main.connectDevice(context);
    await flush();
    assert.equal(context.get().commandMode, true);
    assert.equal(main.canAction(context, 'Cancel'), false);
    main.cancelConnection(context);
    await advance(t, 1000);
    assert.equal(await result, true);
  });

  it('Connect検証中のcloseも同じポートへ再接続すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const SerialPort = createSerialPort({ device: (text) => SerialPort.instances.length > 1 ? mrbwriteDevice(text) : '' });
    const context = createContext({ device: { port: '/dev/x' }, SerialPort });
    const result = main.connectDevice(context);
    await flush();
    context.get().serialPort.listeners.close();
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await result, true);
    assert.equal(context.get().commandMode, true);
    assert.equal(context.SerialPort.instances.length, 2);
  });

  it('Restart検証中の遅いcloseでも同じポートへの復旧を続けること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const SerialPort = createSerialPort({ ports: [{ path: '/dev/x' }], device: (text) => SerialPort.instances.length > 1 || text === 'reset\r\n' ? mrbwriteDevice(text) : '' });
    const context = createContext({ device: { port: '/dev/x' }, SerialPort });
    await main.connect(context, '/dev/x', 19200);
    context.enterCommandMode();
    const port = context.get().serialPort;
    const result = main.restartAndReconnect(context);
    port.receive('Kani-Board, Please push Enter key to mrbwrite mode\r\n');
    await advance(t, 1000);
    assert.equal(context.get().operation.phase, 'probing');
    main.updateDevice(context, { port: '/dev/other', baud: 9600 });
    port.listeners.close();
    for (let i = 0; i < 5; i++) await advance(t, 1000);
    assert.equal(await result, true);
    assert.equal(context.get().serialPort.path, '/dev/x');
    assert.equal(context.get().serialPort.baudRate, 19200);
    assert.equal(SerialPort.instances.length, 2);
  });

  it('ポートが残るRestartは+OKを待ち、起動通知なしで確立すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ SerialPort: createSerialPort({ device: (text) => text === 'reset\r\n' ? '' : mrbwriteDevice(text) }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const port = context.get().serialPort;
    const result = main.restartAndReconnect(context);
    await advance(t, 1000);
    assert.deepEqual(port.written, ['reset\r\n']);
    port.receive('+OK mruby/c\r\n');
    await advance(t, 1000);
    assert.deepEqual(port.written, ['reset\r\n']);
    port.receive('+OK\r\n');
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await result, true);
    assert.equal(context.get().serialPort, port);
    assert.equal(context.SerialPort.instances.length, 1);
  });

  it('reset拒否時は検証を始めずポートのみ接続へ戻ること', async () => {
    const context = createContext({ SerialPort: createSerialPort({ device: () => '-ERR Illegal command.\r\n' }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const port = context.get().serialPort;
    assert.equal(await main.restartAndReconnect(context), false);
    assert.deepEqual(port.written, ['reset\r\n']);
    assert.equal(context.get().serialPort, port);
    assert.equal(context.get().commandMode, false);
    assert.equal(main.canAction(context, 'Restart'), true);
  });

  it('Connectも未出現ポートを待ち、毎回のlistを記録し、Cancelで未接続へ戻ること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ ports: [] }) });
    let lists = 0;
    context.SerialPort.list = async () => { lists++; return []; };
    const result = main.connectDevice(context);
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(lists, 3);
    assert.equal(context.output.lines.filter((line) => line.includes('Listing ports')).length, lists);
    assert.ok(context.output.lines.some((line) => line.includes('(2/60s)')));
    assert.equal(main.canAction(context, 'Cancel'), true);
    main.cancelConnection(context);
    await advance(t, 1000);
    assert.equal(await result, false);
    assert.equal(lists, 3);
    assert.equal(context.get().serialPort, null);
    assert.equal(main.canAction(context, 'Connect'), true);
  });

  it('Connectのopen待ちもCancelでき、遅い成功を回収すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let release;
    const Base = createSerialPort();
    class SerialPort extends Base {
      constructor(options, callback) { super(options, (error) => { release = () => callback(error); }); }
    }
    const context = createContext({ device: { port: '/dev/x' }, SerialPort });
    const result = main.connectDevice(context);
    await flush();
    assert.equal(context.get().operation.phase, 'opening');
    assert.equal(main.canAction(context, 'Cancel'), true);
    main.cancelConnection(context);
    release();
    await flush();
    assert.equal(await result, false);
    assert.equal(context.get().serialPort, null);
    assert.equal(Base.instances[0].closed, true);
  });

  it('Connectのlistが応答しなくても共通の60秒期限で終了すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ device: { port: '/dev/x' } });
    context.SerialPort.list = () => new Promise(() => {});
    const result = main.connectDevice(context);
    await advance(t, 60000);
    assert.equal(await result, false);
    assert.equal(context.get().operation, null);
    assert.equal(main.canAction(context, 'Connect'), true);
  });

  it('一覧・open失敗から再試行し、Connect開始時の接続先を保つこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const Base = createSerialPort();
    class SerialPort extends Base {
      constructor(options, callback) {
        super(options, (error) => callback(Base.instances.length === 1 ? new Error('busy') : error));
      }
    }
    let lists = 0;
    SerialPort.list = async () => {
      if (++lists === 1) throw new Error('list failed');
      return [{ path: '/dev/x' }];
    };
    const context = createContext({ device: { port: '/dev/x', baud: 19200 }, SerialPort });
    const result = main.connectDevice(context);
    await flush();
    main.updateDevice(context, { port: '/dev/other', baud: 9600 });
    for (let second = 0; second < 3; second++) await advance(t, 1000);
    assert.equal(await result, true);
    assert.equal(lists, 3);
    assert.equal(Base.instances.length, 2);
    assert.equal(context.get().serialPort.path, '/dev/x');
    assert.equal(context.get().serialPort.baudRate, 19200);
    assert.ok(context.output.lines.includes('[error] Connect failed: list failed'));
    assert.ok(context.output.lines.includes('[error] Connect failed: busy'));
  });

  it('検証と再openを往復してもConnectの期限を延長しないこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ device: () => '' }) });
    const result = main.connectDevice(context);
    for (let second = 0; second < 60; second++) {
      if (second === 20 || second === 40) context.get().serialPort.listeners.close();
      await advance(t, 1000);
    }
    assert.equal(await result, false);
    assert.equal(context.SerialPort.instances.length, 3);
    assert.notEqual(context.get().serialPort, null);
    assert.equal(context.get().commandMode, false);
    assert.equal(main.canAction(context, 'Restart'), true);
  });

  it('reset応答期限超過はCRLF検証を始めずポートを残すこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ SerialPort: createSerialPort({ device: () => '' }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const port = context.get().serialPort;
    const result = main.restartAndReconnect(context);
    await advance(t, 5000);
    assert.equal(await result, false);
    assert.deepEqual(port.written, ['reset\r\n']);
    assert.equal(context.get().serialPort, port);
    assert.equal(context.get().commandMode, false);
    assert.equal(context.get().operation, null);
  });

  it('reset送信の完了前にUSBが切断されても復旧を続けること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ SerialPort: createSerialPort({ ports: [{ path: '/dev/x' }] }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const port = context.get().serialPort;
    port.write = (buffer, callback) => {
      port.listeners.close();
      callback(new Error('Disconnected'));
    };
    const result = main.restartAndReconnect(context);
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await result, true);
    assert.notEqual(context.get().serialPort, port);
  });

  it('Break制御の完了前にUSBが切断されても復旧を続けること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ SerialPort: createSerialPort({ ports: [{ path: '/dev/x' }] }) });
    await main.connect(context, '/dev/x', 9600);
    const port = context.get().serialPort;
    port.set = (options, callback) => {
      port.listeners.close();
      callback(new Error('Disconnected'));
    };
    const result = main.restartAndReconnect(context);
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await result, true);
    assert.notEqual(context.get().serialPort, port);
  });

  it('RestartでConnectの検証を入れ替え、古い終了処理で新しい操作を消さないこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let reply = false;
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ device: (text) => reply ? mrbwriteDevice(text) : '' }) });
    const connection = main.connectDevice(context);
    await flush();
    const restart = main.restartAndReconnect(context);
    await advance(t, 100);
    assert.equal(await connection, false);
    assert.equal(context.get().operation.action, 'restart');
    assert.equal(context.get().running, 1);
    reply = true;
    context.get().serialPort.receive('Kani-Board, Please push Enter key to mrbwrite mode\r\n');
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await restart, true);
    assert.equal(context.get().running, 0);
  });

  it('Restartの再open中のCancelで遅いopen成功も回収すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let release;
    const Base = createSerialPort({ ports: [{ path: '/dev/x' }] });
    class SerialPort extends Base {
      constructor(options, callback) {
        super(options, (error) => {
          if (Base.instances.length === 1) callback(error);
          else release = () => callback(error);
        });
      }
    }
    const context = createContext({ SerialPort });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const result = main.restartAndReconnect(context);
    context.get().serialPort.listeners.close();
    await advance(t, 1000);
    assert.equal(context.get().operation.phase, 'opening');
    main.cancelConnection(context);
    await flush();
    release();
    await advance(t, 1000);
    assert.equal(await result, false);
    assert.equal(context.get().serialPort, null);
    assert.equal(Base.instances[1].closed, true);
    assert.equal(main.canAction(context, 'Connect'), true);
  });

  it('古いポートのcloseとdataで新しい接続を変更しないこと', async () => {
    const context = createContext();
    await main.connect(context, '/dev/x', 9600);
    const old = context.get().serialPort;
    await main.disconnect(context);
    await main.connect(context, '/dev/x', 9600);
    const port = context.get().serialPort;
    context.enterCommandMode();
    old.listeners.close();
    old.receive('Kani-Board, End mrbwrite mode\r\n');
    assert.equal(context.get().serialPort, port);
    assert.equal(context.get().commandMode, true);
  });

  it('open期限超過後に成功しても接続状態を復活させないこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let release;
    const Base = createSerialPort();
    class SerialPort extends Base {
      constructor(options, callback) { super(options, (error) => { release = () => callback(error); }); }
    }
    const context = createContext({ SerialPort });
    const result = assert.rejects(main.connect(context, '/dev/x', 9600), /timed out/);
    await advance(t, 5000);
    await result;
    release();
    await flush();
    assert.equal(context.get().serialPort, null);
    assert.equal(Base.instances[0].closed, true);
  });

  it('Breakアサート失敗時も解除を試み、失敗を返すこと', async () => {
    const context = createContext();
    await main.connect(context, '/dev/x', 9600);
    const port = context.get().serialPort;
    port.set = (options, callback) => {
      port.sets.push(options);
      callback(options.brk ? new Error('Break failed') : null);
    };
    await assert.rejects(main.sendBreak(context), /Break failed/);
    assert.deepEqual(port.sets.map((options) => options.brk), [false, true, false]);
  });

  it('Execute待機中はCancel・Writeを無効にし、version応答を成功としないこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({ SerialPort: createSerialPort({ device: () => '' }) });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const port = context.get().serialPort;
    const result = main.runAction(context, () => main.execute(context), 'execute');
    port.receive('+OK mruby/c v3.4 RITE0300 MRBW1.2\r\n');
    assert.equal(main.canAction(context, 'Cancel'), false);
    assert.equal(main.canAction(context, 'Write'), false);
    assert.equal(main.canAction(context, 'Disconnect'), true);
    assert.equal(context.get().commandMode, true);
    port.receive('-ERR Illegal command.\r\n');
    await result;
    port.receive('+OK\r\n');
    assert.equal(context.get().commandMode, true);
    assert.equal(context.get().lastCommand, null);
  });

  it('中止済みの応答タイマーで新しい待機を消さないこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext();
    const old = main.waitForResponse(context, 1000);
    main.resetProtocol(context);
    const next = main.waitForResponse(context, 5000);
    await advance(t, 1000);
    main.feed(context, encode('+OK\r\n'));
    assert.equal(await old, null);
    assert.equal(await next, '+OK');
  });

  it('ポート一覧が応答しなくてもRestart復旧の期限で終了すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext();
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    const result = main.restartAndReconnect(context);
    context.get().serialPort.listeners.close();
    context.SerialPort.list = () => new Promise(() => {});
    await advance(t, 1000);
    await advance(t, 59000);
    assert.equal(await result, false);
    assert.equal(context.get().operation, null);
    assert.equal(context.get().running, 0);
    assert.equal(main.canAction(context, 'Connect'), true);
  });

  it('close完了まではConnectを無効にすること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/x', 9600);
    const port = context.get().serialPort;
    let close;
    port.close = (callback) => { close = callback; };
    const result = main.disconnect(context);
    assert.equal(context.get().serialPort, port);
    assert.equal(main.canAction(context, 'Connect'), false);
    assert.equal(main.canAction(context, 'Disconnect'), false);
    await flush();
    close();
    await result;
    assert.equal(main.canAction(context, 'Connect'), true);
  });

  it('ポート選択中に終了した接続要求を遅い選択結果で再開しないこと', async () => {
    let select;
    const context = createContext({ SerialPort: createSerialPort({ ports: [{ path: '/dev/x' }] }), window: {
      showQuickPick: () => new Promise((resolve) => { select = resolve; })
    } });
    const result = main.connectDevice(context);
    await flush();
    await main.disconnect(context);
    select({ label: '/dev/x' });
    await flush();
    assert.equal(await result, false);
    assert.equal(context.SerialPort.instances.length, 0);
  });
});

describe('#ensureReady', () => {
  it('未接続では暗黙に接続しないこと', async () => {
    const context = createContext({ device: { port: '/dev/x' } });
    assert.equal(await main.ensureReady(context), false);
    assert.equal(context.SerialPort.instances.length, 0);
  });

  it('ポートのみ接続では暗黙にRestartしないこと', async () => {
    const context = createContext();
    await main.connect(context, '/dev/x', 9600);
    assert.equal(await main.ensureReady(context), false);
    assert.deepEqual(context.get().serialPort.written, []);
    assert.equal(context.get().serialPort.sets.length, 1);
  });

  it('コマンド受付を確認済みならtrueを返すこと', async () => {
    const context = createContext();
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    assert.equal(await main.ensureReady(context), true);
  });
});

describe('#autoConnectEnabled', () => {
  it('既定では無効になること', () => {
    assert.equal(main.autoConnectEnabled(createContext({ device: { port: '/dev/x' } })), false);
  });

  it('ポートが未設定なら無効になること', () => {
    const context = createContext();
    context.setAutoConnect(true);
    assert.equal(main.autoConnectEnabled(context), false);
  });

  it('明示的に切り替え、次の起動には引き継がないこと', () => {
    const context = createContext({ device: { port: '/dev/x' } });
    context.setAutoConnect(true);
    assert.equal(main.autoConnectEnabled(context), true);
    assert.equal(main.getSettings(context).autoConnect, true);
    assert.deepEqual(context.storage.data['kaniburner.device'], { port: '/dev/x' });
    const restarted = main.buildContext(context);
    assert.equal(main.autoConnectEnabled(restarted), false);
    assert.equal(main.getSettings(restarted).autoConnect, false);
    context.setAutoConnect(false);
    assert.equal(main.autoConnectEnabled(context), false);
  });
});

describe('#pollAutoConnect', () => {
  const createPollContext = (device, ports = [{ path: '/dev/x' }]) => {
    const context = createContext({ device, SerialPort: createSerialPort({ ports }) });
    context.setAutoConnect(true);
    return context;
  };

  it('設定のポートが現れたら接続してコマンドモードへ入ること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createPollContext({ port: '/dev/x', baud: 9600 });
    const result = main.pollAutoConnect(context);
    await advance(t, 1000);
    await result;
    assert.equal(context.get().serialPort.path, '/dev/x');
    assert.equal(context.get().serialPort.baudRate, 9600);
    assert.ok(context.output.lines.includes('[info]  Auto-connected.'));
    assert.equal(context.get().commandMode, true);
  });

  it('前回も見えていたポートには接続しないこと', async () => {
    const context = createPollContext({ port: '/dev/x' });
    context.setPortPresent(true);
    await main.pollAutoConnect(context);
    assert.equal(context.SerialPort.instances.length, 0);
  });

  it('ポートが消えたら次に現れた時へ備えること', async () => {
    const context = createPollContext({ port: '/dev/x' }, []);
    context.setPortPresent(true);
    await main.pollAutoConnect(context);
    assert.equal(context.get().portPresent, false);
  });

  it('接続中は何もしないこと', async () => {
    const context = createPollContext({ port: '/dev/x' });
    await main.connect(context, '/dev/x', 9600);
    await main.pollAutoConnect(context);
    assert.equal(context.SerialPort.instances.length, 1);
  });

  it('操作の実行中は何もしないこと', async () => {
    const context = createPollContext({ port: '/dev/x' });
    context.beginAction();
    await main.pollAutoConnect(context);
    assert.equal(context.SerialPort.instances.length, 0);
  });

  it('無効ならポート一覧も取得しないこと', async (t) => {
    const context = createPollContext({ port: '/dev/x' });
    context.setAutoConnect(false);
    const list = t.mock.method(context.SerialPort, 'list');
    await main.pollAutoConnect(context);
    assert.equal(list.mock.callCount(), 0);
    assert.equal(context.SerialPort.instances.length, 0);
  });

  it('ポート一覧の取得中に無効にされた場合は接続しないこと', async (t) => {
    const context = createPollContext({ port: '/dev/x' });
    let resolve;
    t.mock.method(context.SerialPort, 'list', () => new Promise((callback) => { resolve = callback; }));
    const result = main.pollAutoConnect(context);
    context.setAutoConnect(false);
    resolve([{ path: '/dev/x' }]);
    await result;
    assert.equal(context.SerialPort.instances.length, 0);
  });

  it('有効にし直した場合はポートの出現を再確認すること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createPollContext({ port: '/dev/x' });
    context.setPortPresent(true);
    context.setAutoConnect(false);
    context.setAutoConnect(true);
    const result = main.pollAutoConnect(context);
    await advance(t, 1000);
    await result;
    assert.equal(context.get().serialPort.path, '/dev/x');
  });

  it('接続に失敗しても共通期限まで再試行し、エラーとして記録しないこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const context = createContext({
      device: { port: '/dev/x' },
      SerialPort: createSerialPort({ ports: [{ path: '/dev/x' }], openError: new Error('busy') })
    });
    context.setAutoConnect(true);
    const result = main.pollAutoConnect(context);
    for (let second = 0; second < 60; second++) await advance(t, 1000);
    await result;
    assert.equal(context.get().serialPort, null);
    assert.equal(context.SerialPort.instances.length, 60);
    assert.ok(!context.output.lines.some((line) => line.startsWith('[error]')));
  });
});

describe('#createProvider', () => {
  it('refreshで変更イベントを発火すること', () => {
    const emitter = new EventEmitter();
    const provider = main.createProvider({ EventEmitter: class { constructor() { return emitter; } } }, () => ['x']);
    provider.refresh();
    assert.equal(emitter.fired, 1);
    assert.deepEqual(provider.getChildren(), ['x']);
    assert.equal(provider.getTreeItem('item'), 'item');
  });
});

describe('#settingItem', () => {
  it('値を説明に出し、行内アクション用のcontextValueを付けること', () => {
    const item = main.settingItem(createContext(), 'Port', '/dev/x', 'devicePort', 'plug');
    assert.equal(item.label, 'Port');
    assert.equal(item.description, '/dev/x');
    assert.equal(item.contextValue, 'devicePort');
    assert.equal(item.iconPath.id, 'plug');
  });
});

describe('#buildDeviceView', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('接続先・VM・コンパイラ・オプションの行を返すこと', () => {
    const context = createContext({ root, device: { port: '/dev/x', baud: 9600 } });
    assert.deepEqual(main.buildDeviceView(context).map((item) => [item.label, item.description, item.contextValue]), [
      ['Port', '/dev/x', 'devicePort'],
      ['mruby/c VM', '(not connected)', 'deviceVmVersion'],
      ['Baud', '9600', 'deviceBaud'],
      ['Auto connect', undefined, 'deviceAutoConnect'],
      ['mruby', '4.0.0', 'deviceVersion'],
      ['Auto detect compiler', undefined, 'deviceAutoDetect'],
      ['Auto verify', undefined, 'deviceAutoVerify']
    ]);
  });

  it('ポート未設定なら(none)と出すこと', () => {
    assert.equal(main.buildDeviceView(createContext({ root }))[0].description, '(none)');
  });

  it('コンパイラが無いバージョンには警告を付けること', () => {
    writeProjectConfig(root, { compiler: { version: '9.9.9' } });
    const version = main.buildDeviceView(createContext({ root }))[4];
    assert.equal(version.description, '9.9.9 (not found)');
    assert.equal(version.iconPath.id, 'warning');
    assert.equal(version.iconPath.color.id, 'errorForeground');
  });

  it('自動接続の状態をチェックボックスに出すこと', () => {
    const context = createContext({ root, device: { port: '/dev/x' } });
    const checkbox = () => main.buildDeviceView(context)[3].checkboxState;
    assert.equal(checkbox(), 0);
    context.setAutoConnect(true);
    assert.equal(checkbox(), 1);
    context.setAutoConnect(false);
    assert.equal(checkbox(), 0);
  });

  it('自動判定の保存値をチェックボックスに出すこと', () => {
    const checkbox = (device) => main.buildDeviceView(createContext({ root, device }))[5].checkboxState;
    assert.equal(checkbox({}).state, 1);
    assert.equal(checkbox({ autoDetect: true }).state, 1);
    assert.equal(checkbox({ autoDetect: false }), 0);
  });

  it('自動検証の保存値をチェックボックスに出すこと', () => {
    const checkbox = (device) => main.buildDeviceView(createContext({ root, device }))[6].checkboxState;
    assert.equal(checkbox({}), 1);
    assert.equal(checkbox({ autoVerify: true }), 1);
    assert.equal(checkbox({ autoVerify: false }), 0);
  });

  it('VMのバージョンを接続先の下に編集操作なしで表示すること', async () => {
    const context = createContext({ root, device: { port: '/dev/x' } });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    await main.readBoardInfo(context);
    const item = main.buildDeviceView(context)[1];
    assert.equal(item.description, 'v3.3');
    assert.equal(item.command, undefined);
    assert.match(item.tooltip, /\/dev\/x/);
    await main.disconnect(context);
    assert.equal(main.buildDeviceView(context)[1].description, '(not connected)');
  });

  it('VM情報を取得できない原因をホバーに表示すること', async () => {
    const context = createContext({ root });
    await main.connect(context, '/dev/x', 9600);
    context.setBoardInfo(main.parseBoardInfo('-ERR Illegal command.'));
    const item = main.buildDeviceView(context)[1];
    assert.equal(item.description, '(unknown)');
    assert.equal(item.iconPath.id, 'warning');
    assert.match(item.tooltip, /Illegal command/);
  });

  it('自動判定の警告をチェックボックス付近とホバーに表示すること', async () => {
    const context = createContext({ root, window: { activeTextEditor: { document: document('/main.rb', 'puts 1') } } });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    context.setBoardInfo(main.parseBoardInfo('+OK mruby/c v3.3 RITE9999'));
    const item = main.buildDeviceView(context)[5];
    assert.equal(item.checkboxState.state, 1);
    assert.equal(item.iconPath.id, 'warning');
    assert.equal(item.iconPath.color.id, 'editorWarning.foreground');
    assert.match(item.tooltip, /RITE9999/);
    assert.match(item.tooltip, /mruby 4\.0\.0を使用/);
    assert.equal(item.checkboxState.tooltip, item.tooltip);
    assert.equal(contextValues(context)['kaniburner.canWrite'], true);
    context.setBoardInfo(main.parseBoardInfo('+OK mruby/c v3.3 RITE0300'));
    const items = main.buildDeviceView(context);
    assert.equal(items[4].description, '3.4.0');
    assert.equal(items[5].iconPath.id, 'sync');
    assert.equal(items[5].tooltip, undefined);
  });

  it('子要素は持たないこと', () => {
    assert.deepEqual(main.buildDeviceView(createContext({ root }), {}), []);
  });
});

describe('#projectPosition', () => {
  it('1件ならOnlyになること', () => {
    assert.equal(main.projectPosition(0, 1), 'Only');
  });

  it('先頭・末尾・中間を区別すること', () => {
    assert.deepEqual([0, 1, 2].map((index) => main.projectPosition(index, 3)), ['First', 'Mid', 'Last']);
  });
});

describe('#buildProjectView', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('ワークスペースを開いていなければ空になること', () => {
    assert.deepEqual(main.buildProjectView(createContext()), []);
  });

  it('ルートにLibrariesとTasksを件数付きで返すこと', () => {
    writeProjectConfig(root, { libraries: [{ filename: 'lib.rb' }], tasks: [] });
    const parents = main.buildProjectView(createContext({ root }));
    assert.deepEqual(parents.map((item) => [item.label, item.key, item.description, item.contextValue]), [
      ['Libraries', 'libraries', '1', 'librariesParent'],
      ['Tasks', 'tasks', '0', 'tasksParent']
    ]);
    assert.equal(parents[0].collapsibleState, 1);
  });

  it('子にファイルを位置付きで返し、開くコマンドを付けること', () => {
    writeProjectConfig(root, { tasks: [{ filename: 'a.rb' }, { filename: 'b.rb' }] });
    const context = createContext({ root });
    const children = main.buildProjectView(context, { key: 'tasks' });
    assert.deepEqual(children.map((item) => [item.label, item.key, item.index, item.contextValue]), [
      ['a.rb', 'tasks', 0, 'projectFileFirst'],
      ['b.rb', 'tasks', 1, 'projectFileLast']
    ]);
    assert.equal(children[0].command.command, 'vscode.open');
    assert.equal(children[0].command.arguments[0].fsPath, path.join(root, 'a.rb'));
  });

  it('keyの無い要素には子を返さないこと', () => {
    assert.deepEqual(main.buildProjectView(createContext({ root }), {}), []);
  });
});

describe('#refreshButtons', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('未接続ではConnectだけ押せること', () => {
    const context = createContext({ root });
    main.refreshButtons(context);
    assert.deepEqual(contextValues(context), {
      'kaniburner.connected': false,
      'kaniburner.canCompile': false, 'kaniburner.canConnect': true, 'kaniburner.canCancel': false,
      'kaniburner.canDisconnect': false, 'kaniburner.canWrite': false, 'kaniburner.canExecute': false,
      'kaniburner.canRestart': false
    });
  });

  it('実行モードではWriteとExecuteを押せないこと', async () => {
    const context = createContext({ root });
    await main.connect(context, '/dev/x', 9600);
    main.refreshButtons(context);
    const values = contextValues(context);
    assert.equal(values['kaniburner.canCompile'], false);
    assert.equal(values['kaniburner.canRestart'], true);
    assert.equal(values['kaniburner.canWrite'], false);
    assert.equal(values['kaniburner.canExecute'], false);
  });

  it('コマンドモードではWriteとExecuteを押せること', async () => {
    const context = createContext({ root, window: { activeTextEditor: { document: document('/main.rb', 'puts 1') } } });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    main.refreshButtons(context);
    const values = contextValues(context);
    assert.equal(values['kaniburner.canWrite'], true);
    assert.equal(values['kaniburner.canExecute'], true);
  });

  it('コンパイラが無ければCompile・Writeを押せないこと', async () => {
    writeProjectConfig(root, { compiler: { version: '9.9.9' } });
    const context = createContext({ root });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    main.refreshButtons(context);
    const values = contextValues(context);
    assert.equal(values['kaniburner.canCompile'], false);
    assert.equal(values['kaniburner.canWrite'], false);
    assert.equal(values['kaniburner.canExecute'], true);
  });

  it('実行中はDisconnect以外を押せないこと', async () => {
    const context = createContext({ root });
    await main.connect(context, '/dev/x', 9600);
    context.enterCommandMode();
    context.beginAction();
    main.refreshButtons(context);
    const enabled = Object.entries(contextValues(context)).filter(([key, value]) => key.startsWith('kaniburner.can') && value);
    assert.deepEqual(enabled.map(([key]) => key), ['kaniburner.canDisconnect']);
  });
});

describe('#refreshStatusBar', () => {
  it('未接続ではOfflineを表示すること', () => {
    const context = createContext();
    main.refreshStatusBar(context);
    assert.equal(context.statusBar.text, '$(debug-disconnect) kaniburner');
    assert.equal(context.statusBar.tooltip, 'kaniburner: Offline\nBoard not connected.');
  });

  it('接続・モード変更・プロトコル初期化・切断で表示を更新すること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/x', 9600);
    assert.equal(context.statusBar.text, '$(plug) kaniburner');
    assert.equal(context.statusBar.tooltip, 'kaniburner: Connected\n/dev/x (9600 baud)');
    context.enterCommandMode();
    assert.equal(context.statusBar.text, '$(terminal) kaniburner');
    assert.equal(context.statusBar.tooltip, 'kaniburner: Command\n/dev/x (9600 baud)');
    context.exitCommandMode();
    assert.equal(context.statusBar.text, '$(plug) kaniburner');
    context.enterCommandMode();
    main.resetProtocol(context);
    assert.equal(context.statusBar.text, '$(plug) kaniburner');
    const port = context.get().serialPort;
    port.receive('Kani-Board, mruby/c v3.3 start\r\n');
    assert.equal(context.statusBar.text, '$(play) kaniburner');
    context.enterCommandMode();
    assert.equal(context.get().runMode, false);
    assert.equal(context.statusBar.text, '$(terminal) kaniburner');
    port.receive('Kani-Board, mruby/c v3.3 start\r\n');
    port.receive('Kani-Board, Please push Enter key to mrbwrite mode\r\n');
    assert.equal(context.get().runMode, false);
    assert.equal(context.statusBar.text, '$(plug) kaniburner');
    port.receive('Kani-Board, mruby/c v3.3 start\r\n');
    main.resetProtocol(context);
    assert.equal(context.get().runMode, false);
    assert.equal(context.statusBar.text, '$(plug) kaniburner');
    port.receive('Kani-Board, mruby/c v3.3 start\r\n');
    context.get().serialPort.listeners.close();
    assert.equal(context.get().runMode, false);
    assert.equal(context.statusBar.text, '$(debug-disconnect) kaniburner');
    assert.equal(context.statusBar.tooltip, 'kaniburner: Offline\nBoard not connected.');
  });
});

describe('#runAction', () => {
  it('実行中はrunningを増やし、終了後に戻すこと', async () => {
    const context = createContext();
    let during;
    await main.runAction(context, async () => { during = context.get().running; });
    assert.equal(during, 1);
    assert.equal(context.get().running, 0);
    assert.equal(context.output.shown, 1);
  });

  it('例外が起きてもrunningを戻すこと', async () => {
    const context = createContext();
    await assert.rejects(main.runAction(context, async () => { throw new Error('x'); }), { message: 'x' });
    assert.equal(context.get().running, 0);
  });
});

describe('#selectVersion', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('同梱バージョンから選ばせて保存すること', async () => {
    let shown;
    const context = createContext({ root, window: { showQuickPick: async (items) => { shown = items; return '3.4.0'; } } });
    await main.selectVersion(context);
    assert.deepEqual(shown, ['3.4.0', '4.0.0']);
    assert.equal(readProjectConfig(root).compiler.version, '3.4.0');
  });

  it('キャンセルなら保存しないこと', async () => {
    const context = createContext({ root, window: { showQuickPick: async () => undefined } });
    await main.selectVersion(context);
    assert.equal(fs.existsSync(path.join(root, '.vscode/kaniburner.json')), false);
    assert.deepEqual(context.storage.data['kaniburner.device'], {});
  });

  it('手動で選び直した場合は自動判定をOFFにすること', async () => {
    writeProjectConfig(root, { compiler: { version: '4.0.0' } });
    const context = createContext({ root, device: { autoDetect: true }, window: { showQuickPick: async () => '3.4.0' } });
    await main.selectVersion(context);
    assert.deepEqual(readProjectConfig(root).compiler, { version: '3.4.0' });
    assert.equal(context.storage.data['kaniburner.device'].autoDetect, false);
  });
});

describe('#selectBaud', () => {
  it('候補から選んだ値を保存すること', async () => {
    const context = createContext({ window: { showQuickPick: async () => '115200' } });
    await main.selectBaud(context);
    assert.equal(context.storage.data['kaniburner.device'].baud, 115200);
  });

  it('その他では入力させて保存すること', async () => {
    const context = createContext({ window: { showQuickPick: async () => 'その他...', showInputBox: async () => ' 57600 ' } });
    await main.selectBaud(context);
    assert.equal(context.storage.data['kaniburner.device'].baud, 57600);
  });

  it('入力は正の整数だけを受け付けること', async () => {
    let validate;
    const context = createContext({ window: {
      showQuickPick: async () => 'その他...',
      showInputBox: async (options) => { validate = options.validateInput; return undefined; }
    } });
    await main.selectBaud(context);
    assert.equal(validate('57600'), null);
    assert.equal(validate('0'), '正の整数を入力してください');
    assert.equal(validate('abc'), '正の整数を入力してください');
    assert.equal(context.storage.data['kaniburner.device'].baud, undefined);
  });
});

describe('#addProjectFile', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('URIが渡されれば未登録のものを追加すること', async () => {
    writeProjectConfig(root, { tasks: [{ filename: 'a.rb' }] });
    const context = createContext({ root });
    await main.addProjectFile(context, 'tasks', [new Uri(path.join(root, 'a.rb')), new Uri(path.join(root, 'b.rb'))]);
    assert.deepEqual(readProjectConfig(root).tasks, [{ filename: 'a.rb' }, { filename: 'b.rb' }]);
  });

  it('フォルダのURIなら配下の.rbファイルを追加すること', async () => {
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib/a.rb'), '');
    fs.writeFileSync(path.join(root, 'lib/b.txt'), '');
    const context = createContext({ root });
    await main.addProjectFile(context, 'libraries', [new Uri(path.join(root, 'lib'))]);
    assert.deepEqual(readProjectConfig(root).libraries, [{ filename: path.join('lib', 'a.rb') }]);
  });

  it('追加できるURIが無ければ知らせること', async () => {
    const messages = [];
    const context = createContext({ root, window: { showInformationMessage: (message) => messages.push(message) } });
    await main.addProjectFile(context, 'tasks', [new Uri(path.join(root, 'a.txt'))]);
    assert.deepEqual(messages, ['kaniburner: 追加できる .rb ファイルがありません。']);
  });

  it('URIが無ければ開いているタブから選ばせること', async () => {
    let shown;
    const context = createContext({ root, window: {
      tabGroups: { all: [{ tabs: [{ input: { uri: new Uri(path.join(root, 'lib.rb')) } }] }] },
      showQuickPick: async (items, options) => { shown = [items, options.title]; return items[0]; }
    } });
    await main.addProjectFile(context, 'libraries', []);
    assert.deepEqual(shown, [['lib.rb'], 'kaniburner: Add library']);
    assert.deepEqual(readProjectConfig(root).libraries, [{ filename: 'lib.rb' }]);
  });

  it('未登録のタブが無ければ知らせること', async () => {
    const messages = [];
    const context = createContext({ root, window: {
      tabGroups: { all: [] },
      showInformationMessage: (message) => messages.push(message)
    } });
    await main.addProjectFile(context, 'tasks', []);
    assert.deepEqual(messages, ['kaniburner: 追加できる未登録の .rb タブがありません。']);
  });
});

describe('#expandDirectories', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('ディレクトリを配下の.rbファイルへ再帰的に展開すること', () => {
    fs.mkdirSync(path.join(root, 'lib/sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib/b.rb'), '');
    fs.writeFileSync(path.join(root, 'lib/a.rb'), '');
    fs.writeFileSync(path.join(root, 'lib/note.txt'), '');
    fs.writeFileSync(path.join(root, 'lib/sub/c.rb'), '');
    const uris = main.expandDirectories(createContext({ root }), [new Uri(path.join(root, 'lib'))]);
    assert.deepEqual(uris.map((uri) => path.relative(root, uri.fsPath)), [
      path.join('lib', 'a.rb'), path.join('lib', 'b.rb'), path.join('lib', 'sub', 'c.rb')
    ]);
  });

  it('ファイルのURIはそのまま返すこと', () => {
    fs.writeFileSync(path.join(root, 'a.rb'), '');
    const uri = new Uri(path.join(root, 'a.rb'));
    assert.deepEqual(main.expandDirectories(createContext({ root }), [uri]), [uri]);
  });
});

describe('#uriArguments', () => {
  it('複数選択の配列からURIだけを返すこと', () => {
    const context = createContext();
    const uris = main.uriArguments(context, new Uri('/a.rb'), [new Uri('/a.rb'), 'x', new Uri('/b.rb')]);
    assert.deepEqual(uris.map((uri) => uri.fsPath), ['/a.rb', '/b.rb']);
  });

  it('単一のURIを配列にすること', () => {
    const uris = main.uriArguments(createContext(), new Uri('/a.rb'), undefined);
    assert.deepEqual(uris.map((uri) => uri.fsPath), ['/a.rb']);
  });

  it('URI以外なら空になること', () => {
    assert.deepEqual(main.uriArguments(createContext(), { key: 'tasks' }, undefined), []);
  });
});

describe('#activate', () => {
  it('登録された操作でコンパイル・接続・設定変更・書き込みを行えること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const root = makeWorkspace();
    t.after(() => fs.rmSync(root, { recursive: true }));
    for (const version of ['3.4.0', '4.0.0']) installMrbc(path.join(root, 'media', `mruby-${version}`));
    let reply = true;
    const context = createContext({ root, extensionPath: root, device: { port: '/dev/x' },
      SerialPort: createSerialPort({ device: (text) => reply ? mrbwriteDevice(text) : '' }), window: {
      activeTextEditor: { document: document(path.join(root, 'main.rb'), 'task') }
    } });
    const api = context.vscode;
    const registered = new Map();
    const disposable = { dispose() {} };
    let deviceProvider, changeCheckbox;
    context.output.dispose = () => {};
    api.window.createOutputChannel = () => context.output;
    api.window.createStatusBarItem = (id, alignment) => {
      assert.equal(id, 'kaniburner.connection');
      assert.equal(alignment, api.StatusBarAlignment.Left);
      return context.statusBar;
    };
    api.window.onDidChangeActiveTextEditor = () => disposable;
    api.window.registerTreeDataProvider = () => disposable;
    api.window.createTreeView = (_, { treeDataProvider }) => {
      deviceProvider = treeDataProvider;
      return { ...disposable, onDidChangeCheckboxState: (handler) => { changeCheckbox = handler; return disposable; } };
    };
    api.workspace.createFileSystemWatcher = () => ({
      ...disposable, onDidChange: () => disposable, onDidCreate: () => disposable, onDidDelete: () => disposable
    });
    api.commands.registerCommand = (id, handler) => { registered.set(id, handler); return disposable; };
    const Module = require('node:module');
    const load = Module._load;
    t.mock.method(Module, '_load', function (id, ...args) {
      if (id === 'vscode') return api;
      if (id === 'serialport') return { SerialPort: context.SerialPort };
      return load.call(this, id, ...args);
    });
    const extensionContext = { extensionPath: root, workspaceState: context.storage, subscriptions: [] };
    main.activate(extensionContext);
    assert.equal(context.statusBar.name, 'kaniburner');
    assert.deepEqual(context.statusBar.command, {
      command: 'workbench.action.quickOpen', title: 'kaniburner commands', arguments: ['>kaniburner: ']
    });
    assert.equal(context.statusBar.shown, 1);
    assert.equal(context.statusBar.text, '$(debug-disconnect) kaniburner');
    assert.ok(extensionContext.subscriptions.includes(context.statusBar));
    t.after(async () => {
      await main.deactivate();
      for (const subscription of extensionContext.subscriptions) subscription.dispose();
    });
    const manifest = require('../package.json');
    assert.deepEqual([...registered.keys()].sort(), manifest.contributes.commands.map(({ command }) => command).sort());
    assert.equal(registered.has('kaniburner.executeAll'), false);
    const item = (contextValue) => deviceProvider.getChildren().find((entry) => entry.contextValue === contextValue);
    assert.equal(item('deviceAutoConnect').checkboxState, 0);
    assert.equal(item('deviceAutoDetect').checkboxState.state, 1);
    assert.equal(item('deviceAutoVerify').checkboxState, 1);
    const list = t.mock.method(context.SerialPort, 'list');
    await advance(t, 1000);
    assert.equal(list.mock.callCount(), 0);
    changeCheckbox({ items: [[item('deviceAutoConnect'), 1]] });
    assert.equal(item('deviceAutoConnect').checkboxState, 1);
    assert.deepEqual(context.storage.data['kaniburner.device'], { port: '/dev/x' });
    changeCheckbox({ items: [[item('deviceAutoConnect'), 0]] });
    assert.equal(item('deviceAutoConnect').checkboxState, 0);
    assert.equal(registered.has('kaniburner.compile'), false);
    await registered.get('kaniburner.write')();
    assert.equal(context.SerialPort.instances.length, 0);

    const connection = registered.get('kaniburner.connect')();
    await advance(t, 1000);
    await connection;
    assert.equal(contextValues(context)['kaniburner.connected'], true);
    assert.equal(context.statusBar.text, '$(terminal) kaniburner');
    assert.equal(contextValues(context)['kaniburner.canCompile'], false);
    assert.equal(contextValues(context)['kaniburner.canWrite'], true);
    assert.equal(item('deviceVmVersion').description, 'v3.3');
    changeCheckbox({ items: [[item('deviceAutoDetect'), 0], [item('deviceAutoVerify'), 0]] });
    assert.equal(context.storage.data['kaniburner.device'].autoDetect, false);
    assert.equal(context.storage.data['kaniburner.device'].autoVerify, false);
    assert.equal(item('deviceVersion').description, '4.0.0');
    changeCheckbox({ items: [[item('deviceAutoDetect'), 1], [item('deviceAutoVerify'), 1]] });
    assert.equal(context.storage.data['kaniburner.device'].autoDetect, true);
    assert.equal(context.storage.data['kaniburner.device'].autoVerify, true);
    assert.equal(context.storage.data['kaniburner.device'].autoConnect, undefined);
    assert.equal(fs.existsSync(path.join(root, '.vscode/kaniburner.json')), false);
    assert.equal(item('deviceVersion').description, '3.4.0');
    await registered.get('kaniburner.write')();
    const port = context.SerialPort.instances[0];
    assert.match(port.written.at(-2), /^write 4 [0-9a-f]{4}\r\n$/);
    assert.equal(port.written.at(-1), 'task');
    assert.ok(!port.written.includes('execute\r\n'));
    await registered.get('kaniburner.disconnect')();
    assert.equal(contextValues(context)['kaniburner.canCompile'], false);
    assert.equal(contextValues(context)['kaniburner.canWrite'], false);
    assert.equal(item('deviceVmVersion').description, '(not connected)');
    assert.equal(context.statusBar.text, '$(debug-disconnect) kaniburner');

    reply = false;
    const retry = registered.get('kaniburner.connect')();
    await flush();
    const probingPort = context.SerialPort.instances.at(-1);
    assert.equal(contextValues(context)['kaniburner.canCancel'], true);
    assert.equal(contextValues(context)['kaniburner.canDisconnect'], false);
    await registered.get('kaniburner.disconnect')();
    assert.equal(probingPort.closed, false);
    assert.equal(contextValues(context)['kaniburner.connected'], true);
    registered.get('kaniburner.cancel')();
    assert.equal(await retry, undefined);
    assert.equal(contextValues(context)['kaniburner.canCancel'], false);
    assert.equal(contextValues(context)['kaniburner.canDisconnect'], true);
    await registered.get('kaniburner.disconnect')();
    assert.equal(probingPort.closed, true);
    assert.equal(contextValues(context)['kaniburner.connected'], false);
  });
});
