(function () {
  'use strict';

  /**
   * ボードごとのシリアル通信プロファイル
   * @type {Object.<string, {baudRate: number, crcPoly: number}>}
   */
  const BOARD_PROFILES = {
    kani: { baudRate: 19200, crcPoly: 0x31 },
    rboard: { baudRate: 19200, crcPoly: 0x31 },
    esp32: { baudRate: 115200, crcPoly: 0x31 }
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /**
   * バイト列を16進ダンプ文字列に変換する
   * @param {Uint8Array} data - バイト列
   * @returns {string} スペース区切りの16進文字列
   */
  const hexDump = (data) => Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');

  /**
   * CRC-8 を計算する
   * @param {Uint8Array} data - バイト列
   * @param {number} poly - CRC 多項式
   * @returns {number} CRC-8 値（0-255）
   */
  const calculateCrc8 = (data, poly) => {
    let crc = 0xff;
    for (let j = 0; j < data.length; j++) {
      crc ^= data[j];
      for (let i = 8; i > 0; --i) {
        crc = (crc & 0x80) ? ((crc << 1) ^ poly) : (crc << 1);
        crc &= 0xff;
      }
    }
    return crc;
  };

  /**
   * mrbc WASM コンパイラ
   * MrbcModule ファクトリ（MODULAR=1）でインスタンスを生成し、
   * Ruby ソースコードを mruby バイトコードにコンパイルする。
   */
  const WasmCompiler = {
    wasmReady: false,
    module: null,

    /** MrbcModule ファクトリを呼び出して WASM インスタンスを初期化する */
    init() {
      MrbcModule({
        noInitialRun: true,
        print: (text) => { UI.logRaw(text); },
        printErr: (text) => { UI.logError(text); }
      }).then(instance => {
        WasmCompiler.module = instance;
        WasmCompiler.wasmReady = true;
        UI.logInfo('mrbc WASM ready.');
        UI.updateButtons();
      });
    },

    /**
     * Ruby ソースコードをバイトコードにコンパイルする
     * @param {string} source - Ruby ソースコード
     * @returns {Uint8Array|null} コンパイル済みバイトコード、失敗時は null
     */
    compile(source) {
      if (!this.wasmReady) {
        UI.logError('WASM not ready.');
        return null;
      }
      if (!source.trim()) {
        UI.logError('Source code is empty.');
        return null;
      }

      this.module.FS.writeFile('/input.rb', source);
      try { this.module.FS.unlink('/output.mrb'); } catch (e) { /* ignore */ }

      try {
        const rc = this.module.callMain(['-o', '/output.mrb', '/input.rb']);
        if (rc !== 0) {
          UI.logError('Compile failed (exit code ' + rc + ').');
          return null;
        }
        return this.module.FS.readFile('/output.mrb');
      } catch (e) {
        UI.logError('Compile error: ' + e.message);
        return null;
      }
    }
  };

  /**
   * mruby WASM ランタイム
   * MrubyModule ファクトリ（MODULAR=1）でインスタンスを生成し、
   * コンパイル済みバイトコードを実行する。
   */
  const MrubyRunner = {
    mrubyReady: false,
    module: null,
    running: false,
    _stdoutBuf: '',
    _stderrBuf: '',

    /** MrubyModule ファクトリを呼び出して WASM インスタンスを初期化する */
    init() {
      MrubyModule({
        noInitialRun: true,
        print: (text) => { MrubyRunner._stdoutBuf += text + '\n'; },
        printErr: (text) => { MrubyRunner._stderrBuf += text + '\n'; }
      }).then(instance => {
        MrubyRunner.module = instance;
        MrubyRunner.mrubyReady = true;
        UI.logInfo('mruby WASM ready.');
        UI.updateButtons();
      });
    },

    /**
     * バイトコードを mruby で実行し、結果をログに出力する
     * @param {Uint8Array} bytecode - コンパイル済みバイトコード
     */
    run(bytecode) {
      if (!this.mrubyReady) { UI.logError('mruby WASM not ready.'); return; }
      if (!bytecode) { UI.logError('No compiled bytecode.'); return; }
      UI.logInfo('Running on mruby...');
      this.running = true;
      UI.updateButtons();

      this._stdoutBuf = '';
      this._stderrBuf = '';
      this.module.FS.writeFile('/output.mrb', new Uint8Array(bytecode));
      try {
        this.module.callMain(['-b', '/output.mrb']);
      } catch (err) {
        this._stderrBuf += err.message + '\n';
      }

      if (this._stdoutBuf) UI.logRaw(this._stdoutBuf);
      if (this._stderrBuf) UI.logError(this._stderrBuf.trimEnd());
      this.running = false;
      UI.logInfo('mruby execution finished.');
      UI.updateButtons();
    }
  };

  /**
   * Web Serial API によるシリアル通信管理
   * ポートの接続・切断、データの読み書き、行単位のバッファリングを行う。
   */
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const SerialComm = {
    port: null,
    connected: false,
    reader: null,
    keepReading: false,
    readingPromise: null,
    serialLineBuffer: '',

    /** @type {function(string):void|null} 完全な1行を受信したときのコールバック */
    onLineReceived: null,
    /** @type {function(string):void|null} 生データを受信したときのコールバック */
    onRawData: null,
    /** @type {function():void|null} 切断時のコールバック */
    onDisconnect: null,

    /**
     * シリアルポートを開いて接続する
     * @param {{baudRate: number}} profile - ボードプロファイル
     */
    async connect(profile, port) {
      try {
        this.port = port || await navigator.serial.requestPort();
        await this.port.open({ baudRate: profile.baudRate });
        this.connected = true;
        this.keepReading = true;
        this.serialLineBuffer = '';
        this.readingPromise = this.readLoop();
      } catch (e) {
        UI.logError('Connection failed: ' + e.message);
        this.port = null;
        throw e;
      }
    },

    /** シリアルポートからの受信ループ */
    async readLoop() {
      while (this.port?.readable && this.keepReading) {
        try {
          this.reader = this.port.readable.getReader();
          while (true) {
            const { value, done } = await this.reader.read();
            if (done) break;
            this.processSerialData(decoder.decode(value, { stream: true }));
          }
        } catch (e) {
          if (!this.keepReading) break;
          console.warn('Read error:', e);
          break;
        } finally {
          if (this.reader) {
            try { this.reader.releaseLock(); } catch (e) { /* ignore */ }
            this.reader = null;
          }
        }
      }
    },

    /**
     * 受信データを行単位に分割してコールバックへ渡す
     * @param {string} rawText - 受信した生テキスト
     */
    processSerialData(rawText) {
      if (this.onRawData) this.onRawData(rawText);

      const combined = this.serialLineBuffer + rawText;
      const parts = combined.split('\r\n');
      this.serialLineBuffer = parts.pop() || '';

      for (const line of parts) {
        if (this.onLineReceived) this.onLineReceived(line);
      }

      if (this.serialLineBuffer) {
        MrbwriteProtocol.checkCommandModePatterns(this.serialLineBuffer);
      }
    },

    /** シリアルポートを閉じて切断する */
    async disconnect() {
      this.connected = false;
      this.keepReading = false;
      if (this.reader) {
        try { await this.reader.cancel(); } catch (e) { /* ignore */ }
      }
      if (this.readingPromise) {
        try { await this.readingPromise; } catch (e) { /* ignore */ }
        this.readingPromise = null;
      }
      const remaining = decoder.decode();
      if (remaining) this.processSerialData(remaining);
      if (this.port) {
        try { await this.port.close(); } catch (e) { /* ignore */ }
        this.port = null;
      }
      this.serialLineBuffer = '';
      if (this.onDisconnect) this.onDisconnect();
    },

    /**
     * シリアルポートにバイナリデータを書き込む
     * @param {Uint8Array} data - 送信データ
     */
    async writeToPort(data) {
      if (!this.port?.writable) return;
      const writer = this.port.writable.getWriter();
      try {
        await writer.ready;
        await writer.write(data);
      } finally {
        writer.releaseLock();
      }
    },

    /**
     * テキストをエンコードして送信する
     * @param {string} text - 送信テキスト
     */
    async sendText(text) {
      await this.writeToPort(encoder.encode(text));
    },

    /**
     * バイナリデータをそのまま送信する
     * @param {Uint8Array} data - 送信データ
     */
    async sendBinary(data) {
      await this.writeToPort(data);
    }
  };

  /**
   * mrbwrite プロトコル実装
   * コマンドモードの検出、コマンド送受信、バイトコード書き込みを行う。
   */
  const MrbwriteProtocol = {
    commandMode: false,
    responseResolve: null,
    lastCommand: null,

    /**
     * 受信テキストからコマンドモードの開始・終了を検出する
     * @param {string} text - 受信テキスト（行または部分バッファ）
     */
    checkCommandModePatterns(text) {
      if (!MrbwriteProtocol.commandMode && text.includes('+OK mruby/c')) {
        MrbwriteProtocol.commandMode = true;
        UI.logInfo('Command mode entered.');
        UI.updateButtons();
      } else if (MrbwriteProtocol.commandMode && MrbwriteProtocol.lastCommand === 'execute'
          && text.startsWith('+OK')
          && !text.includes('+OK mruby/c')) {
        MrbwriteProtocol.commandMode = false;
        MrbwriteProtocol.lastCommand = null;
        UI.logInfo('Command mode exited.');
        UI.updateButtons();
      }
    },

    /**
     * 完全な1行を受信したときの処理（コマンドモード検出＋レスポンス解決）
     * @param {string} line - 受信した1行
     */
    handleLineReceived(line) {
      MrbwriteProtocol.checkCommandModePatterns(line);

      if (MrbwriteProtocol.responseResolve
          && (line.startsWith('+OK') || line.startsWith('-ERR') || line.startsWith('+DONE'))) {
        MrbwriteProtocol.responseResolve(line);
        MrbwriteProtocol.responseResolve = null;
      }
    },

    /** 切断時にプロトコル状態をリセットする */
    handleDisconnect() {
      this.commandMode = false;
      if (this.responseResolve) {
        this.responseResolve(null);
        this.responseResolve = null;
      }
      this.lastCommand = null;
    },

    /**
     * ボードからのレスポンスを待機する
     * @param {number} [timeout=5000] - タイムアウト（ミリ秒）
     * @returns {Promise<string|null>} レスポンス行、タイムアウト時は null
     */
    waitForResponse(timeout) {
      timeout = timeout || 5000;
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          MrbwriteProtocol.responseResolve = null;
          resolve(null);
        }, timeout);
        MrbwriteProtocol.responseResolve = function (line) {
          clearTimeout(timer);
          resolve(line);
        };
      });
    },

    /**
     * コマンドを送信してレスポンスを待つ
     * @param {string} cmd - 送信するコマンド文字列
     * @param {Object} [options] - オプション
     * @param {boolean} [options.force] - コマンドモード外でも強制送信する
     * @param {boolean} [options.ignoreResponse] - レスポンスを待たない
     * @param {number} [options.timeout] - タイムアウト（ミリ秒）
     * @returns {Promise<string|null>} レスポンス行
     */
    async sendCommand(cmd, options) {
      options = options || {};
      if (!SerialComm.connected) {
        UI.logError('Not connected.');
        return null;
      }
      if (!options.force && !this.commandMode) {
        UI.logError('Not in command mode.');
        return null;
      }
      UI.logInfo('> ' + cmd);

      if (options.ignoreResponse) {
        await SerialComm.sendText(cmd + '\r\n');
        return null;
      }

      const responsePromise = this.waitForResponse(options.timeout);
      await SerialComm.sendText(cmd + '\r\n');
      return await responsePromise;
    },

    /**
     * コマンドモードに遷移する（最大30秒リトライ）
     * @returns {Promise<boolean>} 遷移成功なら true
     */
    async ensureCommandMode() {
      if (this.commandMode) return true;
      if (!SerialComm.connected) return false;
      UI.logInfo('Entering command mode...');

      for (let i = 0; i < 30; i++) {
        try {
          await SerialComm.sendText('\r\n');
        } catch (e) {
          UI.logError('Send error during command mode transition: ' + e.message);
          return false;
        }
        await sleep(1000);
        if (this.commandMode) return true;
        if (!SerialComm.connected) return false;
      }

      UI.logError('Command mode transition timed out (30s).');
      return false;
    },

    /**
     * バイトコードをボードに書き込む（clear → write → バイナリ送信）
     * @param {Uint8Array} binary - 書き込むバイトコード
     */
    async writeBytecode(binary) {
      if (!SerialComm.connected || !this.commandMode) {
        UI.logError('Not connected or not in command mode.');
        return;
      }

      // clear
      UI.logInfo('> clear');
      const clearResp = await (async () => {
        const p = this.waitForResponse();
        await SerialComm.sendText('clear\r\n');
        return await p;
      })();
      if (!clearResp || !clearResp.startsWith('+OK')) {
        UI.logError('clear command failed: ' + clearResp);
        return;
      }

      // write <size>
      const writeCmd = 'write ' + binary.length;
      UI.logInfo('> ' + writeCmd);
      const writeResp = await (async () => {
        const p = this.waitForResponse();
        await SerialComm.sendText(writeCmd + '\r\n');
        return await p;
      })();
      if (!writeResp || !writeResp.startsWith('+OK Write bytecode')) {
        UI.logError('write command failed: ' + writeResp);
        return;
      }

      // バイナリデータ送信
      UI.logInfo('Sending bytecode (' + binary.length + ' bytes)...');
      const binaryResp = this.waitForResponse(10000);
      await SerialComm.sendBinary(binary);
      const result = await binaryResp;
      if (result && result.startsWith('+DONE')) {
        UI.logInfo('Write completed.');
      } else if (result && result.startsWith('-ERR')) {
        UI.logError('Write failed: ' + result);
      } else {
        UI.logError('Write response timeout or unexpected: ' + result);
      }
    },

    /**
     * ボード上のバイトコードを CRC-8 で検証する
     * @param {Uint8Array} binary - コンパイル済みバイトコード（ローカル計算用）
     * @param {number} crcPoly - ボードプロファイルの CRC 多項式
     */
    async verifyBytecode(binary, crcPoly) {
      const resp = await this.sendCommand('verify');
      if (!resp) { UI.logError('verify: no response.'); return; }
      if (resp.startsWith('-ERR')) { UI.logError('verify: ' + resp); return; }

      const match = resp.match(/([0-9a-fA-F]{2,})\s*$/);
      if (!match) { UI.logError('verify: unexpected response: ' + resp); return; }

      const boardCrc = parseInt(match[1], 16);
      const localCrc = calculateCrc8(binary, crcPoly);
      if (localCrc === boardCrc) {
        UI.logInfo('Verify succeeded. (CRC8: 0x' + localCrc.toString(16).padStart(2, '0') + ')');
      } else {
        UI.logError('Verify failed. expected=0x' + localCrc.toString(16).padStart(2, '0')
          + ' got=0x' + boardCrc.toString(16).padStart(2, '0'));
      }
    },

    /** ボード上のプログラムを実行する */
    async executeProgram() {
      if (!await this.ensureCommandMode()) return;
      this.lastCommand = 'execute';
      await this.sendCommand('execute', { ignoreResponse: true });
    }
  };

  /**
   * UI管理
   * DOM要素の参照、ボタン状態の制御、ログ出力、イベントハンドラを提供する。
   */
  const UI = {
    els: {},
    compiledBinary: null,
    serialApiSupported: false,

    /** DOM要素の取得、WASM初期化、イベントリスナー登録を行う */
    init() {
      this.els = {
        codeEditor: document.getElementById('codeEditor'),
        logArea: document.getElementById('logArea'),
        boardSelect: document.getElementById('boardSelect'),
        commandInput: document.getElementById('commandInput'),
        btnCompile: document.getElementById('btnCompile'),
        btnRunMruby: document.getElementById('btnRunMruby'),
        btnWrite: document.getElementById('btnWrite'),
        btnVerify: document.getElementById('btnVerify'),
        btnExecute: document.getElementById('btnExecute'),
        btnClearLog: document.getElementById('btnClearLog'),
        btnConnect: document.getElementById('btnConnect'),
        btnDisconnect: document.getElementById('btnDisconnect'),
        btnSend: document.getElementById('btnSend'),
        deviceList: document.getElementById('deviceList')
      };

      this.serialApiSupported = !!navigator.serial;
      if (!this.serialApiSupported) {
        this.logError('Web Serial API is not supported in this browser.');
      }

      WasmCompiler.init();
      MrubyRunner.init();

      SerialComm.onLineReceived = (line) => MrbwriteProtocol.handleLineReceived(line);
      SerialComm.onRawData = (text) => this.logRaw(text);
      SerialComm.onDisconnect = () => {
        MrbwriteProtocol.handleDisconnect();
        this.logInfo('Disconnected.');
        this.updateButtons();
      };

      const savedBoard = localStorage.getItem('target');
      if (savedBoard && this.els.boardSelect.querySelector('option[value="' + savedBoard + '"]')) {
        this.els.boardSelect.value = savedBoard;
      }
      this.els.boardSelect.addEventListener('change', () => {
        localStorage.setItem('target', this.els.boardSelect.value);
        this.updateButtons();
      });

      this.els.btnCompile.addEventListener('click', () => this.handleCompile());
      this.els.btnRunMruby.addEventListener('click', () => this.handleRunMruby());
      this.els.btnWrite.addEventListener('click', () => this.handleWrite());
      this.els.btnVerify.addEventListener('click', () => this.handleVerify());
      this.els.btnExecute.addEventListener('click', () => this.handleExecute());
      this.els.btnClearLog.addEventListener('click', () => this.handleClearLog());
      this.els.btnConnect.addEventListener('click', () => this.handleConnect());
      this.els.btnDisconnect.addEventListener('click', () => this.handleDisconnect());
      this.els.btnSend.addEventListener('click', () => this.handleSend());
      this.els.commandInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.els.btnSend.click();
      });

      this.updateButtons();

      if (this.serialApiSupported) {
        navigator.serial.addEventListener('connect', (e) => this.handleSerialConnect(e));
        navigator.serial.addEventListener('disconnect', (e) => this.handleSerialDisconnect(e));
        this.refreshDeviceList();
      }
    },

    /** WASM準備状態・接続状態に応じてボタンの有効/無効を切り替える */
    updateButtons() {
      const ready = WasmCompiler.wasmReady;
      const conn = SerialComm.connected;
      const serial = this.serialApiSupported;
      const board = !!this.els.boardSelect.value;

      this.els.boardSelect.disabled = conn;
      this.els.btnCompile.disabled = !ready;
      this.els.btnRunMruby.disabled = !(MrubyRunner.mrubyReady && this.compiledBinary && !MrubyRunner.running);
      this.els.btnConnect.disabled = !(serial && ready && !conn && board);
      this.els.btnDisconnect.disabled = !conn;
      this.els.btnWrite.disabled = !(conn && this.compiledBinary);
      this.els.btnVerify.disabled = !(conn && this.compiledBinary);
      this.els.btnExecute.disabled = !conn;
      this.els.btnSend.disabled = !conn;
    },

    /**
     * 情報メッセージをログエリアに出力する
     * @param {string} msg - メッセージ
     */
    logInfo(msg) {
      const div = document.createElement('div');
      div.className = 'log-info';
      div.textContent = msg;
      this.els.logArea.appendChild(div);
      this.els.logArea.scrollTop = this.els.logArea.scrollHeight;
    },

    /**
     * エラーメッセージをログエリアに出力する
     * @param {string} msg - メッセージ
     */
    logError(msg) {
      const div = document.createElement('div');
      div.className = 'log-error';
      div.textContent = msg;
      this.els.logArea.appendChild(div);
      this.els.logArea.scrollTop = this.els.logArea.scrollHeight;
    },

    /**
     * 生テキストをログエリアに出力する（改行コード正規化あり）
     * @param {string} text - テキスト
     */
    logRaw(text) {
      const span = document.createElement('span');
      span.className = 'log-raw';
      span.textContent = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      this.els.logArea.appendChild(span);
      this.els.logArea.scrollTop = this.els.logArea.scrollHeight;
    },

    /** コンパイルボタンのハンドラ */
    handleCompile() {
      const source = this.els.codeEditor.value;
      this.logInfo('Compiling...');
      const binary = WasmCompiler.compile(source);
      if (binary) {
        this.compiledBinary = binary;
        this.logInfo('Compile succeeded. (' + binary.length + ' bytes)');
        this.logRaw(hexDump(binary) + '\n');
        this.updateButtons();
      }
    },

    /** mruby実行ボタンのハンドラ */
    handleRunMruby() {
      MrubyRunner.run(this.compiledBinary);
    },

    /** 書き込みボタンのハンドラ */
    async handleWrite() {
      if (!this.compiledBinary) {
        this.logError('No compiled bytecode.');
        return;
      }
      if (!await MrbwriteProtocol.ensureCommandMode()) return;
      await MrbwriteProtocol.writeBytecode(this.compiledBinary);
    },

    /** 検証ボタンのハンドラ */
    async handleVerify() {
      if (!this.compiledBinary) {
        this.logError('No compiled bytecode.');
        return;
      }
      if (!await MrbwriteProtocol.ensureCommandMode()) return;
      const profile = BOARD_PROFILES[this.els.boardSelect.value];
      await MrbwriteProtocol.verifyBytecode(this.compiledBinary, profile.crcPoly);
    },

    /** 実行ボタンのハンドラ */
    async handleExecute() {
      await MrbwriteProtocol.executeProgram();
    },

    /** ログクリアボタンのハンドラ */
    handleClearLog() {
      this.els.logArea.innerHTML = '';
    },

    /** 接続ボタンのハンドラ */
    async handleConnect() {
      const profileKey = this.els.boardSelect.value;
      const profile = BOARD_PROFILES[profileKey];
      this.logInfo('Connecting (' + profileKey + ', ' + profile.baudRate + ' baud)...');
      try {
        await SerialComm.connect(profile);
        this.logInfo('Connected.');
        this.updateButtons();
        this.refreshDeviceList();
        await MrbwriteProtocol.ensureCommandMode();
      } catch (e) {
        this.updateButtons();
      }
    },

    /** 切断ボタンのハンドラ */
    async handleDisconnect() {
      this.logInfo('Disconnecting...');
      await SerialComm.disconnect();
    },

    /** コマンド送信ボタンのハンドラ */
    async handleSend() {
      const cmd = this.els.commandInput.value.trim();
      if (!cmd) return;
      if (!await MrbwriteProtocol.ensureCommandMode()) return;
      await MrbwriteProtocol.sendCommand(cmd);
      this.els.commandInput.value = '';
    },

    /** デバイス一覧を再描画する */
    async refreshDeviceList() {
      const list = this.els.deviceList;
      list.innerHTML = '';
      if (!this.serialApiSupported) return;
      const ports = await navigator.serial.getPorts();
      if (ports.length === 0) {
        list.textContent = '(なし)';
        return;
      }
      ports.forEach((port, i) => {
        const info = port.getInfo();
        const div = document.createElement('div');
        div.className = 'device-item';
        const span = document.createElement('span');
        span.textContent = 'Port ' + i + (info.usbVendorId != null
          ? ' (VID:' + info.usbVendorId.toString(16).padStart(4, '0')
          + ' PID:' + info.usbProductId.toString(16).padStart(4, '0') + ')'
          : '');
        const btn = document.createElement('button');
        btn.textContent = '削除';
        btn.addEventListener('click', () => this.handleForgetDevice(port));
        div.appendChild(span);
        div.appendChild(btn);
        list.appendChild(div);
      });
    },

    /** デバイス削除（forget）ハンドラ */
    async handleForgetDevice(port) {
      if (SerialComm.port === port && SerialComm.connected) {
        this.logInfo('Disconnecting...');
        await SerialComm.disconnect();
      }
      await port.forget();
      this.logInfo('Device forgotten.');
      await this.refreshDeviceList();
    },

    /** navigator.serial connect イベントハンドラ（自動接続） */
    async handleSerialConnect(event) {
      await this.refreshDeviceList();
      if (SerialComm.connected) return;
      if (!this.els.boardSelect.value) return;
      const profile = BOARD_PROFILES[this.els.boardSelect.value];
      try {
        await SerialComm.connect(profile, event.target);
        this.logInfo('Auto-connected.');
        this.updateButtons();
        await this.refreshDeviceList();
        await MrbwriteProtocol.ensureCommandMode();
      } catch (e) { /* 自動接続失敗 */ }
    },

    /** navigator.serial disconnect イベントハンドラ */
    async handleSerialDisconnect(event) {
      const port = event.target;
      if (SerialComm.port === port && SerialComm.connected) {
        this.logInfo('Device physically disconnected.');
        await SerialComm.disconnect();
      }
      await this.refreshDeviceList();
    }
  };

  document.addEventListener('DOMContentLoaded', () => UI.init());
})();
