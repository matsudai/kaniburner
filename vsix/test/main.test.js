const { describe, it } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const main = require('../out/main.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function createClock() {
  let time = 0, next = 0;
  const timers = new Map();
  return {
    timers,
    now: () => time,
    setTimeout(callback, milliseconds) {
      const id = ++next;
      timers.set(id, { time: time + milliseconds, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(milliseconds) {
      await flush();
      const end = time + milliseconds;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.time <= end)
          .sort((a, b) => a[1].time - b[1].time || a[0] - b[0])[0];
        if (!due) break;
        time = due[1].time;
        timers.delete(due[0]);
        due[1].callback();
        await flush();
      }
      time = end;
      await flush();
    }
  };
}

function mrbwriteDevice(text) {
  if (text === '\r\n') return '+OK mruby/c\r\n';
  if (text === 'version\r\n') return '+OK mruby/c v3.3 RITE0300 MRBW1.2\r\n';
  if (text === 'clear\r\n' || text === 'reset\r\n') return '+OK\r\n';
  if (text.startsWith('write')) return '+OK Write bytecode\r\n';
  if (text === 'execute\r\n') return '+OK Execute\r\n';
  return '+DONE\r\n';
}

function createSerial(options = {}) {
  const serial = {
    instances: [], listCalls: 0,
    ports: options.ports ?? [{ path: '/dev/x' }],
    device: options.device ?? mrbwriteDevice,
    async list() { this.listCalls++; return this.ports; },
    create(portPath, baudRate, callback) {
      const port = new EventEmitter();
      Object.assign(port, {
        path: portPath, baudRate, isOpen: false, written: [], sets: [], closes: 0, drains: 0,
        receive(data) { this.emit('data', Buffer.from(data)); },
        unplug() { this.isOpen = false; this.emit('close'); },
        opened(error = null) { this.isOpen = !error; callback(error); },
        write(data, done) {
          const buffer = Buffer.from(data);
          this.written.push(buffer);
          if (options.write) return options.write(this, buffer, done);
          done(null);
          if (buffer.length) {
            const reply = serial.device(buffer.toString('latin1'), this);
            if (reply) this.receive(reply);
          }
        },
        set(signals, done) {
          this.sets.push(signals);
          if (options.set) return options.set(this, signals, done);
          done(null);
        },
        drain(done) {
          this.drains++;
          if (options.drain) return options.drain(this, done);
          done(null);
        },
        close(done = () => {}) {
          this.closes++;
          if (options.close) return options.close(this, done);
          this.isOpen = false;
          done(null);
          this.emit('close');
        }
      });
      this.instances.push(port);
      if (!options.manualOpen) queueMicrotask(() => port.opened(options.openError));
      return port;
    }
  };
  return serial;
}

function createHarness(options = {}) {
  const clock = createClock();
  const serial = options.serial ?? createSerial(options.serialOptions);
  const output = { text: '', lines: [], shown: 0, actions: 0, notices: [], renders: [], disposed: 0 };
  const storage = { device: options.device ?? { port: '/dev/x' }, config: options.config ?? {} };
  const compiled = [];
  const host = {
    append(text) { output.text += text; },
    appendLine(line) { output.lines.push(line); },
    showOutput() { output.shown++; },
    beginAction() { output.actions++; },
    notify(...args) { output.notices.push(args); },
    readRubySource: () => options.source ?? null,
    workspaceRoot: () => options.root ?? null,
    readDeviceConfig: () => storage.device,
    writeDeviceConfig(config) { storage.device = config; },
    pickPort: async () => null,
    pickVersion: async () => null,
    pickBaud: async () => null,
    inputBaud: async () => null,
    pickFile: async () => null,
    openFilePaths: () => [],
    render(...args) { output.renders.push(args); },
    dispose() { output.disposed++; },
    ...options.host
  };
  const project = {
    readConfig: () => storage.config,
    writeConfig(config) { storage.config = config; },
    readFile(filename) {
      if (!(filename in (options.files ?? {}))) throw new Error('ENOENT');
      return options.files[filename];
    },
    expandPaths: (paths) => paths,
    ...options.project
  };
  const compiler = options.compiler ?? {
    async compile(directory, source) {
      compiled.push({ directory, source });
      return new Uint8Array(Buffer.from(source));
    }
  };
  const context = main.buildContext({ host, serial, clock, project, compiler, extensionPath: '/ext' });
  return {
    context, host, serial, clock, output, storage, project, compiled,
    get port() { return serial.instances.at(-1); },
    async ready() {
      const result = main.connectDevice(context);
      await clock.advance(1000);
      assert.equal(await result, true);
      assert.equal(context.get().mode, 'command');
      return serial.instances.at(-1);
    }
  };
}

const texts = (port) => port.written.filter((buffer) => buffer.length).map((buffer) => buffer.toString('latin1'));
const BOOT = 'Kani-Board, Please push Enter key to mrbwrite mode\r\n';
const RUN = 'Kani-Board, mruby/c task start\r\n';



describe('接続の状態遷移', () => {
  it('一覧が遅くても30回目の出現で接続できること', async () => {
    const h = createHarness();
    let calls = 0;
    h.serial.list = () => new Promise((resolve) => h.clock.setTimeout(() => resolve(++calls === 30 ? [{ path: '/dev/x' }] : []), 2000));
    const result = main.connectDevice(h.context);
    await h.clock.advance(61000);
    assert.equal(await result, true);
    assert.equal(calls, 30);
  });

  it('probeと再openを往復しても試行上限を共有すること', async () => {
    const h = createHarness({ serialOptions: { device: (text, port) => { port.unplug(); return ''; } } });
    const result = main.connectDevice(h.context);
    await h.clock.advance(30000);
    assert.equal(await result, false);
    assert.equal(h.serial.instances.length, 30);
    assert.equal(h.context.get().operation, null);
  });

  it('確立応答で再送を止め、送信完了から1秒後にversionを送ること', async () => {
    const h = createHarness();
    const result = main.connectDevice(h.context);
    await flush();
    assert.equal(h.context.get().mode, 'command');
    assert.equal(h.context.get().operation.phase, 'info');
    assert.equal(main.canAction(h.context, 'Cancel'), false);
    await h.clock.advance(999);
    assert.deepEqual(texts(h.port), ['\r\n']);
    await h.clock.advance(1);
    assert.equal(await result, true);
    assert.deepEqual(texts(h.port), ['\r\n', 'version\r\n']);
    assert.deepEqual(h.context.get().boardInfo, { mrubyc: 'v3.3', rite: 'RITE0300', error: null });
    assert.equal(h.context.get().operation, null);
    assert.equal(h.clock.timers.size, 0);
  });

  it('周期送信の間に確立応答を受けるとCancelを無効にし再送せず完了すること', async () => {
    const h = createHarness({ serialOptions: { device: (text) => text === '\r\n' ? '' : mrbwriteDevice(text) } });
    const result = main.connectDevice(h.context);
    await h.clock.advance(2500);
    assert.deepEqual(texts(h.port), ['\r\n', '\r\n', '\r\n']);
    assert.equal(main.canAction(h.context, 'Cancel'), true);
    h.port.receive('+OK mruby/c\r\n');
    assert.equal(h.context.get().mode, 'command');
    assert.equal(main.canAction(h.context, 'Cancel'), false);
    await h.clock.advance(499);
    assert.deepEqual(texts(h.port), ['\r\n', '\r\n', '\r\n']);
    await h.clock.advance(1);
    assert.equal(await result, true);
    assert.deepEqual(texts(h.port), ['\r\n', '\r\n', '\r\n', 'version\r\n']);
    assert.equal(h.clock.timers.size, 0);
  });

  it('応答のないCRLFも送信完了前には重ねずCancelで止まること', async () => {
    let written;
    const h = createHarness({ serialOptions: { write(port, bytes, callback) { written = callback; } } });
    const result = main.connectDevice(h.context);
    await h.clock.advance(4000);
    assert.deepEqual(texts(h.port), ['\r\n']);
    written(null);
    await h.clock.advance(999);
    assert.deepEqual(texts(h.port), ['\r\n']);
    main.cancelConnection(h.context);
    assert.equal(await result, false);
    await h.clock.advance(10000);
    assert.deepEqual(texts(h.port), ['\r\n']);
    assert.equal(h.clock.timers.size, 0);
  });

  for (const pending of [false, true]) {
    it(`確立応答後の再起動では送信完了${pending ? '前' : '後'}でも再試行すること`, async () => {
      let written;
      const h = createHarness({ serialOptions: { write(port, bytes, callback) {
        if (!written && bytes.toString() === '\r\n') {
          written = callback;
          if (!pending) callback(null);
          port.receive('+OK mruby/c\r\n');
        } else { callback(null); if (bytes.length) port.receive(mrbwriteDevice(bytes.toString())); }
      } } });
      const result = main.connectDevice(h.context);
      await h.clock.advance(500);
      h.port.receive(BOOT);
      assert.equal(h.context.get().mode, 'unknown');
      assert.equal(main.canAction(h.context, 'Cancel'), true);
      if (pending) {
        await h.clock.advance(1500);
        assert.deepEqual(texts(h.port), ['\r\n']);
        written(null);
      }
      await h.clock.advance(2000);
      assert.equal(await result, true);
      assert.deepEqual(texts(h.port), ['\r\n', '\r\n', 'version\r\n']);
      assert.equal(h.clock.timers.size, 0);
    });
  }

  for (const suffix of ['', ' ', '\t']) {
    it(`完成した確立応答を受理すること ${JSON.stringify(suffix)}`, async () => {
      const h = createHarness({ serialOptions: { device: (text) => text === '\r\n' ? `+OK mruby/c${suffix}\r\n` : mrbwriteDevice(text) } });
      await h.ready();
    });
  }

  for (const text of ['+OK mruby/c', '+OK mruby/c v3.3 RITE0300\r\n', '+OK\r\n', '+DONE\r\n', 'log +OK mruby/c\r\n']) {
    it(`確立応答以外ではcommandにならないこと ${JSON.stringify(text)}`, async () => {
      const h = createHarness({ serialOptions: { device: () => '' } });
      const result = main.connectDevice(h.context);
      await flush();
      h.port.receive(text);
      assert.equal(h.context.get().mode, 'unknown');
      assert.equal(h.context.get().operation.phase, 'probing');
      main.cancelConnection(h.context);
      assert.equal(await result, false);
    });
  }

  for (let split = 1; split < '+OK mruby/c\r\n'.length; split++) {
    it(`確立応答の分割位置${split}で改行完了まで待つこと`, async () => {
      const h = createHarness({ serialOptions: { device: (text) => text === '\r\n' ? '' : mrbwriteDevice(text) } });
      const result = main.connectDevice(h.context);
      await flush();
      const ack = '+OK mruby/c\r\n';
      h.port.receive(ack.slice(0, split));
      assert.equal(h.context.get().mode, 'unknown');
      h.port.receive(ack.slice(split));
      assert.equal(h.context.get().mode, 'command');
      await h.clock.advance(1000);
      assert.equal(await result, true);
    });
  }

  it('分割versionの接頭辞を確立応答と取り違えないこと', async () => {
    const h = createHarness({ serialOptions: { device: () => '' } });
    const result = main.connectDevice(h.context);
    await flush();
    h.port.receive('+OK mruby/c');
    h.port.receive(' v3.3 RITE0300\r\n');
    await h.clock.advance(1000);
    assert.equal(h.context.get().mode, 'unknown');
    assert.deepEqual(texts(h.port), ['\r\n', '\r\n']);
    main.cancelConnection(h.context);
    await result;
  });

  it('応答がwrite callbackより先でも完了後の待機を短縮しないこと', async () => {
    let sent;
    const h = createHarness({ serialOptions: { write(port, bytes, callback) {
      if (bytes.toString() === '\r\n') { sent = callback; port.receive('+OK mruby/c\r\n'); }
      else { callback(null); if (bytes.length) port.receive(mrbwriteDevice(bytes.toString())); }
    } } });
    const result = main.connectDevice(h.context);
    await h.clock.advance(4000);
    assert.deepEqual(texts(h.port), ['\r\n']);
    sent(null);
    await h.clock.advance(999);
    assert.deepEqual(texts(h.port), ['\r\n']);
    await h.clock.advance(1);
    assert.equal(await result, true);
  });

  for (const failure of ['error', 'timeout']) {
    it(`確立応答後のwrite ${failure}では後続を送らないこと`, async () => {
      let sent;
      const h = createHarness({ serialOptions: { write(port, bytes, callback) { sent = callback; port.receive('+OK mruby/c\r\n'); } } });
      const result = main.connectDevice(h.context);
      await flush();
      if (failure === 'error') sent(new Error('write failed'));
      else await h.clock.advance(5000);
      assert.equal(await result, false);
      assert.equal(h.context.get().mode, 'unknown');
      assert.equal(h.context.get().operation, null);
      assert.deepEqual(texts(h.port), ['\r\n']);
    });
  }

  for (const failure of ['absent', 'list', 'open', 'probe', 'write']) {
    it(`${failure}の試行は合計30回で終了すること`, async () => {
      const h = createHarness({ serialOptions: {
        ports: failure === 'absent' ? [] : [{ path: '/dev/x' }],
        openError: failure === 'open' ? new Error('busy') : null,
        device: () => '', ...(failure === 'write' ? { write() {} } : {})
      } });
      if (failure === 'list') h.serial.list = async () => { h.serial.listCalls++; throw new Error('denied'); };
      const result = main.connectDevice(h.context);
      await h.clock.advance(failure === 'write' ? 180000 : 30000);
      assert.equal(await result, false);
      assert.equal(['probe', 'write'].includes(failure) ? texts(h.port).length : h.serial.listCalls, 30);
      assert.equal(h.context.get().operation, null);
      assert.equal(h.clock.timers.size, 0);
    });
  }

  it('一覧取得には総期限を加えずCancelで終了できること', async () => {
    const list = deferred(), h = createHarness();
    h.serial.list = () => list.promise;
    const result = main.connectDevice(h.context);
    await h.clock.advance(60000);
    assert.equal(h.context.get().operation.phase, 'waiting');
    main.cancelConnection(h.context);
    assert.equal(await result, false);
    list.resolve([{ path: '/dev/x' }]);
    await flush();
    assert.equal(h.serial.instances.length, 0);
  });

  it('Cancelは接続を残し、自動接続・再送・遅い確立応答を無効にすること', async () => {
    const h = createHarness({ serialOptions: { device: () => '' } });
    main.setAutoConnect(h.context, true);
    const result = main.connectDevice(h.context);
    await flush();
    const connection = h.context.get().connection;
    main.cancelConnection(h.context);
    assert.equal(await result, false);
    h.port.receive('+OK mruby/c\r\n');
    await h.clock.advance(10000);
    assert.deepEqual(h.context.get().connection, connection);
    assert.equal(h.context.get().mode, 'unknown');
    assert.equal(h.context.get().autoConnect, false);
    assert.deepEqual(texts(h.port), ['\r\n']);
  });

  it('確立応答が先ならCancelしないこと', async () => {
    const h = createHarness(), result = main.connectDevice(h.context);
    await flush();
    main.cancelConnection(h.context);
    await h.clock.advance(1000);
    assert.equal(await result, true);
  });

  it('一覧待機中に設定を変えても操作の接続先を変えないこと', async () => {
    const list = deferred(), h = createHarness({ device: { port: '/dev/x', baud: 9600 } });
    h.serial.list = () => list.promise;
    const result = main.connectDevice(h.context);
    main.updateDevice(h.context, { port: '/dev/y', baud: 115200 });
    list.resolve([{ path: '/dev/x' }, { path: '/dev/y' }]);
    await h.clock.advance(1000);
    assert.equal(await result, true);
    assert.equal(h.port.path, '/dev/x');
    assert.equal(h.port.baudRate, 9600);
  });

  for (const reason of ['cancel', 'timeout']) {
    it(`${reason}後の遅いopen成功を閉じること`, async () => {
      const h = createHarness({ serialOptions: { manualOpen: true } });
      const result = main.connectDevice(h.context);
      await flush();
      const old = h.port;
      if (reason === 'timeout') await h.clock.advance(5000);
      main.cancelConnection(h.context);
      assert.equal(await result, false);
      old.opened();
      await flush();
      assert.equal(old.isOpen, false);
      assert.ok(old.closes > 0);
      assert.equal(h.context.get().connection, null);
    });
  }

  it('確立中の物理切断後は同じ接続先で再openすること', async () => {
    const h = createHarness({ serialOptions: { device: () => '' } });
    const result = main.connectDevice(h.context);
    await flush();
    h.port.unplug();
    main.updateDevice(h.context, { port: '/dev/y' });
    h.serial.device = mrbwriteDevice;
    await h.clock.advance(2000);
    assert.equal(await result, true);
    assert.equal(h.serial.instances.length, 2);
    assert.equal(h.port.path, '/dev/x');
  });

  it('version待機中の切断では操作を終了すること', async () => {
    const h = createHarness({ serialOptions: { device: (text) => text === 'version\r\n' ? '' : mrbwriteDevice(text) } });
    const result = main.connectDevice(h.context);
    await h.clock.advance(1000);
    h.port.unplug();
    assert.equal(await result, false);
    await h.clock.advance(5000);
    assert.equal(h.context.get().connection, null);
    assert.equal(h.serial.instances.length, 1);
  });

  it('古い接続のdata・close・errorで新しい接続を変更しないこと', async () => {
    const h = createHarness(), old = await h.ready();
    const callbacks = Object.fromEntries(['data', 'close', 'error'].map((event) => [event, old.listeners(event).slice()]));
    await main.disconnect(h.context);
    await h.ready();
    const state = h.context.get();
    for (const callback of callbacks.data) callback(Buffer.from(BOOT));
    for (const callback of callbacks.close) callback();
    for (const callback of callbacks.error) callback(new Error('old error'));
    assert.deepEqual(h.context.get(), state);
  });
});

describe('受信と要求の所有権', () => {
  it('openの制御信号設定が失敗した候補ポートを閉じること', async () => {
    const h = createHarness({ serialOptions: { set(port, signals, callback) { callback(new Error('set failed')); } } });
    await assert.rejects(main.connect(h.context, '/dev/x', 9600), /set failed/);
    assert.equal(h.port.isOpen, false);
    assert.equal(h.context.get().connection, null);
  });

  it('終了後の遅い制御信号設定完了でポートを採用しないこと', async () => {
    let set;
    const h = createHarness({ serialOptions: { set(port, signals, callback) { set = callback; } } });
    const connecting = main.connectDevice(h.context);
    await flush();
    main.cancelConnection(h.context);
    assert.equal(await connecting, false);
    set(null);
    await flush();
    assert.equal(h.context.get().connection, null);
    assert.equal(h.port.isOpen, false);
  });

  it('古い応答タイマーで新しい待機を解除しないこと', async () => {
    const h = createHarness();
    await main.connect(h.context, '/dev/x', 9600);
    const old = main.waitForResponse(h.context, 1000);
    h.port.receive(BOOT);
    const next = main.waitForResponse(h.context, 5000);
    await h.clock.advance(1000);
    h.port.receive('+OK\r\n');
    assert.equal(await old, null);
    assert.equal(await next, '+OK');
  });

  it('ACK受領後でもwrite callback待ちの所有者を保持すること', async () => {
    const h = createHarness();
    await h.ready();
    let sent;
    h.port.write = (buffer, callback) => { h.port.written.push(Buffer.from(buffer)); sent = callback; h.port.receive('+OK\r\n'); };
    const first = main.sendCommand(h.context, 'clear');
    await flush();
    assert.equal(await main.sendCommand(h.context, 'execute'), null);
    assert.deepEqual(texts(h.port).slice(2), ['clear\r\n']);
    sent(null);
    assert.equal(await first, '+OK');
  });

  it('通常writeは500msを越えても5秒までは完了を待つこと', async () => {
    const h = createHarness({ serialOptions: { write() {} } });
    await main.connect(h.context, '/dev/x', 9600);
    const result = assert.rejects(main.write(h.context, Uint8Array.of(1)), /timed out/);
    await h.clock.advance(4999);
    assert.equal(h.clock.timers.size, 1);
    await h.clock.advance(1);
    await result;
    assert.equal(h.clock.timers.size, 0);
  });

  for (const event of ['close', 'dispose']) {
    it(`${event}で保留writeを終端すること`, async () => {
      const h = createHarness({ serialOptions: { write() {} } });
      await main.connect(h.context, '/dev/x', 9600);
      const result = assert.rejects(main.write(h.context, Uint8Array.of(1)), /cancelled/);
      if (event === 'close') h.port.unplug();
      else await main.disposeContext(h.context);
      await result;
      assert.equal(h.clock.timers.size, 0);
    });
  }

  it('versionの送信失敗は原因を残しcommandを保つこと', async () => {
    const h = createHarness({ serialOptions: { write(port, bytes, callback) {
      if (bytes.toString() === 'version\r\n') callback(new Error('version write failed'));
      else { callback(null); if (bytes.length) port.receive(mrbwriteDevice(bytes.toString())); }
    } } });
    await h.ready();
    assert.match(h.context.get().boardInfo.error, /version write failed/);
    assert.equal(h.context.runtime.request, null);
  });

  it('実行モードではversionを送らないこと', async () => {
    const h = createHarness();
    await h.ready();
    h.port.receive(RUN);
    await main.readBoardInfo(h.context);
    assert.equal(texts(h.port).filter((text) => text === 'version\r\n').length, 1);
  });

  it('ContextごとにUTF-8の途中バイトを保持すること', async () => {
    const a = createHarness(), b = createHarness();
    await main.connect(a.context, '/dev/x', 9600);
    await main.connect(b.context, '/dev/x', 9600);
    const bytes = Buffer.from('あ');
    a.port.receive(bytes.subarray(0, 1));
    b.port.receive('B');
    a.port.receive(bytes.subarray(1));
    assert.equal(a.output.text, 'あ');
    assert.equal(b.output.text, 'B');
  });

  it('接続交換でUTF-8と未完行を持ち越さないこと', async () => {
    const h = createHarness();
    await main.connect(h.context, '/dev/x', 9600);
    h.port.receive(Buffer.from([0xe3]));
    await main.disconnect(h.context);
    await main.connect(h.context, '/dev/x', 9600);
    h.port.receive('A\r\n');
    assert.equal(h.output.text, 'A\r\n');
  });

  it('write callbackより早い応答を取りこぼさないこと', async () => {
    const h = createHarness();
    await h.ready();
    h.port.write = (buffer, callback) => { h.port.written.push(Buffer.from(buffer)); h.port.receive('+OK\r\n'); callback(null); };
    assert.equal(await main.sendCommand(h.context, 'clear'), '+OK');
    assert.equal(h.context.runtime.request, null);
    assert.equal(h.clock.timers.size, 0);
  });

  for (const reply of ['-ERR Illegal command.\r\n', '']) {
    it(`version失敗でもcommandと手動コンパイラを使えること ${JSON.stringify(reply)}`, async () => {
      const h = createHarness({ serialOptions: { device: (text) => text === 'version\r\n' ? reply : mrbwriteDevice(text) } });
      const result = main.connectDevice(h.context);
      await h.clock.advance(6000);
      assert.equal(await result, true);
      assert.equal(h.context.get().mode, 'command');
      assert.ok(h.context.get().boardInfo.error);
      assert.equal(main.resolveCompilerVersion(h.context).version, '4.0.0');
      assert.ok(main.resolveCompilerVersion(h.context).warning);
    });
  }

  it('version要求を共有し、取得済みなら再送しないこと', async () => {
    const h = createHarness({ serialOptions: { device: (text) => text === 'version\r\n' ? '' : mrbwriteDevice(text) } });
    const connection = main.connectDevice(h.context);
    await h.clock.advance(1000);
    const first = main.readBoardInfo(h.context), second = main.readBoardInfo(h.context);
    assert.equal(h.context.get().boardInfoLoading, true);
    h.port.receive('+OK mruby/c v4.0 RITE0400\r\n');
    await Promise.all([connection, first, second]);
    await main.readBoardInfo(h.context);
    assert.equal(texts(h.port).filter((text) => text === 'version\r\n').length, 1);
    assert.equal(h.context.get().boardInfo.rite, 'RITE0400');
  });

  it('version応答と再起動通知が同じchunkなら結果を破棄すること', async () => {
    const h = createHarness({ serialOptions: { device: (text) => text === 'version\r\n' ? '' : mrbwriteDevice(text) } });
    const result = main.connectDevice(h.context);
    await h.clock.advance(1000);
    h.port.receive('+OK mruby/c v3.3 RITE0300\r\n' + BOOT);
    assert.equal(await result, false);
    assert.equal(h.context.get().boardInfo, null);
    assert.equal(h.context.get().mode, 'unknown');
  });

  it('同時の別要求で応答の所有者を上書きしないこと', async () => {
    const h = createHarness();
    await h.ready();
    h.serial.device = () => '';
    const first = main.sendCommand(h.context, 'clear');
    await flush();
    const second = Promise.resolve(main.sendCommand(h.context, 'execute')).catch(() => null);
    h.port.receive('+OK\r\n');
    assert.equal(await first, '+OK');
    assert.equal(await second, null);
    assert.deepEqual(texts(h.port).slice(2), ['clear\r\n']);
  });
});


describe('書込みと実行', () => {
  it('Execute応答と終了・開始通知の全分割位置でRunを保持すること', async () => {
    const reply = '+OK Execute\r\nKani-Board, End mrbwrite mode\r\n' + RUN;
    for (let split = 1; split < reply.length; split++) {
      const h = createHarness();
      await h.ready();
      h.serial.device = () => '';
      const result = main.runAction(h.context, () => main.execute(h.context), 'execute');
      await flush();
      h.port.receive(reply.slice(0, split));
      await flush();
      h.port.receive(reply.slice(split));
      await result;
      assert.equal(h.context.get().mode, 'run', `split=${split}`);
      assert.equal(h.clock.timers.size, 0, `split=${split}`);
    }
  });

  it('CRC16の既知値に一致すること', () => {
    assert.equal(main.mrbwriteCrc16(new Uint8Array()), 0xffff);
    assert.equal(main.mrbwriteCrc16(Uint8Array.of(1, 2, 3)), 0xa408);
  });

  for (const verify of [true, false]) {
    it(`clear後にlibraries→tasksを送りCRC設定${verify}を反映すること`, async () => {
      const h = createHarness({ device: { port: '/dev/x', autoVerify: verify } });
      await h.ready();
      assert.equal(await main.writeBytecodes(h.context, { libraries: [Uint8Array.of(1, 2, 3)], tasks: [Uint8Array.of(1, 2, 3)] }), true);
      assert.deepEqual(texts(h.port).slice(2), ['clear\r\n', `write_lib 3${verify ? ' a408' : ''}\r\n`, '\x01\x02\x03', `write 3${verify ? ' a408' : ''}\r\n`, '\x01\x02\x03']);
      assert.equal(h.context.get().mode, 'command');
    });
  }

  it('tasks無しではclearを送らないこと', async () => {
    const h = createHarness();
    await h.ready();
    assert.equal(await main.writeBytecodes(h.context, { libraries: [Uint8Array.of(1)], tasks: [] }), false);
    assert.deepEqual(texts(h.port), ['\r\n', 'version\r\n']);
  });

  for (const stage of ['clear', 'write', 'binary']) {
    for (const failure of ['reject', 'boot', 'close']) {
      it(`${stage}の${failure}で後続を送らないこと`, async () => {
        const h = createHarness();
        await h.ready();
        const epoch = h.context.runtime.protocolEpoch;
        h.serial.device = (text, port) => {
          const reply = mrbwriteDevice(text);
          const matches = { clear: text === 'clear\r\n', write: text.startsWith('write'), binary: text === '\x01' };
          if (!matches[stage]) return reply;
          if (failure === 'close') { port.unplug(); return ''; }
          return failure === 'boot' ? reply + BOOT : '-ERR failed\r\n';
        };
        assert.equal(await main.writeBytecodes(h.context, { libraries: [], tasks: [Uint8Array.of(1), Uint8Array.of(2)] }), false);
        assert.equal(texts(h.port).slice(2).length, { clear: 1, write: 2, binary: 3 }[stage]);
        if (failure !== 'reject') {
          assert.ok(h.context.runtime.protocolEpoch > epoch);
          assert.equal(h.context.get().mode, 'unknown');
        }
      });
    }
  }

  it('DONEは10秒待ち、結果不明でもbinaryやCRLFを再送しないこと', async () => {
    const h = createHarness();
    await h.ready();
    h.serial.device = (text) => text === '\x01' ? '' : mrbwriteDevice(text);
    const result = main.writeBytecodes(h.context, { libraries: [], tasks: [Uint8Array.of(1)] });
    await h.clock.advance(9999);
    assert.ok(h.context.runtime.request);
    await h.clock.advance(1);
    assert.equal(await result, false);
    assert.equal(h.context.get().mode, 'unknown');
    assert.deepEqual(texts(h.port).slice(2), ['clear\r\n', 'write 1 ee76\r\n', '\x01']);
    await h.clock.advance(30000);
    assert.equal(texts(h.port).length, 5);
  });

  it('binaryのwrite callbackより早いDONEを受理すること', async () => {
    const h = createHarness();
    await h.ready();
    h.port.write = (buffer, callback) => {
      h.port.written.push(Buffer.from(buffer));
      h.port.receive(mrbwriteDevice(buffer.toString('latin1')));
      callback(null);
    };
    assert.equal(await main.writeBytecodes(h.context, { libraries: [], tasks: [Uint8Array.of(1)] }), true);
  });

  it('execute成功でRunとなりWrite・Executeを止めること', async () => {
    const h = createHarness();
    await h.ready();
    await main.execute(h.context);
    assert.equal(h.context.get().mode, 'run');
    assert.equal(main.canAction(h.context, 'Write'), false);
    assert.equal(main.canAction(h.context, 'Execute'), false);
    assert.equal(main.canAction(h.context, 'Restart'), true);
  });

  it('execute拒否ではcommandを保持し遅い+OKでRunにしないこと', async () => {
    const h = createHarness();
    await h.ready();
    h.serial.device = () => '-ERR Illegal command.\r\n';
    await main.execute(h.context);
    h.port.receive('+OK\r\n');
    assert.equal(h.context.get().mode, 'command');
  });

  it('execute待ちにversion応答を使わず5秒後unknownにすること', async () => {
    const h = createHarness();
    await h.ready();
    h.serial.device = () => '+OK mruby/c v3.3 RITE0300\r\n';
    const result = main.execute(h.context);
    await h.clock.advance(4999);
    assert.equal(main.canAction(h.context, 'Cancel'), false);
    assert.equal(main.canAction(h.context, 'Disconnect'), true);
    assert.equal(h.context.get().mode, 'command');
    await h.clock.advance(1);
    await result;
    assert.equal(h.context.get().mode, 'unknown');
  });

  for (const reply of ['+OK Execute\r\n' + BOOT, RUN, '+OK Execute\r\nKani-Board, End mrbwrite mode\r\n' + RUN]) {
    it(`execute通知のmodeを古い完了で上書きしないこと ${JSON.stringify(reply)}`, async () => {
      const h = createHarness();
      await h.ready();
      h.serial.device = () => reply;
      const result = main.execute(h.context);
      await h.clock.advance(5000);
      await result;
      assert.equal(h.context.get().mode, reply.endsWith(RUN) ? 'run' : 'unknown');
    });
  }
});

describe('Restart・Disconnect・終了', () => {
  it('reset応答と自己通知が同じchunkでも再確立すること', async () => {
    const h = createHarness();
    await h.ready();
    h.serial.device = (text) => text === 'reset\r\n' ? '+OK\r\n' + BOOT + RUN : mrbwriteDevice(text);
    const result = main.restartAndReconnect(h.context);
    await h.clock.advance(2000);
    assert.equal(await result, true);
    assert.equal(h.context.get().mode, 'command');
  });

  for (const mode of ['reset', 'break']) {
    it(`${mode}の完了前にUSBが切断されても復旧すること`, async () => {
      const h = createHarness();
      await h.ready();
      const old = h.port;
      if (mode === 'reset') old.write = () => old.unplug();
      else {
        old.receive(RUN);
        old.set = () => old.unplug();
      }
      const result = main.restartAndReconnect(h.context);
      await h.clock.advance(2000);
      assert.equal(await result, true);
      assert.equal(h.serial.instances.length, 2);
      assert.equal(h.context.get().mode, 'command');
    });
  }

  it('旧Breakの遅い解除を次のBreakに重ねないこと', async () => {
    const h = createHarness();
    await main.connect(h.context, '/dev/x', 9600);
    const callbacks = [];
    h.port.set = (signals, callback) => { h.port.sets.push(signals); callbacks.push(callback); };
    const first = assert.rejects(main.sendBreak(h.context), /timed out/);
    await h.clock.advance(5000);
    await first;
    const second = main.sendBreak(h.context);
    await flush();
    assert.deepEqual(h.port.sets.map(({ brk }) => brk), [false, true]);
    callbacks.shift()(null);
    await h.clock.advance(100);
    assert.deepEqual(h.port.sets.map(({ brk }) => brk), [false, true, false]);
    callbacks.shift()(null);
    await flush();
    assert.deepEqual(h.port.sets.map(({ brk }) => brk), [false, true, false, true]);
    callbacks.shift()(null);
    await h.clock.advance(100);
    callbacks.shift()(null);
    await second;
    assert.deepEqual(h.port.sets.map(({ brk }) => brk), [false, true, false, true, false]);
  });

  it('再確立のopen中にCancelした後の成功を回収すること', async () => {
    const h = createHarness();
    await h.ready();
    const create = h.serial.create;
    let opened;
    h.serial.create = function(port, baud, callback) { return create.call(this, port, baud, (...args) => { opened = () => callback(...args); }); };
    const result = main.restartAndReconnect(h.context);
    h.port.unplug();
    await h.clock.advance(1000);
    assert.equal(h.context.get().operation.phase, 'waiting');
    assert.equal(main.canAction(h.context, 'Cancel'), true);
    main.cancelConnection(h.context);
    assert.equal(await result, false);
    opened();
    await flush();
    assert.equal(h.port.isOpen, false);
    assert.equal(h.context.get().connection, null);
  });

  it('古いコンパイル完了で新しい操作を終了しないこと', async () => {
    const compiled = deferred();
    const h = createHarness({ source: { filename: 'a.rb', source: 'a' }, compiler: { compile: () => compiled.promise } });
    await h.ready();
    const old = main.runAction(h.context, () => main.compileAndWrite(h.context));
    await flush();
    await main.disconnect(h.context);
    await old;
    h.serial.device = () => '';
    const next = main.connectDevice(h.context);
    await flush();
    const id = h.context.get().operation.id;
    compiled.resolve(Uint8Array.of(1));
    await flush();
    assert.equal(h.context.get().operation.id, id);
    assert.deepEqual(texts(h.port), ['\r\n']);
    main.cancelConnection(h.context);
    await next;
  });

  it('終了中のclose完了を複数の呼出しで共有すること', async () => {
    let close;
    const h = createHarness({ serialOptions: { close(port, callback) { close = () => { port.isOpen = false; callback(null); }; } } });
    await h.ready();
    const first = main.disposeContext(h.context), second = main.disposeContext(h.context);
    assert.equal(first, second);
    assert.equal(h.port.closes, 1);
    assert.equal(h.output.disposed, 0);
    close();
    await first;
    assert.equal(h.output.disposed, 1);
  });

  it('commandのRestartはreset後に待機して再確立すること', async () => {
    const h = createHarness();
    await h.ready();
    const result = main.restartAndReconnect(h.context);
    await flush();
    assert.equal(h.context.get().mode, 'unknown');
    assert.deepEqual(texts(h.port).slice(2), ['reset\r\n']);
    await h.clock.advance(2000);
    assert.equal(await result, true);
    assert.deepEqual(texts(h.port).slice(2), ['reset\r\n', '\r\n', 'version\r\n']);
    assert.equal(h.serial.instances.length, 1);
  });

  it('unknownのRestartはBreakを100msアサートして解除すること', async () => {
    const h = createHarness();
    await main.connect(h.context, '/dev/x', 9600);
    const result = main.restartAndReconnect(h.context);
    await h.clock.advance(99);
    assert.deepEqual(h.port.sets.map((signals) => signals.brk), [false, true]);
    await h.clock.advance(1);
    assert.deepEqual(h.port.sets.map((signals) => signals.brk), [false, true, false]);
    await h.clock.advance(2000);
    assert.equal(await result, true);
  });

  it('Breakアサート失敗でも解除すること', async () => {
    const h = createHarness();
    await main.connect(h.context, '/dev/x', 9600);
    h.port.set = (signals, callback) => { h.port.sets.push(signals); callback(signals.brk ? new Error('Break failed') : null); };
    await assert.rejects(main.sendBreak(h.context), /Break failed/);
    assert.deepEqual(h.port.sets.map((signals) => signals.brk), [false, true, false]);
  });

  for (const response of ['-ERR reset failed\r\n', '']) {
    it(`reset拒否・応答不明ではCRLFへ進まないこと ${JSON.stringify(response)}`, async () => {
      const h = createHarness();
      await h.ready();
      h.serial.device = () => response;
      const result = main.restartAndReconnect(h.context);
      await h.clock.advance(6000);
      assert.equal(await result, false);
      assert.equal(h.context.get().mode, 'unknown');
      assert.deepEqual(texts(h.port).slice(2), ['reset\r\n']);
    });
  }

  it('確立中のRestartが旧Connectを終了し新操作を保持すること', async () => {
    const h = createHarness({ serialOptions: { device: () => '' } });
    const old = main.connectDevice(h.context);
    await flush();
    const result = main.restartAndReconnect(h.context);
    assert.equal(await old, false);
    assert.equal(h.context.get().operation.action, 'restart');
    h.serial.device = mrbwriteDevice;
    await h.clock.advance(2100);
    assert.equal(await result, true);
  });

  it('Disconnectは自動接続を切りclose後に操作を解放すること', async () => {
    let close;
    const h = createHarness({ serialOptions: { close(port, callback) { close = () => { port.isOpen = false; callback(null); port.emit('close'); }; } } });
    await h.ready();
    main.setAutoConnect(h.context, true);
    const result = main.disconnect(h.context);
    await flush();
    assert.equal(h.context.get().operation.action, 'disconnect');
    assert.equal(main.canAction(h.context, 'Connect'), false);
    assert.equal(main.canAction(h.context, 'Disconnect'), false);
    assert.equal(h.context.get().autoConnect, false);
    assert.equal(h.port.drains, 1);
    close();
    await result;
    assert.equal(h.context.get().connection, null);
    assert.equal(main.canAction(h.context, 'Connect'), true);
  });

  it('空writeとdrainの合計を500msに制限すること', async () => {
    let written, drained;
    const h = createHarness({ serialOptions: { write(port, bytes, callback) { written = callback; }, drain(port, callback) { drained = callback; } } });
    await main.connect(h.context, '/dev/x', 9600);
    const result = main.disconnect(h.context);
    await h.clock.advance(300);
    written(null);
    await h.clock.advance(199);
    assert.equal(h.port.closes, 0);
    await h.clock.advance(1);
    await result;
    assert.equal(h.port.closes, 1);
    drained(null);
    await flush();
    assert.equal(h.port.closes, 1);
  });

  it('期限を越えた空writeの完了からdrainを開始しないこと', async () => {
    let written;
    const h = createHarness({ serialOptions: { write(port, bytes, callback) { written = callback; } } });
    await main.connect(h.context, '/dev/x', 9600);
    const result = main.disconnect(h.context);
    await h.clock.advance(500);
    await result;
    written(null);
    await flush();
    assert.equal(h.port.drains, 0);
  });

  for (const failure of ['error', 'timeout']) {
    it(`close ${failure}では開いている接続を保持すること`, async () => {
      const h = createHarness({ serialOptions: { close(port, callback) { if (failure === 'error') callback(new Error('busy')); } } });
      await h.ready();
      const result = main.disconnect(h.context);
      await h.clock.advance(5000);
      await result;
      assert.ok(h.context.get().connection);
      assert.equal(h.context.get().mode, 'unknown');
      assert.equal(h.context.get().operation, null);
      assert.equal(main.canAction(h.context, 'Disconnect'), true);
    });
  }

  it('終了はタイマー・購読・Hostを解放し遅い受信で復活しないこと', async () => {
    const h = createHarness({ serialOptions: { device: () => '' } });
    const result = main.connectDevice(h.context);
    await flush();
    const data = h.port.listeners('data').slice();
    await main.disposeContext(h.context);
    assert.equal(await result, false);
    assert.equal(h.context.get().disposed, true);
    assert.equal(h.clock.timers.size, 0);
    assert.equal(h.port.listenerCount('data'), 0);
    assert.equal(h.output.disposed, 1);
    for (const callback of data) callback(Buffer.from('+OK mruby/c\r\n'));
    await h.clock.advance(5000);
    assert.equal(h.context.get().connection, null);
    await main.disposeContext(h.context);
    assert.equal(h.output.disposed, 1);
  });
});

describe('自動接続', () => {
  it('手動接続を挟んだ古い一覧結果で新たな接続を開始しないこと', async () => {
    const h = createHarness(), list = deferred();
    const ordinaryList = h.serial.list.bind(h.serial);
    h.serial.list = () => list.promise;
    main.setAutoConnect(h.context, true);
    const polling = main.pollAutoConnect(h.context);
    h.serial.list = ordinaryList;
    await h.ready();
    h.port.unplug();
    list.resolve([{ path: '/dev/x' }]);
    await flush();
    assert.equal(h.serial.instances.length, 1);
    assert.equal(h.context.get().operation, null);
    await polling;
  });

  it('既定は無効でデバイス設定へ保存しないこと', () => {
    const h = createHarness();
    assert.equal(main.autoConnectEnabled(h.context), false);
    main.setAutoConnect(h.context, true);
    assert.equal(main.autoConnectEnabled(h.context), true);
    assert.deepEqual(h.storage.device, { port: '/dev/x' });
    assert.equal(main.autoConnectEnabled(createHarness({ device: h.storage.device }).context), false);
  });

  for (const options of [{ device: {} }, {}]) {
    it(`無効・ポート未設定では一覧を取得しないこと ${JSON.stringify(options)}`, async () => {
      const h = createHarness(options);
      if (options.device) main.setAutoConnect(h.context, true);
      await main.pollAutoConnect(h.context);
      assert.equal(h.serial.listCalls, 0);
    });
  }

  it('ポートの出現で確立し接続中は一覧を取得しないこと', async () => {
    const h = createHarness();
    main.setAutoConnect(h.context, true);
    const result = main.pollAutoConnect(h.context);
    await h.clock.advance(1000);
    await result;
    assert.equal(h.context.get().mode, 'command');
    const calls = h.serial.listCalls;
    await main.pollAutoConnect(h.context);
    assert.equal(h.serial.listCalls, calls);
  });

  it('一覧要求を重ねずOFF→ON後にも古い結果を適用しないこと', async () => {
    const h = createHarness(), list = deferred();
    h.serial.list = () => { h.serial.listCalls++; return list.promise; };
    main.setAutoConnect(h.context, true);
    const first = main.pollAutoConnect(h.context), second = main.pollAutoConnect(h.context);
    assert.equal(h.serial.listCalls, 1);
    main.setAutoConnect(h.context, false);
    main.setAutoConnect(h.context, true);
    list.resolve([{ path: '/dev/x' }]);
    await Promise.all([first, second]);
    assert.equal(h.serial.instances.length, 0);
    assert.equal(h.context.runtime.portPresent, false);
  });

  it('一覧取得中の接続先変更に古い結果を適用しないこと', async () => {
    const h = createHarness(), list = deferred();
    h.serial.list = () => list.promise;
    main.setAutoConnect(h.context, true);
    const result = main.pollAutoConnect(h.context);
    main.updateDevice(h.context, { port: '/dev/y' });
    list.resolve([{ path: '/dev/x' }]);
    await result;
    assert.equal(h.serial.instances.length, 0);
  });

  it('失敗は静かに終了し消失→出現で次の接続を開始すること', async () => {
    const h = createHarness({ serialOptions: { device: () => '' } });
    main.setAutoConnect(h.context, true);
    const result = main.pollAutoConnect(h.context);
    await h.clock.advance(30000);
    await result;
    assert.ok(!h.output.lines.some((line) => line.startsWith('[error]')));
    h.port.unplug();
    await main.pollAutoConnect(h.context);
    assert.equal(h.serial.instances.length, 1);
    h.serial.ports = [];
    await main.pollAutoConnect(h.context);
    assert.equal(h.context.runtime.portPresent, false);
    h.serial.ports = [{ path: '/dev/x' }];
    h.serial.device = mrbwriteDevice;
    const next = main.pollAutoConnect(h.context);
    await h.clock.advance(1000);
    await next;
    assert.equal(h.serial.instances.length, 2);
  });
});


describe('設定とソース', () => {
  it('欠落キーを既定値で補うこと', () => {
    assert.deepEqual(main.getSettings(createHarness({ device: {} }).context), {
      version: '4.0.0', autoDetect: true, port: null, baud: 115200, autoConnect: false, autoVerify: true, libraries: [], tasks: []
    });
  });

  it('プロジェクト設定とデバイス設定を保存し他のキーを保つこと', () => {
    const h = createHarness({ device: { port: '/dev/x', baud: 9600 }, config: { tasks: [{ filename: 'main.rb' }] } });
    main.updateCompiler(h.context, { version: '3.4.0' });
    main.updateDevice(h.context, { autoDetect: false, autoVerify: false });
    assert.deepEqual(h.storage.config, { compiler: { version: '3.4.0' }, tasks: [{ filename: 'main.rb' }] });
    assert.deepEqual(h.storage.device, { port: '/dev/x', baud: 9600, autoDetect: false, autoVerify: false });
    assert.deepEqual(main.getSettings(h.context), {
      version: '3.4.0', autoDetect: false, port: '/dev/x', baud: 9600, autoConnect: false, autoVerify: false, libraries: [], tasks: [{ filename: 'main.rb' }]
    });
    assert.ok(h.output.renders.length > 0);
  });

  it('ファイルの追加・削除・並べ替えを保存し境界外は変更しないこと', () => {
    const h = createHarness({ config: { compiler: { version: '4.0.0' } } });
    main.addProjectEntries(h.context, 'tasks', ['a.rb', 'b.rb', 'c.rb']);
    main.addProjectEntries(h.context, 'libraries', ['lib.rb']);
    main.moveProjectEntry(h.context, 'tasks', 1, 1);
    assert.deepEqual(h.storage.config.tasks.map((entry) => entry.filename), ['a.rb', 'c.rb', 'b.rb']);
    main.moveProjectEntry(h.context, 'tasks', 0, -1);
    main.moveProjectEntry(h.context, 'tasks', 2, 1);
    main.removeProjectEntry(h.context, 'tasks', 3);
    assert.deepEqual(h.storage.config.tasks.map((entry) => entry.filename), ['a.rb', 'c.rb', 'b.rb']);
    main.removeProjectEntry(h.context, 'tasks', 1);
    assert.deepEqual(h.storage.config, { compiler: { version: '4.0.0' }, tasks: [{ filename: 'a.rb' }, { filename: 'b.rb' }], libraries: [{ filename: 'lib.rb' }] });
  });

  for (const [response, expected] of [
    ['+OK mruby/c v3.3 RITE0300 MRBW1.2', { mrubyc: 'v3.3', rite: 'RITE0300', error: null }],
    ['+OK mruby/c v4.0 RITE0400', { mrubyc: 'v4.0', rite: 'RITE0400', error: null }],
    ['+OK mruby/c v3.3', { mrubyc: 'v3.3', rite: null, error: null }],
    ['+OK mruby/c x RITE9999', { mrubyc: null, rite: 'RITE9999', error: null }],
    ['+OK mruby/c', { mrubyc: null, rite: null, error: null }]
  ]) {
    it(`version応答を解釈すること ${response}`, () => assert.deepEqual(main.parseBoardInfo(response), expected));
  }

  for (const response of [null, '-ERR Illegal command.', '+OK Execute']) {
    it(`versionとして読めない理由を保持すること ${response}`, () => assert.ok(main.parseBoardInfo(response).error));
  }

  for (const [rite, version] of [['RITE0300', '3.4.0'], ['RITE0400', '4.0.0'], ['RITE9999', '4.0.0'], ['', '4.0.0']]) {
    it(`RITEと設定からコンパイラを選ぶこと ${rite}`, async () => {
      const h = createHarness({ serialOptions: { device: (text) => text === 'version\r\n' ? `+OK mruby/c v3.3 ${rite}\r\n` : mrbwriteDevice(text) } });
      await h.ready();
      assert.equal(main.resolveCompilerVersion(h.context).version, version);
      assert.equal(!!main.resolveCompilerVersion(h.context).warning, !['RITE0300', 'RITE0400'].includes(rite));
      assert.equal(main.compilerDirectory(h.context), `/ext/media/mruby-${version}`);
      main.updateDevice(h.context, { autoDetect: false });
      assert.deepEqual(main.resolveCompilerVersion(h.context), { version: '4.0.0', warning: null });
      assert.deepEqual(h.storage.config, {});
    });
  }

  it('切断後は手動設定へ戻ること', async () => {
    const h = createHarness();
    await h.ready();
    assert.equal(main.resolveCompilerVersion(h.context).version, '3.4.0');
    await main.disconnect(h.context);
    assert.equal(main.resolveCompilerVersion(h.context).version, '4.0.0');
    assert.match(main.resolveCompilerVersion(h.context).warning, /接続されていません/);
  });

  it('同梱されないコンパイラは選べないこと', () => {
    const h = createHarness({ config: { compiler: { version: '9.9.9' } } });
    assert.equal(main.compilerDirectory(h.context), null);
  });

  for (const [root, filename, expected] of [[null, '/abs/a.rb', '/abs/a.rb'], ['/ws', 'a.rb', '/ws/a.rb'], [null, 'a.rb', null]]) {
    it(`ファイルパスを解決すること ${root} ${filename}`, () => assert.equal(main.toAbsoluteFilepath(createHarness({ root }).context, filename), expected));
  }

  for (const [root, filename, expected] of [['/ws', '/ws/src/a.rb', 'src/a.rb'], ['/ws', '/other/a.rb', null], ['/ws', '/ws/a.txt', null], [null, '/ws/a.rb', null]]) {
    it(`登録用パスを検証すること ${root} ${filename}`, () => assert.equal(main.toProjectFilename(createHarness({ root }).context, filename), expected));
  }

  it('同じ分類の登録済みと対象外を除き重複をなくすこと', () => {
    const h = createHarness({ root: '/ws', config: { tasks: [{ filename: 'a.rb' }], libraries: [{ filename: 'b.rb' }] } });
    assert.deepEqual(main.unregisteredFilenames(h.context, 'tasks', ['/ws/a.rb', '/ws/b.rb', '/ws/b.rb', '/ws/c.txt', '/other/d.rb']), ['b.rb']);
  });

  it('tasksを優先してディスクから読み、未指定ならエディターの内容を使うこと', () => {
    const h = createHarness({ root: '/ws', files: { '/ws/a.rb': 'disk' }, source: { filename: 'editor.rb', source: 'unsaved' }, config: { tasks: [{ filename: 'a.rb' }] } });
    assert.deepEqual(main.resolveTaskSources(h.context), [{ filename: 'a.rb', source: 'disk' }]);
    h.storage.config = {};
    assert.deepEqual(main.resolveTaskSources(h.context), [{ filename: 'editor.rb', source: 'unsaved' }]);
  });

  for (const root of ['/ws', null]) {
    it(`読めないファイルを警告すること ${root}`, () => {
      const h = createHarness({ root });
      assert.equal(main.readSources(h.context, [{ filename: 'missing.rb' }], 'tasks'), null);
      assert.deepEqual(h.output.notices, [['warning', 'kaniburner: tasks のファイルを開けません: missing.rb']]);
    });
  }

  it('ソースがなければ警告すること', () => {
    const h = createHarness();
    assert.equal(main.resolveTaskSources(h.context), null);
    assert.deepEqual(h.output.notices, [['warning', 'kaniburner: .rbファイルを開いてください']]);
  });

  it('ポート一覧と保存値をHostへ渡し選択を保存すること', async () => {
    let offered;
    const h = createHarness({ host: { pickPort: async (...args) => { offered = args; return '/dev/y'; } } });
    h.serial.ports = [{ path: '/dev/x', manufacturer: 'Acme' }, { path: '/dev/y' }];
    assert.equal(await main.pickPort(h.context), '/dev/y');
    assert.deepEqual(offered, [h.serial.ports, '/dev/x']);
    assert.equal(h.storage.device.port, '/dev/y');
  });

  for (const mode of ['empty', 'error', 'cancel']) {
    it(`ポート選択${mode}は保存しないこと`, async () => {
      const h = createHarness();
      if (mode === 'empty') h.serial.ports = [];
      if (mode === 'error') h.serial.list = async () => { throw new Error('denied'); };
      assert.equal(await main.pickPort(h.context), null);
      assert.equal(h.storage.device.port, '/dev/x');
      if (mode === 'error') assert.ok(h.output.lines.some((line) => /denied/.test(line)));
      if (mode === 'empty') assert.deepEqual(h.output.notices, [['error', 'kaniburner: No serial ports found.']]);
    });
  }

  it('ポート選択中に終わった接続を遅い選択で再開しないこと', async () => {
    const picked = deferred();
    const h = createHarness({ device: {}, host: { pickPort: () => picked.promise } });
    const result = main.connectDevice(h.context);
    await flush();
    await main.disposeContext(h.context);
    picked.resolve('/dev/x');
    assert.equal(await result, false);
    await flush();
    assert.equal(h.serial.instances.length, 0);
  });

  it('コンパイラ選択で自動判定を解除すること', async () => {
    const h = createHarness({ host: { pickVersion: async (versions) => { assert.deepEqual(versions, ['3.4.0', '4.0.0']); return '3.4.0'; } } });
    await main.selectVersion(h.context);
    assert.deepEqual(h.storage.config.compiler, { version: '3.4.0' });
    assert.equal(h.storage.device.autoDetect, false);
  });

  for (const [picked, input, expected] of [['9600', null, 9600], ['その他...', ' 57600 ', 57600], [null, null, undefined], ['その他...', null, undefined]]) {
    it(`Baud選択を反映すること ${picked} ${input}`, async () => {
      const h = createHarness({ host: { pickBaud: async () => picked, inputBaud: async () => input } });
      await main.selectBaud(h.context);
      assert.equal(h.storage.device.baud, expected);
    });
  }

  it('ファイル引数を展開して追加すること', async () => {
    const h = createHarness({ root: '/ws', project: { expandPaths: () => ['/ws/a.rb', '/ws/b.rb'] } });
    await main.addProjectFile(h.context, 'libraries', ['/ws']);
    assert.deepEqual(h.storage.config.libraries, [{ filename: 'a.rb' }, { filename: 'b.rb' }]);
  });

  it('引数無しなら未登録タブを選んで追加すること', async () => {
    const h = createHarness({ root: '/ws', host: { openFilePaths: () => ['/ws/a.rb', '/ws/b.txt'], pickFile: async (files, key) => { assert.deepEqual(files, ['a.rb']); assert.equal(key, 'tasks'); return 'a.rb'; } } });
    await main.addProjectFile(h.context, 'tasks', []);
    assert.deepEqual(h.storage.config.tasks, [{ filename: 'a.rb' }]);
  });

  for (const paths of [[], ['/ws/a.txt']]) {
    it(`追加候補無しを通知すること ${JSON.stringify(paths)}`, async () => {
      const h = createHarness({ root: '/ws' });
      await main.addProjectFile(h.context, 'tasks', paths);
      assert.equal(h.output.notices[0][0], 'info');
      assert.deepEqual(h.storage.config, {});
    });
  }
});

describe('コンパイルと操作の排他', () => {
  it('未接続・unknownなら暗黙の接続とコンパイルを行わないこと', async () => {
    const h = createHarness({ source: { filename: 'a.rb', source: 'task' } });
    await main.compileAndWrite(h.context);
    assert.equal(h.serial.instances.length, 0);
    await main.connect(h.context, '/dev/x', 9600);
    await main.compileAndWrite(h.context);
    assert.deepEqual(h.compiled, []);
    assert.deepEqual(texts(h.port), []);
  });

  it('全ソースのコンパイル後にclearし順番と選択コンパイラを保つこと', async () => {
    const h = createHarness({ root: '/ws', config: { libraries: [{ filename: 'lib.rb' }], tasks: [{ filename: 'a.rb' }, { filename: 'b.rb' }] }, files: { '/ws/lib.rb': 'lib', '/ws/a.rb': 'a', '/ws/b.rb': 'b' } });
    await h.ready();
    await main.runAction(h.context, () => main.compileAndWrite(h.context));
    assert.deepEqual(h.compiled, ['lib', 'a', 'b'].map((source) => ({ directory: '/ext/media/mruby-3.4.0', source })));
    assert.equal(texts(h.port)[2], 'clear\r\n');
    assert.deepEqual(texts(h.port).filter((text) => ['lib', 'a', 'b'].includes(text)), ['lib', 'a', 'b']);
    assert.equal(h.context.get().operation, null);
  });

  it('コンパイル失敗ではclearを送らずファイル名を報告すること', async () => {
    const h = createHarness({ source: { filename: 'bad.rb', source: 'fail' }, compiler: { compile: async () => null } });
    await h.ready();
    await main.runAction(h.context, () => main.compileAndWrite(h.context));
    assert.deepEqual(texts(h.port), ['\r\n', 'version\r\n']);
    assert.ok(h.output.lines.includes('[error] Compile failed: bad.rb'));
  });

  for (const event of ['boot', 'close', 'disconnect']) {
    it(`コンパイル中の${event}後にclearを送らないこと`, async () => {
      const compiled = deferred();
      const h = createHarness({ source: { filename: 'a.rb', source: 'a' }, compiler: { compile: () => compiled.promise } });
      await h.ready();
      const result = main.runAction(h.context, () => main.compileAndWrite(h.context));
      await flush();
      assert.equal(main.canAction(h.context, 'Write'), false);
      assert.equal(main.canAction(h.context, 'Disconnect'), true);
      if (event === 'boot') h.port.receive(BOOT);
      if (event === 'close') h.port.unplug();
      if (event === 'disconnect') await main.disconnect(h.context);
      compiled.resolve(Uint8Array.of(1));
      await result;
      assert.deepEqual(texts(h.port), ['\r\n', 'version\r\n']);
    });
  }

  it('開始後のソース・コンパイラ・CRC設定変更を転送へ混ぜないこと', async () => {
    const compiled = deferred(), calls = [];
    const h = createHarness({ root: '/ws', config: { tasks: [{ filename: 'a.rb' }, { filename: 'b.rb' }] }, files: { '/ws/a.rb': 'a', '/ws/b.rb': 'b' }, compiler: { compile: async (directory, source) => { calls.push({ directory, source }); if (source === 'a') return compiled.promise; return Uint8Array.of(2); } } });
    await h.ready();
    const result = main.runAction(h.context, () => main.compileAndWrite(h.context));
    await flush();
    main.updateCompiler(h.context, { version: '4.0.0' });
    main.updateDevice(h.context, { autoDetect: false, autoVerify: false });
    h.storage.config.tasks = [];
    compiled.resolve(Uint8Array.of(1));
    await result;
    assert.deepEqual(calls, ['a', 'b'].map((source) => ({ directory: '/ext/media/mruby-3.4.0', source })));
    assert.ok(texts(h.port).includes('write 1 ee76\r\n'));
    assert.ok(texts(h.port).includes('\x02'));
  });

  it('同時の操作を拒否し例外後も操作を解放すること', async () => {
    const wait = deferred(), h = createHarness();
    const result = main.runAction(h.context, () => wait.promise);
    let called = false;
    assert.equal(await main.runAction(h.context, async () => { called = true; }), undefined);
    assert.equal(called, false);
    wait.reject(new Error('failed'));
    await result;
    assert.equal(h.context.get().operation, null);
    assert.ok(h.output.lines.includes('[error] failed'));
  });

  it('Stateに実行資源を含めずネストした状態も外部から変更できないこと', async () => {
    const h = createHarness();
    const result = main.connectDevice(h.context);
    await flush();
    const state = h.context.get();
    assert.equal(Object.isFrozen(state), true);
    assert.equal(Object.isFrozen(state.connection), true);
    assert.equal(Object.isFrozen(state.operation), true);
    assert.equal(JSON.parse(JSON.stringify(state)).connection.path, '/dev/x');
    state.operation.phase = 'closing';
    state.connection.path = '/dev/y';
    await h.clock.advance(1000);
    assert.equal(await result, true);
    assert.equal(h.context.get().connection.path, '/dev/x');
  });
});


function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kaniburner-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const output = { text: '', lines: [], shown: 0, notices: [] };
  const host = {
    workspaceRoot: () => root,
    append(text) { output.text += text; },
    appendLine(line) { output.lines.push(line); },
    showOutput() { output.shown++; },
    notify(...args) { output.notices.push(args); }
  };
  return { root, output, host };
}

function installMrbc(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'mrbc.js'), `
    module.exports = async (options) => {
      module.exports.loads = (module.exports.loads ?? 0) + 1;
      const files = {};
      return {
        FS: {
          writeFile: (name, data) => { files[name] = data; },
          unlink: (name) => { delete files[name]; },
          readFile: (name) => Buffer.from(files[name])
        },
        callMain: (args) => {
          const source = files[args[2]];
          if (source === 'throw') throw new Error('boom');
          if (source === 'fail') return 1;
          options.print('compiled');
          options.printErr('diagnostic');
          files[args[1]] = source;
          return 0;
        }
      };
    };
  `);
}

describe('WASMコンパイラの境界', () => {
  it('出力をコピーして返し診断をHostへ渡すこと', async (t) => {
    const { root, host, output } = fixture(t);
    installMrbc(root);
    const compiler = main.createCompiler(host);
    const first = await compiler.compile(root, 'puts 1');
    await compiler.compile(root, 'puts 2');
    assert.deepEqual(first, new Uint8Array(Buffer.from('puts 1')));
    assert.match(output.text, /compiled\[stderr\] diagnostic/);
  });

  it('版ごとにモジュールを再利用すること', async (t) => {
    const { root, host } = fixture(t);
    const a = path.join(root, 'a'), b = path.join(root, 'b');
    installMrbc(a);
    installMrbc(b);
    const compiler = main.createCompiler(host);
    await compiler.compile(a, 'a');
    await compiler.compile(b, 'b');
    await compiler.compile(a, 'again');
    assert.equal(require(path.join(a, 'mrbc.js')).loads, 1);
    assert.equal(require(path.join(b, 'mrbc.js')).loads, 1);
  });

  for (const [source, message] of [['  \n', 'Source code is empty.'], ['fail', 'Compile failed (exit code 1).'], ['throw', 'Compile error: boom']]) {
    it(`コンパイル失敗を通知すること ${JSON.stringify(source)}`, async (t) => {
      const { root, host, output } = fixture(t);
      installMrbc(root);
      assert.equal(await main.createCompiler(host).compile(root, source), null);
      assert.ok(output.lines.includes(`[error] ${message}`));
      assert.equal(output.shown, 1);
    });
  }

  it('ロード失敗をキャッシュせず次の呼出しで再試行すること', async (t) => {
    const { root, host } = fixture(t);
    fs.writeFileSync(path.join(root, 'mrbc.js'), "module.exports = async () => { if (!module.exports.called++) throw new Error('load failed'); return { FS: { writeFile() {}, unlink() {}, readFile: () => Uint8Array.of(1) }, callMain: () => 0 }; }; module.exports.called = 0;");
    const compiler = main.createCompiler(host);
    await assert.rejects(compiler.compile(root, 'a'), /load failed/);
    assert.deepEqual(await compiler.compile(root, 'a'), Uint8Array.of(1));
  });
});

describe('プロジェクトファイルの境界', () => {
  it('設定の未作成・保存・読込みを扱うこと', (t) => {
    const { root, host } = fixture(t), project = main.createProjectStore(host);
    assert.deepEqual(project.readConfig(), {});
    const config = { compiler: { version: '3.4.0' }, tasks: [{ filename: 'main.rb' }] };
    project.writeConfig(config);
    assert.deepEqual(project.readConfig(), config);
    assert.equal(fs.readFileSync(path.join(root, '.vscode/kaniburner.json'), 'utf8'), JSON.stringify(config, null, 2) + '\n');
  });

  it('壊れたJSONでは空の設定とエラーを返すこと', (t) => {
    const { root, host, output } = fixture(t);
    fs.mkdirSync(path.join(root, '.vscode'));
    fs.writeFileSync(path.join(root, '.vscode/kaniburner.json'), '{');
    assert.deepEqual(main.createProjectStore(host).readConfig(), {});
    assert.match(output.lines[0], /Failed to read/);
  });

  it('ワークスペース無しは保存を警告すること', (t) => {
    const { host, output } = fixture(t);
    host.workspaceRoot = () => null;
    const project = main.createProjectStore(host);
    assert.deepEqual(project.readConfig(), {});
    project.writeConfig({});
    assert.deepEqual(output.notices, [['warning', 'kaniburner: プロジェクト設定を保存するにはフォルダを開いてください。']]);
  });

  it('ディレクトリを再帰的に整列しRubyファイルだけ展開すること', (t) => {
    const { root, host } = fixture(t);
    fs.mkdirSync(path.join(root, 'a'));
    fs.writeFileSync(path.join(root, 'b.rb'), 'b');
    fs.writeFileSync(path.join(root, 'a/z.rb'), 'z');
    fs.writeFileSync(path.join(root, 'a/c.txt'), 'c');
    const project = main.createProjectStore(host);
    assert.deepEqual(project.expandPaths([root]), [path.join(root, 'a/z.rb'), path.join(root, 'b.rb')]);
    assert.equal(project.readFile(path.join(root, 'b.rb')), 'b');
    assert.deepEqual(project.expandPaths(['/missing.rb']), ['/missing.rb']);
  });
});

describe('serialportの境界', () => {
  it('ポート一覧とコンストラクターへ引数を渡すこと', async () => {
    class SerialPort {
      static async list() { return [{ path: '/dev/x' }]; }
      constructor(options, callback) { this.options = options; this.callback = callback; }
    }
    const serial = main.createSerialTransport(SerialPort), callback = () => {};
    assert.deepEqual(await serial.list(), [{ path: '/dev/x' }]);
    const port = serial.create('/dev/x', 9600, callback);
    assert.deepEqual(port.options, { path: '/dev/x', baudRate: 9600 });
    assert.equal(port.callback, callback);
  });
});


function strict(name, object) {
  return new Proxy(object, { get(target, key) {
    if (key in target || typeof key === 'symbol' || key === 'then') return target[key];
    throw new Error(`unexpected ${name}.${String(key)}`);
  } });
}

class Uri { constructor(fsPath) { this.fsPath = fsPath; } static file(fsPath) { return new Uri(fsPath); } }
class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class ThemeColor { constructor(id) { this.id = id; } }
const document = (fileName, text = '', isClosed = false) => ({ fileName, isClosed, getText: () => text });

function createVscodeApi(options = {}) {
  const resources = [], handlers = {}, calls = [], events = {}, providers = {}, notices = [];
  const resource = (properties = {}) => {
    const value = { disposed: 0, dispose() { this.disposed++; }, ...properties };
    resources.push(value);
    return value;
  };
  const event = (name) => (callback) => {
    events[name] = callback;
    return resource({ dispose() { this.disposed++; delete events[name]; } });
  };
  const output = resource({ text: '', lines: [], shown: 0, append(text) { this.text += text; }, appendLine(line) { this.lines.push(line); }, show() { this.shown++; } });
  const status = resource({ text: '', shown: 0, show() { this.shown++; } });
  const storage = { device: options.device ?? {} };
  const extension = { extensionPath: '/ext', subscriptions: [], workspaceState: {
    get: (key) => { assert.equal(key, 'kaniburner.device'); return storage.device; },
    update: (key, value) => { assert.equal(key, 'kaniburner.device'); storage.device = value; return Promise.resolve(); }
  } };
  const api = strict('vscode', {
    Uri, TreeItem, ThemeIcon, ThemeColor,
    EventEmitter: class { constructor() { return resource({ fired: 0, event: () => {}, fire() { this.fired++; } }); } },
    StatusBarAlignment: { Left: 1 }, TreeItemCollapsibleState: { Expanded: 1 }, TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    commands: strict('commands', {
      executeCommand(...args) { calls.push(args); return Promise.resolve(); },
      registerCommand(id, callback) { handlers[id] = callback; return resource({ dispose() { this.disposed++; delete handlers[id]; } }); }
    }),
    window: strict('window', {
      activeTextEditor: undefined, visibleTextEditors: [], tabGroups: { all: [] },
      createOutputChannel: () => output, createStatusBarItem: () => status,
      onDidChangeActiveTextEditor: event('editor'),
      createTreeView(id, { treeDataProvider }) { providers[id] = treeDataProvider; return resource({ onDidChangeCheckboxState: event('checkbox') }); },
      registerTreeDataProvider(id, provider) { providers[id] = provider; return resource(); },
      showQuickPick: async () => undefined, showInputBox: async () => undefined,
      showErrorMessage(message) { notices.push(['error', message]); },
      showWarningMessage(message) { notices.push(['warning', message]); },
      showInformationMessage(message) { notices.push(['info', message]); },
      ...options.window
    }),
    workspace: strict('workspace', {
      workspaceFolders: options.root ? [{ uri: Uri.file(options.root) }] : undefined,
      createFileSystemWatcher(pattern) {
        assert.equal(pattern, '**/.vscode/kaniburner.json');
        return resource({ onDidChange: event('change'), onDidCreate: event('create'), onDidDelete: event('delete') });
      }
    })
  });
  return { api, extension, storage, resources, handlers, calls, events, providers, notices, output, status };
}

function setup(t, options = {}) {
  const env = createVscodeApi(options);
  const host = main.createVscodeHost(env.api, env.extension);
  const h = createHarness({ ...options, host });
  h.context.host.attach(h.context);
  main.refreshAll(h.context);
  t.after(() => main.disposeContext(h.context));
  return Object.assign(h, { env, host });
}

const values = (env) => Object.fromEntries(env.calls.filter(([command]) => command === 'setContext').map(([, key, value]) => [key, value]));

describe('VS Codeへの表示', () => {
  it('設定行・値・行内コマンド用のcontextValueを保持すること', (t) => {
    const { host } = setup(t, { root: '/ws', device: { port: '/dev/x', baud: 9600 } });
    assert.deepEqual(main.buildDeviceView(host).map((item) => [item.label, item.description, item.contextValue]), [
      ['Port', '/dev/x', 'devicePort'], ['mruby/c VM', '(not connected)', 'deviceVmVersion'], ['Baud', '9600', 'deviceBaud'],
      ['Auto connect', undefined, 'deviceAutoConnect'], ['mruby', '4.0.0', 'deviceVersion'],
      ['Auto detect compiler', undefined, 'deviceAutoDetect'], ['Auto verify', undefined, 'deviceAutoVerify']
    ]);
    assert.deepEqual(main.buildDeviceView(host, {}), []);
  });

  it('未指定ポートと存在しないコンパイラを表示すること', (t) => {
    const { host } = setup(t, { config: { compiler: { version: '9.9.9' } } });
    const items = main.buildDeviceView(host);
    assert.equal(items[0].description, '(none)');
    assert.equal(items[4].description, '9.9.9 (not found)');
    assert.equal(items[4].iconPath.id, 'warning');
    assert.equal(items[4].iconPath.color.id, 'errorForeground');
  });

  it('VM取得中・取得結果・切断を編集コマンド無しで表示すること', async (t) => {
    const h = setup(t, { device: { port: '/dev/x' }, serialOptions: { device: (text) => text === 'version\r\n' ? '' : mrbwriteDevice(text) } });
    const result = main.connectDevice(h.context);
    await h.clock.advance(1000);
    assert.equal(main.boardVersionItem(h.host).description, '(reading)');
    h.port.receive('+OK mruby/c v3.3 RITE0300\r\n');
    await result;
    const item = main.boardVersionItem(h.host);
    assert.equal(item.description, 'v3.3');
    assert.equal(item.command, undefined);
    assert.match(item.tooltip, /\/dev\/x/);
    await main.disconnect(h.context);
    assert.equal(main.boardVersionItem(h.host).description, '(not connected)');
  });

  for (const response of ['-ERR Illegal command.', '+OK mruby/c v3.3 RITE9999']) {
    it(`自動判定の警告と手動コンパイラを表示すること ${response}`, async (t) => {
      const h = setup(t, { device: { port: '/dev/x' }, serialOptions: { device: (text) => text === 'version\r\n' ? response + '\r\n' : mrbwriteDevice(text) } });
      await h.ready();
      const items = main.buildDeviceView(h.host);
      assert.equal(items[4].description, '4.0.0');
      assert.equal(items[5].iconPath.id, 'warning');
      assert.equal(items[5].iconPath.color.id, 'editorWarning.foreground');
      assert.match(items[5].tooltip, /mruby 4\.0\.0を使用/);
      assert.equal(items[5].checkboxState.tooltip, items[5].tooltip);
      if (response.startsWith('-ERR')) assert.match(items[1].tooltip, /Illegal command/);
    });
  }

  it('Projectに件数・並べ替え位置・ファイルを開く操作を表示すること', (t) => {
    const { host } = setup(t, { root: '/ws', config: { libraries: [{ filename: 'lib.rb' }], tasks: [{ filename: 'a.rb' }, { filename: 'b.rb' }, { filename: 'c.rb' }] } });
    assert.deepEqual(main.buildProjectView(host).map((item) => [item.label, item.key, item.description, item.contextValue]), [
      ['Libraries', 'libraries', '1', 'librariesParent'], ['Tasks', 'tasks', '3', 'tasksParent']
    ]);
    assert.equal(main.buildProjectView(host)[0].collapsibleState, 1);
    const children = main.buildProjectView(host, { key: 'tasks' });
    assert.deepEqual(children.map((item) => item.contextValue), ['projectFileFirst', 'projectFileMid', 'projectFileLast']);
    assert.equal(children[0].command.command, 'vscode.open');
    assert.equal(children[0].command.arguments[0].fsPath, '/ws/a.rb');
    assert.equal(main.buildProjectView(host, { key: 'libraries' })[0].contextValue, 'projectFileOnly');
    assert.deepEqual(main.buildProjectView(host, {}), []);
  });

  it('ワークスペースを開かない場合のProjectは空になること', (t) => {
    assert.deepEqual(main.buildProjectView(setup(t).host), []);
  });

  it('Stateからボタンとステータス表示を更新すること', async (t) => {
    const h = setup(t, { device: { port: '/dev/x' }, window: { activeTextEditor: { document: document('/main.rb', 'puts 1') } } });
    assert.deepEqual(values(h.env), {
      'kaniburner.connected': false, 'kaniburner.canCompile': false, 'kaniburner.canConnect': true, 'kaniburner.canCancel': false,
      'kaniburner.canDisconnect': false, 'kaniburner.canWrite': false, 'kaniburner.canExecute': false, 'kaniburner.canRestart': false
    });
    assert.equal(h.env.status.text, '$(debug-disconnect) kaniburner');
    await main.connect(h.context, '/dev/x', 9600);
    assert.equal(h.env.status.text, '$(plug) kaniburner');
    assert.equal(values(h.env)['kaniburner.canRestart'], true);
    await main.disconnect(h.context);
    await h.ready();
    assert.equal(h.env.status.text, '$(terminal) kaniburner');
    assert.equal(values(h.env)['kaniburner.canWrite'], true);
    await h.env.handlers['kaniburner.execute']();
    assert.equal(h.env.status.text, '$(play) kaniburner');
    assert.equal(h.env.status.accessibilityInformation.label, 'kaniburner: Run');
    assert.match(h.env.status.tooltip, /\/dev\/x.*115200/);
    assert.equal(values(h.env)['kaniburner.canWrite'], false);
    assert.equal(values(h.env)['outputView.scrollLock'], false);
  });
});

describe('VS Codeの操作と寿命', () => {
  it('package.jsonの全コマンドを登録して実行すること', async (t) => {
    const h = setup(t, { root: '/ws', device: { port: '/dev/x' }, window: { activeTextEditor: { document: document('/ws/a.rb', 'a') } } });
    const commands = require('../package.json').contributes.commands.map(({ command }) => command).sort();
    assert.deepEqual(Object.keys(h.env.handlers).sort(), commands);
    await h.env.handlers['kaniburner.write']();
    assert.equal(h.serial.instances.length, 0);
    const connection = h.env.handlers['kaniburner.connect']();
    await h.clock.advance(1000);
    assert.equal(await connection, true);
    await h.env.handlers['kaniburner.write']();
    assert.ok(texts(h.port).includes('clear\r\n'));
    await h.env.handlers['kaniburner.addTask'](Uri.file('/ws/a.rb'));
    await h.env.handlers['kaniburner.addTask'](null, [Uri.file('/ws/b.rb')]);
    h.env.handlers['kaniburner.moveProjectFileUp']({ key: 'tasks', index: 1 });
    assert.deepEqual(h.storage.config.tasks.map(({ filename }) => filename), ['b.rb', 'a.rb']);
    h.env.handlers['kaniburner.moveProjectFileDown']({ key: 'tasks', index: 0 });
    h.env.handlers['kaniburner.removeProjectFile']({ key: 'tasks', index: 1 });
    assert.deepEqual(h.storage.config.tasks, [{ filename: 'a.rb' }]);
    await h.env.handlers['kaniburner.disconnect']();
    assert.equal(h.context.get().connection, null);
  });

  it('checkboxの保存先を分け自動接続はセッション内だけに保持すること', (t) => {
    const h = setup(t);
    h.env.events.checkbox({ items: [
      [{ contextValue: 'deviceAutoConnect' }, 1], [{ contextValue: 'deviceAutoDetect' }, 0], [{ contextValue: 'deviceAutoVerify' }, 0]
    ] });
    assert.equal(h.context.get().autoConnect, true);
    assert.deepEqual(h.env.storage.device, { autoDetect: false, autoVerify: false });
    const items = main.buildDeviceView(h.host);
    assert.equal(items[3].checkboxState, 1);
    assert.equal(items[5].checkboxState, 0);
    assert.equal(items[6].checkboxState, 0);
  });

  it('設定ファイルの作成・変更・削除で表示を更新すること', (t) => {
    const h = setup(t);
    for (const event of ['create', 'change', 'delete']) {
      h.storage.config = { compiler: { version: event } };
      h.env.events[event]();
      assert.equal(h.host.model.settings.version, event);
    }
  });

  it('保存前のRubyを優先し記憶したRubyと表示中Rubyへ切り替えること', (t) => {
    const h = setup(t, { window: { activeTextEditor: { document: document('/active.rb', 'unsaved') } } });
    h.host.rememberEditor({ document: document('/last.rb', 'last') });
    assert.deepEqual(h.host.readRubySource(), { filename: 'active.rb', source: 'unsaved' });
    h.env.api.window.activeTextEditor = { document: document('/text.txt') };
    h.env.events.editor(h.env.api.window.activeTextEditor);
    assert.deepEqual(h.host.readRubySource(), { filename: 'last.rb', source: 'last' });
    h.host.activeRubyDocument().isClosed = true;
    h.env.api.window.visibleTextEditors = [{ document: document('/v.txt') }, { document: document('/visible.rb', 'visible') }];
    assert.deepEqual(h.host.readRubySource(), { filename: 'visible.rb', source: 'visible' });
    h.env.api.window.visibleTextEditors = [];
    assert.equal(h.host.readRubySource(), null);
  });

  it('全タブグループからファイルパスを取ること', (t) => {
    const h = setup(t, { window: { tabGroups: { all: [
      { tabs: [{ input: { uri: Uri.file('/a.rb') } }, { input: {} }] },
      { tabs: [{ input: undefined }, { input: { uri: Uri.file('/b.rb') } }] }
    ] } } });
    assert.deepEqual(h.host.openFilePaths(), ['/a.rb', '/b.rb']);
  });

  it('ポートの識別情報と保存済み選択を表示すること', async (t) => {
    let args;
    const h = setup(t, { window: { showQuickPick: async (...values) => { args = values; return values[0][1]; } } });
    assert.equal(await h.host.pickPort([{ path: '/dev/a', manufacturer: 'Acme', vendorId: '1234', productId: '5678' }, { path: '/dev/b' }], '/dev/b'), '/dev/b');
    assert.equal(args[0][0].description, 'Acme VID:1234 PID:5678');
    assert.equal(args[0][1].picked, true);
    assert.match(args[1].placeHolder, /\/dev\/b/);
  });

  it('Baud入力の正の整数検証をUIへ渡すこと', async (t) => {
    let options;
    const h = setup(t, { window: { showInputBox: async (value) => { options = value; return ' 57600 '; } } });
    assert.equal(await h.host.inputBaud(), ' 57600 ');
    for (const text of ['0', '-1', '1.5', 'abc', '']) assert.ok(options.validateInput(text));
    for (const text of ['9600', ' 57600 ']) assert.equal(options.validateInput(text), null);
  });

  it('URI引数を型確認し複数選択を優先すること', () => {
    const { api } = createVscodeApi();
    assert.deepEqual(main.uriArguments(api, Uri.file('/a.rb'), [Uri.file('/b.rb'), {}]), ['/b.rb']);
    assert.deepEqual(main.uriArguments(api, Uri.file('/a.rb')), ['/a.rb']);
    assert.deepEqual(main.uriArguments(api, {}), []);
  });

  it('終了で登録と表示資源を一度だけ破棄し遅いUI結果を保存しないこと', async (t) => {
    const picked = deferred();
    const h = setup(t, { window: { showQuickPick: () => picked.promise } });
    const selecting = h.env.handlers['kaniburner.selectVersion']();
    await main.disposeContext(h.context);
    picked.resolve('3.4.0');
    await selecting;
    assert.deepEqual(h.storage.config, {});
    assert.deepEqual(h.env.handlers, {});
    assert.deepEqual(h.env.events, {});
    for (const disposable of h.env.extension.subscriptions) disposable.dispose();
    assert.ok(h.env.resources.every((resource) => resource.disposed === 1));
  });

  it('activateでHostと自動監視を組み立てdeactivateで終了すること', async (t) => {
    const env = createVscodeApi();
    const serial = createSerial();
    class SerialPort { static list() { return serial.list(); } constructor(options, callback) { return serial.create(options.path, options.baudRate, callback); } }
    const load = Module._load;
    t.mock.method(Module, '_load', function(name, ...args) {
      if (name === 'vscode') return env.api;
      if (name === 'serialport') return { SerialPort };
      return load.call(this, name, ...args);
    });
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    main.activate(env.extension);
    assert.equal(env.status.shown, 1);
    assert.ok(env.providers['kaniburner.project']);
    assert.ok(env.providers['kaniburner.device']);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(serial.listCalls, 0);
    await main.deactivate();
    t.mock.timers.tick(10000);
    await flush();
    assert.deepEqual(env.handlers, {});
    assert.ok(env.resources.every((resource) => resource.disposed === 1));
  });
});

