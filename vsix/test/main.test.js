const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const main = require('../out/main.js');
const { createContext, contextValues, createSerialPort, EventEmitter, Uri, advance, flush, makeWorkspace, readProjectConfig, writeProjectConfig } = require('./helpers');

const encode = (text) => new TextEncoder().encode(text);

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
    assert.equal(context.pending, '+OK sec');
  });

  it('分割して届いた行をつなげること', async () => {
    main.feed(context, encode('+O'));
    const response = main.waitForResponse(context);
    main.feed(context, encode('K done\r\n'));
    assert.equal(await response, '+OK done');
    assert.equal(context.pending, '');
  });

  it('未完の行でもコマンドモードを検出すること', () => {
    main.feed(context, encode('+OK mruby/c'));
    assert.equal(context.commandMode, true);
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
      assert.equal(context.responseResolve, null);
    });
  }

  it('部分行では応答を解決しないこと', () => {
    main.waitForResponse(context);
    main.handleLine(context, '+OK x', true);
    assert.notEqual(context.responseResolve, null);
  });

  it('応答以外の行では解決しないこと', () => {
    main.waitForResponse(context);
    main.handleLine(context, 'hello', false);
    assert.notEqual(context.responseResolve, null);
  });
});

describe('#checkCommandModePatterns', () => {
  let context;
  beforeEach(() => { context = createContext(); });

  it('+OK mruby/cでコマンドモードに入りビューを更新すること', () => {
    main.checkCommandModePatterns(context, '+OK mruby/c v3');
    assert.equal(context.commandMode, true);
    assert.ok(context.output.lines.includes('[info]  Command mode entered.'));
    assert.ok(context.vscode.commands.calls.length > 0);
  });

  it('execute後の+OKでコマンドモードを抜けること', () => {
    context.commandMode = true;
    context.lastCommand = 'execute';
    main.checkCommandModePatterns(context, '+OK Execute');
    assert.equal(context.commandMode, false);
    assert.equal(context.lastCommand, null);
    assert.ok(context.output.lines.includes('[info]  Command mode exited.'));
  });

  it('execute以外の+OKではコマンドモードを維持すること', () => {
    context.commandMode = true;
    context.lastCommand = null;
    main.checkCommandModePatterns(context, '+OK');
    assert.equal(context.commandMode, true);
  });

  it('コマンドモード中の+OK mruby/cでは抜けないこと', () => {
    context.commandMode = true;
    context.lastCommand = 'execute';
    main.checkCommandModePatterns(context, '+OK mruby/c v3');
    assert.equal(context.commandMode, true);
  });
});

describe('#resetProtocol', () => {
  it('状態を初期化し、待機中の応答をnullで解決すること', async () => {
    const context = createContext();
    context.pending = 'x';
    context.commandMode = true;
    context.lastCommand = 'execute';
    const response = main.waitForResponse(context);
    main.resetProtocol(context);
    assert.equal(await response, null);
    assert.deepEqual(
      [context.pending, context.commandMode, context.lastCommand, context.responseResolve],
      ['', false, null, null]
    );
  });
});

describe('#waitForResponse', () => {
  it('タイムアウトするとnullを返すこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const context = createContext();
    const response = main.waitForResponse(context, 5000);
    await advance(t, 5000);
    assert.equal(await response, null);
    assert.equal(context.responseResolve, null);
  });

  it('解決後はタイマーを止めること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
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
    assert.deepEqual(context.serialPort.written, ['clear\r\n']);
    assert.ok(context.output.lines.includes('[info]  > clear'));
  });

  it('ignoreResponseでは応答を待たずnullを返すこと', async () => {
    assert.equal(await main.sendCommand(context, 'execute', { ignoreResponse: true }), null);
    assert.equal(context.responseResolve, null);
  });
});

describe('#ensureCommandMode', () => {
  it('既にコマンドモードなら何も送らずtrueを返すこと', async () => {
    const context = createContext();
    context.commandMode = true;
    assert.equal(await main.ensureCommandMode(context), true);
    assert.equal(context.output.lines.length, 0);
  });

  it('CRLFを送ってコマンドモードに入ること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    const result = main.ensureCommandMode(context, 3);
    await advance(t, 1000);
    assert.equal(await result, true);
    assert.deepEqual(context.serialPort.written, ['\r\n']);
  });

  it('再試行を使い切るとfalseを返すこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const context = createContext({ SerialPort: createSerialPort({ device: () => '' }) });
    await main.connect(context, '/dev/fake', 9600);
    const result = main.ensureCommandMode(context, 2);
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await result, false);
    assert.deepEqual(context.serialPort.written, ['\r\n', '\r\n']);
    assert.ok(context.output.lines.includes('[error] Command mode transition timed out (2s).'));
  });

  it('送信に失敗するとfalseを返すこと', async () => {
    const context = createContext();
    assert.equal(await main.ensureCommandMode(context, 3), false);
    assert.ok(context.output.lines.includes('[error] Send error: Not connected'));
  });
});

describe('#writeBytecodes', () => {
  let context;
  beforeEach(async () => {
    context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    context.commandMode = true;
  });

  it('tasksが空ならfalseを返すこと', async () => {
    assert.equal(await main.writeBytecodes(context, { libraries: [], tasks: [] }), false);
  });

  it('clear、writeコマンド、バイナリの順に送ること', async () => {
    const result = await main.writeBytecodes(context, { libraries: [], tasks: [new Uint8Array([1, 2, 3])] });
    assert.equal(result, true);
    assert.deepEqual(context.serialPort.written, ['clear\r\n', 'write 3 a408\r\n', '\x01\x02\x03']);
    assert.ok(context.output.lines.includes('[info]  Write completed.'));
  });

  it('librariesをwrite_libでtasksより先に送ること', async () => {
    await main.writeBytecodes(context, { libraries: [new Uint8Array([9])], tasks: [new Uint8Array([1])] });
    const commands = context.serialPort.written.filter((text) => text.startsWith('write'));
    assert.deepEqual(commands.map((text) => text.split(' ')[0]), ['write_lib', 'write']);
  });

  it('clearが失敗するとfalseを返すこと', async () => {
    context = createContext({ SerialPort: createSerialPort({ device: () => '-ERR\r\n' }) });
    await main.connect(context, '/dev/fake', 9600);
    context.commandMode = true;
    assert.equal(await main.writeBytecodes(context, { libraries: [], tasks: [new Uint8Array([1])] }), false);
    assert.ok(context.output.lines.includes('[error] clear failed: -ERR'));
  });

  it('バイナリ送信後に-ERRが返るとfalseを返すこと', async () => {
    const device = (text) => (text.startsWith('clear') ? '+OK\r\n' : text.startsWith('write') ? '+OK Write bytecode\r\n' : '-ERR crc\r\n');
    context = createContext({ SerialPort: createSerialPort({ device }) });
    await main.connect(context, '/dev/fake', 9600);
    context.commandMode = true;
    assert.equal(await main.writeBytecodes(context, { libraries: [], tasks: [new Uint8Array([1])] }), false);
    assert.ok(context.output.lines.includes('[error] Write failed: -ERR crc'));
  });

  it('+DONEが返らないとfalseを返すこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const device = (text) => (text.startsWith('clear') ? '+OK\r\n' : text.startsWith('write') ? '+OK Write bytecode\r\n' : '');
    context = createContext({ SerialPort: createSerialPort({ device }) });
    await main.connect(context, '/dev/fake', 9600);
    context.commandMode = true;
    const result = main.writeBytecodes(context, { libraries: [], tasks: [new Uint8Array([1])] });
    await flush();
    await advance(t, 10000);
    assert.equal(await result, false);
    assert.ok(context.output.lines.includes('[error] Write response timeout or unexpected: null'));
  });
});

describe('#execute', () => {
  it('lastCommandをexecuteにしてexecuteを送ること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    context.commandMode = true;
    await main.execute(context);
    assert.deepEqual(context.serialPort.written, ['execute\r\n']);
    assert.equal(context.commandMode, false);
  });
});

describe('#connect', () => {
  it('ポートを開いてserialPortに保持すること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    assert.equal(context.serialPort.path, '/dev/fake');
    assert.equal(context.serialPort.baudRate, 9600);
    assert.equal(main.connected(context), true);
  });

  it('受信データをプロトコルへ渡すこと', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    context.serialPort.receive('+OK mruby/c');
    assert.equal(context.commandMode, true);
    assert.equal(context.output.text, '+OK mruby/c');
  });

  it('開けなかった場合はrejectし、未接続のままにすること', async () => {
    const context = createContext({ SerialPort: createSerialPort({ openError: new Error('busy') }) });
    await assert.rejects(main.connect(context, '/dev/fake', 9600), { message: 'busy' });
    assert.equal(main.connected(context), false);
  });
});

describe('#onClose', () => {
  it('接続中なら切断状態にしてプロトコルを初期化すること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    context.commandMode = true;
    main.onClose(context);
    assert.equal(main.connected(context), false);
    assert.equal(context.commandMode, false);
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
    const port = context.serialPort;
    context.commandMode = true;
    await main.disconnect(context);
    assert.equal(port.closed, true);
    assert.equal(main.connected(context), false);
    assert.equal(context.commandMode, false);
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
    assert.deepEqual(context.serialPort.written, ['AB']);
  });
});

describe('#sendBreak', () => {
  it('BREAKをオンにしてからオフにすること', async () => {
    const context = createContext();
    await main.connect(context, '/dev/fake', 9600);
    await main.sendBreak(context);
    assert.deepEqual(context.serialPort.sets, [{ brk: true }, { brk: false }]);
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
    assert.equal(context.mrbcDirectory, path.join(root, 'a'));
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
    assert.equal(context.mrbcDirectory, path.join(root, 'b'));
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
      version: '4.0.0', port: null, baud: 115200, libraries: [], tasks: []
    });
  });

  it('保存された設定を返すこと', () => {
    writeProjectConfig(root, { compiler: { version: '3.4.0' }, libraries: [{ filename: 'lib.rb' }], tasks: [{ filename: 'main.rb' }] });
    const context = createContext({ root, device: { port: '/dev/x', baud: 9600 } });
    assert.deepEqual(main.getSettings(context), {
      version: '3.4.0', port: '/dev/x', baud: 9600, libraries: [{ filename: 'lib.rb' }], tasks: [{ filename: 'main.rb' }]
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

describe('#updateVersion', () => {
  let root;
  beforeEach(() => { root = makeWorkspace(); });
  afterEach(() => fs.rmSync(root, { recursive: true }));

  it('compiler.versionを書き込みビューを更新すること', () => {
    const context = createContext({ root });
    main.updateVersion(context, '3.4.0');
    assert.deepEqual(readProjectConfig(root), { compiler: { version: '3.4.0' } });
    assert.ok(context.vscode.commands.calls.length > 0);
  });

  it('他のキーを保持すること', () => {
    writeProjectConfig(root, { tasks: [{ filename: 'main.rb' }] });
    const context = createContext({ root });
    main.updateVersion(context, '3.4.0');
    assert.deepEqual(readProjectConfig(root), { tasks: [{ filename: 'main.rb' }], compiler: { version: '3.4.0' } });
  });

  it('ワークスペースを開いていなければ警告すること', () => {
    const warnings = [];
    const context = createContext({ window: { showWarningMessage: (message) => warnings.push(message) } });
    main.updateVersion(context, '3.4.0');
    assert.deepEqual(warnings, ['Kaniburner: プロジェクト設定を保存するにはフォルダを開いてください。']);
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
    main.rememberEditor(context, { document: document('/a.rb') });
    assert.equal(context.lastRubyDocument.fileName, '/a.rb');
  });

  it('.rb以外やエディタ無しでは記憶を変えないこと', () => {
    const context = createContext();
    main.rememberEditor(context, { document: document('/a.rb') });
    main.rememberEditor(context, { document: document('/b.txt') });
    main.rememberEditor(context, undefined);
    assert.equal(context.lastRubyDocument.fileName, '/a.rb');
  });
});

describe('#activeRubyDocument', () => {
  it('アクティブな.rbを優先すること', () => {
    const context = createContext({ window: { activeTextEditor: { document: document('/active.rb') } } });
    context.lastRubyDocument = document('/last.rb');
    assert.equal(main.activeRubyDocument(context).fileName, '/active.rb');
  });

  it('アクティブが.rbでなければ記憶したものを返すこと', () => {
    const context = createContext({ window: { activeTextEditor: { document: document('/a.txt') } } });
    context.lastRubyDocument = document('/last.rb');
    assert.equal(main.activeRubyDocument(context).fileName, '/last.rb');
  });

  it('記憶したものが閉じていれば表示中の.rbを返すこと', () => {
    const context = createContext({ window: {
      activeTextEditor: undefined,
      visibleTextEditors: [{ document: document('/v.txt') }, { document: document('/v.rb') }]
    } });
    context.lastRubyDocument = document('/last.rb', '', true);
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
    assert.deepEqual(warnings, ['Kaniburner: tasks のファイルを開けません: missing.rb']);
  });

  it('ワークスペースを開いていなければ警告してnullを返すこと', () => {
    const warnings = [];
    const context = createContext({ window: { showWarningMessage: (message) => warnings.push(message) } });
    assert.equal(main.readSources(context, [{ filename: 'a.rb' }], 'libraries'), null);
    assert.deepEqual(warnings, ['Kaniburner: libraries のファイルを開けません: a.rb']);
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
    assert.deepEqual(warnings, ['Kaniburner: .rbファイルを開いてください']);
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
    const context = createContext({ window: { showErrorMessage: (message) => errors.push(message) } });
    assert.equal(await main.pickPort(context), null);
    assert.deepEqual(errors, ['Kaniburner: No serial ports found.']);
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
    assert.equal(context.serialPort.path, '/dev/x');
    assert.equal(context.serialPort.baudRate, 115200);
    assert.ok(context.output.lines.includes('[info]  Connecting (115200 baud, /dev/x)...'));
    assert.ok(context.output.lines.includes('[info]  Connected.'));
  });

  it('ポートが未設定なら選択させること', async () => {
    const context = createContext({
      SerialPort: createSerialPort({ ports: PORTS }),
      window: { showQuickPick: async (items) => items[1] }
    });
    assert.equal(await main.ensureConnected(context), true);
    assert.equal(context.serialPort.path, '/dev/b');
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

describe('#resetAndReconnect', () => {
  it('未接続ならfalseを返すこと', async () => {
    assert.equal(await main.resetAndReconnect(createContext()), false);
  });

  it('コマンドモード中はresetを送り、再接続してコマンドモードへ入ること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ ports: [{ path: '/dev/x' }] }) });
    await main.connect(context, '/dev/x', 19200);
    const first = context.serialPort;
    context.commandMode = true;
    const result = main.resetAndReconnect(context);
    await flush();
    assert.deepEqual(first.written, ['reset\r\n']);
    first.listeners.close();
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await result, true);
    assert.notEqual(context.serialPort, first);
    assert.ok(context.output.lines.includes('[info]  Reconnected.'));
    assert.equal(context.commandMode, true);
  });

  it('実行モード中はBREAKを送ること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ ports: [{ path: '/dev/x' }] }) });
    await main.connect(context, '/dev/x', 19200);
    const first = context.serialPort;
    const result = main.resetAndReconnect(context);
    await advance(t, 100);
    assert.deepEqual(first.sets, [{ brk: true }, { brk: false }]);
    assert.ok(context.output.lines.includes('[info]  > break'));
    first.listeners.close();
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await result, true);
  });

  it('ポートが再出現しなければfalseを返すこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ ports: [] }) });
    await main.connect(context, '/dev/x', 19200);
    context.commandMode = true;
    const result = main.resetAndReconnect(context);
    await flush();
    context.serialPort.listeners.close();
    for (let second = 0; second < 30; second++) await advance(t, 1000);
    assert.equal(await result, false);
    assert.equal(context.SerialPort.instances.length, 1);
  });
});

describe('#ensureReady', () => {
  it('接続してコマンドモードへ入ること', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const context = createContext({ device: { port: '/dev/x' } });
    const result = main.ensureReady(context);
    await advance(t, 1000);
    assert.equal(await result, true);
    assert.equal(context.commandMode, true);
  });

  it('接続できなければfalseを返すこと', async () => {
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ openError: new Error('busy') }) });
    assert.equal(await main.ensureReady(context), false);
  });

  it('直接コマンドモードへ入れなければリセットして入り直すこと', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0;
    const device = (text) => (text === '\r\n' && ++attempts > 3 ? '+OK mruby/c\r\n' : '');
    const context = createContext({ device: { port: '/dev/x' }, SerialPort: createSerialPort({ ports: [{ path: '/dev/x' }], device }) });
    const result = main.ensureReady(context);
    for (let second = 0; second < 3; second++) await advance(t, 1000);
    const first = context.serialPort;
    await advance(t, 100);
    assert.deepEqual(first.sets, [{ brk: true }, { brk: false }]);
    first.listeners.close();
    await advance(t, 1000);
    await advance(t, 1000);
    assert.equal(await result, true);
    assert.equal(context.commandMode, true);
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

  it('ポート・ボーレート・バージョンの行を返すこと', () => {
    const context = createContext({ root, device: { port: '/dev/x', baud: 9600 } });
    assert.deepEqual(main.buildDeviceView(context).map((item) => [item.label, item.description, item.contextValue]), [
      ['Port', '/dev/x', 'devicePort'],
      ['Baud', '9600', 'deviceBaud'],
      ['mruby', '4.0.0', 'deviceVersion']
    ]);
  });

  it('ポート未設定なら(none)と出すこと', () => {
    assert.equal(main.buildDeviceView(createContext({ root }))[0].description, '(none)');
  });

  it('コンパイラが無いバージョンには警告を付けること', () => {
    writeProjectConfig(root, { compiler: { version: '9.9.9' } });
    const version = main.buildDeviceView(createContext({ root }))[2];
    assert.equal(version.description, '9.9.9 (not found)');
    assert.equal(version.iconPath.id, 'warning');
    assert.equal(version.iconPath.color.id, 'errorForeground');
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

  it('未接続ではConnectとCompileだけ押せること', () => {
    const context = createContext({ root });
    main.refreshButtons(context);
    assert.deepEqual(contextValues(context), {
      'kaniburner.connected': false,
      'kaniburner.canExecuteAll': false, 'kaniburner.canCompile': true, 'kaniburner.canConnect': true,
      'kaniburner.canDisconnect': false, 'kaniburner.canWrite': false, 'kaniburner.canExecute': false, 'kaniburner.canReset': false
    });
  });

  it('実行モードではWriteとExecuteを押せないこと', async () => {
    const context = createContext({ root });
    await main.connect(context, '/dev/x', 9600);
    main.refreshButtons(context);
    const values = contextValues(context);
    assert.equal(values['kaniburner.canExecuteAll'], true);
    assert.equal(values['kaniburner.canReset'], true);
    assert.equal(values['kaniburner.canWrite'], false);
    assert.equal(values['kaniburner.canExecute'], false);
  });

  it('コマンドモードではWriteとExecuteを押せること', async () => {
    const context = createContext({ root });
    await main.connect(context, '/dev/x', 9600);
    context.commandMode = true;
    main.refreshButtons(context);
    const values = contextValues(context);
    assert.equal(values['kaniburner.canWrite'], true);
    assert.equal(values['kaniburner.canExecute'], true);
  });

  it('コンパイラが無ければCompile・Write・ExecuteAllを押せないこと', async () => {
    writeProjectConfig(root, { compiler: { version: '9.9.9' } });
    const context = createContext({ root });
    await main.connect(context, '/dev/x', 9600);
    context.commandMode = true;
    main.refreshButtons(context);
    const values = contextValues(context);
    assert.equal(values['kaniburner.canCompile'], false);
    assert.equal(values['kaniburner.canWrite'], false);
    assert.equal(values['kaniburner.canExecuteAll'], false);
    assert.equal(values['kaniburner.canExecute'], true);
  });

  it('実行中はDisconnect以外を押せないこと', async () => {
    const context = createContext({ root });
    await main.connect(context, '/dev/x', 9600);
    context.commandMode = true;
    context.running = 1;
    main.refreshButtons(context);
    const enabled = Object.entries(contextValues(context)).filter(([key, value]) => key.startsWith('kaniburner.can') && value);
    assert.deepEqual(enabled.map(([key]) => key), ['kaniburner.canDisconnect']);
  });
});

describe('#runAction', () => {
  it('実行中はrunningを増やし、終了後に戻すこと', async () => {
    const context = createContext();
    let during;
    await main.runAction(context, async () => { during = context.running; });
    assert.equal(during, 1);
    assert.equal(context.running, 0);
    assert.equal(context.output.shown, 1);
  });

  it('例外が起きてもrunningを戻すこと', async () => {
    const context = createContext();
    await assert.rejects(main.runAction(context, async () => { throw new Error('x'); }), { message: 'x' });
    assert.equal(context.running, 0);
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
    assert.deepEqual(messages, ['Kaniburner: 追加できる .rb ファイルがありません。']);
  });

  it('URIが無ければ開いているタブから選ばせること', async () => {
    let shown;
    const context = createContext({ root, window: {
      tabGroups: { all: [{ tabs: [{ input: { uri: new Uri(path.join(root, 'lib.rb')) } }] }] },
      showQuickPick: async (items, options) => { shown = [items, options.title]; return items[0]; }
    } });
    await main.addProjectFile(context, 'libraries', []);
    assert.deepEqual(shown, [['lib.rb'], 'Kaniburner: Add library']);
    assert.deepEqual(readProjectConfig(root).libraries, [{ filename: 'lib.rb' }]);
  });

  it('未登録のタブが無ければ知らせること', async () => {
    const messages = [];
    const context = createContext({ root, window: {
      tabGroups: { all: [] },
      showInformationMessage: (message) => messages.push(message)
    } });
    await main.addProjectFile(context, 'tasks', []);
    assert.deepEqual(messages, ['Kaniburner: 追加できる未登録の .rb タブがありません。']);
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
