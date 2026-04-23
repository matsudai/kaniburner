const { SerialPort } = require('serialport');

const BOARD_PROFILES = {
  kani:   { baudRate: 19200 },
  rboard: { baudRate: 19200 },
  esp32:  { baudRate: 115200 }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decoder = new TextDecoder();

class SerialComm {
  constructor({ onRawData, onLineReceived, onDisconnect } = {}) {
    this.port = null;
    this.connected = false;
    this.onRawData = onRawData || (() => {});
    this.onLineReceived = onLineReceived || (() => {});
    this.onDisconnect = onDisconnect || (() => {});
    this._lineBuffer = '';
  }

  connect(path, profile) {
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path, baudRate: profile.baudRate }, (err) => {
        if (err) return reject(err);
        this.port = port;
        this.connected = true;
        this._lineBuffer = '';
        port.on('data', (buf) => this._onData(buf));
        port.on('close', () => this._onClose());
        port.on('error', () => {});
        resolve();
      });
    });
  }

  _onData(buf) {
    const text = decoder.decode(buf, { stream: true });
    this.onRawData(text);
    const combined = this._lineBuffer + text;
    const parts = combined.split('\r\n');
    this._lineBuffer = parts.pop() || '';
    for (const line of parts) this.onLineReceived(line, false);
    if (this._lineBuffer) this.onLineReceived(this._lineBuffer, true);
  }

  _onClose() {
    if (!this.connected && !this.port) return;
    this.connected = false;
    this.port = null;
    this._lineBuffer = '';
    this.onDisconnect();
  }

  disconnect() {
    return new Promise((resolve) => {
      const p = this.port;
      if (!p) { this._onClose(); return resolve(); }
      this.connected = false;
      this.port = null;
      p.close(() => {
        this._lineBuffer = '';
        resolve();
      });
    });
  }

  writeBytes(data) {
    return new Promise((resolve, reject) => {
      if (!this.port) return reject(new Error('Not connected'));
      this.port.write(Buffer.from(data), (err) => (err ? reject(err) : resolve()));
    });
  }

  sendText(text) {
    return this.writeBytes(Buffer.from(text, 'utf8'));
  }

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

class MrbwriteProtocol {
  constructor(serial, output) {
    this.serial = serial;
    this.output = output;
    this.commandMode = false;
    this._responseResolve = null;
    this._lastCommand = null;
  }

  _info(msg) { this.output.appendLine(`[info]  ${msg}`); }
  _err(msg)  { this.output.appendLine(`[error] ${msg}`); }

  handleLineReceived(line, isPartial) {
    this._checkCommandModePatterns(line);
    if (isPartial) return;
    if (this._responseResolve
        && (line.startsWith('+OK') || line.startsWith('-ERR') || line.startsWith('+DONE'))) {
      const resolve = this._responseResolve;
      this._responseResolve = null;
      resolve(line);
    }
  }

  _checkCommandModePatterns(text) {
    if (!this.commandMode && text.includes('+OK mruby/c')) {
      this.commandMode = true;
      this._info('Command mode entered.');
    } else if (this.commandMode && this._lastCommand === 'execute'
        && text.startsWith('+OK') && !text.includes('+OK mruby/c')) {
      this.commandMode = false;
      this._lastCommand = null;
      this._info('Command mode exited.');
    }
  }

  handleDisconnect() {
    this.commandMode = false;
    this._lastCommand = null;
    if (this._responseResolve) {
      const r = this._responseResolve;
      this._responseResolve = null;
      r(null);
    }
  }

  _waitForResponse(timeout = 5000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._responseResolve = null;
        resolve(null);
      }, timeout);
      this._responseResolve = (line) => { clearTimeout(timer); resolve(line); };
    });
  }

  async sendCommand(cmd, { force, ignoreResponse, timeout } = {}) {
    if (!this.serial.connected) { this._err('Not connected.'); return null; }
    if (!force && !this.commandMode) { this._err('Not in command mode.'); return null; }
    this._info(`> ${cmd}`);
    if (ignoreResponse) {
      await this.serial.sendText(cmd + '\r\n');
      return null;
    }
    const p = this._waitForResponse(timeout);
    await this.serial.sendText(cmd + '\r\n');
    return p;
  }

  async ensureCommandMode() {
    if (this.commandMode) return true;
    if (!this.serial.connected) return false;
    this._info('Entering command mode...');
    for (let i = 0; i < 30; i++) {
      try { await this.serial.sendText('\r\n'); }
      catch (e) { this._err(`Send error: ${e.message}`); return false; }
      await sleep(1000);
      if (this.commandMode) return true;
      if (!this.serial.connected) return false;
    }
    this._err('Command mode transition timed out (30s).');
    return false;
  }

  // mrbwrite 仕様: clear → (write N → binary → +DONE) × n → execute
  async flashPlan(bytecodes) {
    if (!await this.ensureCommandMode()) return false;
    if (!bytecodes || bytecodes.length === 0) return false;

    this._info('> clear');
    const p1 = this._waitForResponse();
    await this.serial.sendText('clear\r\n');
    const clearResp = await p1;
    if (!clearResp || !clearResp.startsWith('+OK')) {
      this._err(`clear failed: ${clearResp}`);
      return false;
    }

    for (let i = 0; i < bytecodes.length; i++) {
      const bin = bytecodes[i];
      const cmd = `write ${bin.length}`;
      this._info(`> ${cmd}`);
      const p2 = this._waitForResponse();
      await this.serial.sendText(cmd + '\r\n');
      const writeResp = await p2;
      if (!writeResp || !writeResp.startsWith('+OK Write bytecode')) {
        this._err(`write command failed (slot ${i}): ${writeResp}`);
        return false;
      }
      this._info(`Sending bytecode slot ${i} (${bin.length} bytes)...`);
      const p3 = this._waitForResponse(10000);
      await this.serial.writeBytes(bin);
      const res = await p3;
      if (res && res.startsWith('+DONE')) {
        this._info(`Slot ${i} write completed.`);
      } else if (res && res.startsWith('-ERR')) {
        this._err(`Slot ${i} write failed: ${res}`);
        return false;
      } else {
        this._err(`Slot ${i} response timeout or unexpected: ${res}`);
        return false;
      }
    }
    return true;
  }

  async executeProgram() {
    if (!await this.ensureCommandMode()) return;
    this._lastCommand = 'execute';
    await this.sendCommand('execute', { ignoreResponse: true });
  }
}

module.exports = { SerialComm, MrbwriteProtocol, BOARD_PROFILES };
