/**
 * Kaniburner コア
 * mrbwrite プロトコルと mrbc コンパイルのロジック。
 * シリアル通信・WASM の解決・UI は extension.js が持つ。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * mrbwrite の CRC-16 を計算する。write コマンドの任意 CRC 検証用。
 * @param {Uint8Array} data - バイト列
 * @returns {number} CRC-16 値
 */
function mrbwriteCrc16(data) {
  let crc = 0x0000;
  for (let j = 0; j < data.length; j++) {
    crc ^= data[j];
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x0001) ? ((crc >> 1) ^ 0x8408) : (crc >> 1);
    }
  }
  return (~crc) & 0xffff;
}

const _encoder = new TextEncoder();

/**
 * mrbwrite プロトコル実装
 * コマンドモードの検出、コマンド送受信、バイトコード書き込みを行う。
 * 送信は transport.write、受信は feed への注入で行う。
 */
class MrbwriteProtocol {
  /**
   * @param {{write: function(Uint8Array): Promise<void>}} transport - 送信手段
   * @param {{onText?: function(string): void,
   *          onLog?: function(string, string): void,
   *          onCommandModeChange?: function(boolean): void}} [hooks] - 表示・通知用フック
   */
  constructor(transport, hooks) {
    this.transport = transport;
    this._hooks = hooks || {};
    this._decoder = new TextDecoder();
    this._pending = '';
    this._commandMode = false;
    this._lastCommand = null;
    this._responseResolve = null;
  }

  get commandMode() { return this._commandMode; }

  _log(kind, msg) { if (this._hooks.onLog) this._hooks.onLog(kind, msg); }
  _onText(text) { if (this._hooks.onText) this._hooks.onText(text); }
  _notifyMode(v) { if (this._hooks.onCommandModeChange) this._hooks.onCommandModeChange(v); }

  _sendText(text) {
    return this.transport.write(_encoder.encode(text));
  }

  /**
   * 受信バイトの入口。復号・行分割・モード検出・応答解決までここで行う。
   * コマンドモードのプロンプトは改行なしで届くことがあるため、未完の行でもモード検出だけは行う。
   * @param {Uint8Array} bytes - 受信データ
   */
  feed(bytes) {
    const text = this._decoder.decode(bytes, { stream: true });
    if (text) this._onText(text);
    const combined = this._pending + text;
    const parts = combined.split('\r\n');
    this._pending = parts.pop() || '';
    for (const line of parts) this._handleLine(line, false);
    if (this._pending) this._handleLine(this._pending, true);
  }

  _handleLine(line, isPartial) {
    this._checkCommandModePatterns(line);
    if (isPartial) return;
    if (this._responseResolve
        && (line.startsWith('+OK') || line.startsWith('-ERR') || line.startsWith('+DONE'))) {
      const resolve = this._responseResolve;
      this._responseResolve = null;
      resolve(line);
    }
  }

  /** 受信テキストからコマンドモードの開始・終了を検出する */
  _checkCommandModePatterns(text) {
    if (!this._commandMode && text.includes('+OK mruby/c')) {
      this._commandMode = true;
      this._log('info', 'Command mode entered.');
      this._notifyMode(true);
    } else if (this._commandMode && this._lastCommand === 'execute'
        && text.startsWith('+OK') && !text.includes('+OK mruby/c')) {
      this._commandMode = false;
      this._lastCommand = null;
      this._log('info', 'Command mode exited.');
      this._notifyMode(false);
    }
  }

  /** 切断時にプロトコル状態を初期化する */
  reset() {
    this._pending = '';
    this._commandMode = false;
    this._lastCommand = null;
    if (this._responseResolve) {
      const r = this._responseResolve;
      this._responseResolve = null;
      r(null);
    }
    this._notifyMode(false);
  }

  /**
   * ボードからの応答行を待機する
   * @param {number} [timeout] - タイムアウト（ミリ秒）
   * @returns {Promise<string|null>} 応答行、タイムアウト時は null
   */
  _waitForResponse(timeout = 5000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._responseResolve = null;
        resolve(null);
      }, timeout);
      this._responseResolve = (line) => { clearTimeout(timer); resolve(line); };
    });
  }

  /**
   * コマンドを送信して応答を待つ
   * @param {string} cmd - コマンド文字列
   * @param {{force?: boolean, ignoreResponse?: boolean, timeout?: number}} [options]
   * @returns {Promise<string|null>} 応答行
   */
  async sendCommand(cmd, { force, ignoreResponse, timeout } = {}) {
    if (!force && !this._commandMode) { this._log('error', 'Not in command mode.'); return null; }
    this._log('info', `> ${cmd}`);
    if (ignoreResponse) {
      await this._sendText(cmd + '\r\n');
      return null;
    }
    const p = this._waitForResponse(timeout);
    await this._sendText(cmd + '\r\n');
    return p;
  }

  /**
   * コマンドモードへ遷移する。デバイスは CR+LF の受信でコマンドモードに入り +OK mruby/c を返す仕様。
   * @returns {Promise<boolean>} 遷移成功なら true
   */
  async ensureCommandMode({ retries = 30, intervalMs = 1000 } = {}) {
    if (this._commandMode) return true;
    this._log('info', 'Entering command mode...');
    for (let i = 0; i < retries; i++) {
      try { await this._sendText('\r\n'); }
      catch (e) { this._log('error', `Send error: ${e.message}`); return false; }
      await sleep(intervalMs);
      if (this._commandMode) return true;
    }
    this._log('error', `Command mode transition timed out (${retries}s).`);
    return false;
  }

  /**
   * バイトコードをボードへ書き込む。mrbwrite 仕様: clear → (コマンド N CRC → バイナリ → +DONE) × n。
   * コマンドには CRC-16 を付与し、受信内容の検証はファーム側に任せる。
   * CRC 引数を解釈しないファームに対しては withCrc: false で抑止する。
   * @param {{libs?: Uint8Array[], tasks?: Uint8Array[]}} bytecodes - 書き込むバイトコード群
   * @param {{withCrc?: boolean}} [options]
   * @returns {Promise<boolean>} 全て書き込めたら true
   */
  async writeBytecodes({ libs = [], tasks = [] } = {}, { withCrc = true } = {}) {
    if (!await this.ensureCommandMode()) return false;
    if (tasks.length === 0) return false;

    this._log('info', '> clear');
    const p1 = this._waitForResponse();
    await this._sendText('clear\r\n');
    const clearResp = await p1;
    if (!clearResp || !clearResp.startsWith('+OK')) {
      this._log('error', `clear failed: ${clearResp}`);
      return false;
    }

    const entries = [
      ...libs.map((bin) => ({ command: 'write_lib', bin })),
      ...tasks.map((bin) => ({ command: 'write', bin }))
    ];
    for (const { command, bin } of entries) {
      let cmd = `${command} ${bin.length}`;
      if (withCrc) cmd += ` ${mrbwriteCrc16(bin).toString(16).padStart(4, '0')}`;
      this._log('info', `> ${cmd}`);
      const p2 = this._waitForResponse();
      await this._sendText(cmd + '\r\n');
      const writeResp = await p2;
      if (!writeResp || !writeResp.startsWith('+OK Write bytecode')) {
        this._log('error', `${command} command failed: ${writeResp}`);
        return false;
      }
      this._log('info', `Sending bytecode (${bin.length} bytes)...`);
      const p3 = this._waitForResponse(10000);
      await this.transport.write(bin);
      const res = await p3;
      if (res && res.startsWith('+DONE')) {
        this._log('info', 'Write completed.');
      } else if (res && res.startsWith('-ERR')) {
        this._log('error', `Write failed: ${res}`);
        return false;
      } else {
        this._log('error', `Write response timeout or unexpected: ${res}`);
        return false;
      }
    }
    return true;
  }

  /** ボード上のプログラムを実行する */
  async execute() {
    if (!await this.ensureCommandMode()) return;
    this._lastCommand = 'execute';
    await this.sendCommand('execute', { ignoreResponse: true });
  }
}

/**
 * mrbc WASM コンパイラ
 * Emscripten ファクトリの取得は loadFactory として呼び出し側に委譲する。
 */
class MrbcCompiler {
  /**
   * @param {function(): (Promise<Function>|Function)} loadFactory - ファクトリ取得手段
   * @param {{onLog?: function(string, string): void, moduleOptions?: Object}} [options]
   *   moduleOptions は locateFile 等をファクトリへ渡すための追加キー。noInitialRun/print/printErr は上書きしない。
   */
  constructor(loadFactory, { onLog, moduleOptions } = {}) {
    this._loadFactory = loadFactory;
    this._onLog = onLog || (() => {});
    this._moduleOptions = moduleOptions || {};
    this._initPromise = null;
    this.module = null;
  }

  _init() {
    if (this.module) return Promise.resolve();
    if (!this._initPromise) {
      this._initPromise = Promise.resolve(this._loadFactory()).then((factory) =>
        factory({
          ...this._moduleOptions,
          noInitialRun: true,
          print: (t) => this._onLog('stdout', t),
          printErr: (t) => this._onLog('stderr', t)
        })
      ).then((instance) => { this.module = instance; });
    }
    return this._initPromise;
  }

  /**
   * Ruby ソースコードをバイトコードにコンパイルする
   * @param {string} source - Ruby ソースコード
   * @returns {Promise<Uint8Array|null>} バイトコード、失敗時は null
   */
  async compile(source) {
    await this._init();
    if (!source.trim()) {
      this._onLog('error', 'Source code is empty.');
      return null;
    }
    this.module.FS.writeFile('/input.rb', source);
    try { this.module.FS.unlink('/output.mrb'); } catch (_) {}
    try {
      const rc = this.module.callMain(['-o', '/output.mrb', '/input.rb']);
      if (rc !== 0) {
        this._onLog('error', `Compile failed (exit code ${rc}).`);
        return null;
      }
      return new Uint8Array(this.module.FS.readFile('/output.mrb'));
    } catch (e) {
      this._onLog('error', `Compile error: ${e.message}`);
      return null;
    }
  }
}

module.exports = { MrbwriteProtocol, MrbcCompiler };
