const path = require('node:path');

class WasmCompiler {
  constructor(mediaDir, output, version) {
    this.baseDir = path.join(mediaDir, `mruby-${version}`);
    this.version = version;
    this.output = output;
    this._initPromise = null;
    this.module = null;
  }

  _init() {
    if (this.module) return Promise.resolve();
    if (!this._initPromise) {
      const factory = require(path.join(this.baseDir, 'mrbc.js'));
      this._initPromise = factory({
        noInitialRun: true,
        print:    (t) => this.output.appendLine(t),
        printErr: (t) => this.output.appendLine(`[stderr] ${t}`)
      }).then((instance) => { this.module = instance; });
    }
    return this._initPromise;
  }

  async compile(source) {
    await this._init();
    if (!source.trim()) {
      this.output.appendLine('[error] Source code is empty.');
      return null;
    }
    this.module.FS.writeFile('/input.rb', source);
    try { this.module.FS.unlink('/output.mrb'); } catch (_) { /* ignore */ }
    try {
      const rc = this.module.callMain(['-o', '/output.mrb', '/input.rb']);
      if (rc !== 0) {
        this.output.appendLine(`[error] Compile failed (exit code ${rc}).`);
        return null;
      }
      return Buffer.from(this.module.FS.readFile('/output.mrb'));
    } catch (e) {
      this.output.appendLine(`[error] Compile error: ${e.message}`);
      return null;
    }
  }
}

class MrubyRunner {
  constructor(mediaDir, output, version) {
    this.baseDir = path.join(mediaDir, `mruby-${version}`);
    this.version = version;
    this.output = output;
    this._initPromise = null;
    this.module = null;
    this._stdoutBuf = '';
    this._stderrBuf = '';
  }

  _init() {
    if (this.module) return Promise.resolve();
    if (!this._initPromise) {
      const factory = require(path.join(this.baseDir, 'mruby.js'));
      this._initPromise = factory({
        noInitialRun: true,
        print:    (t) => { this._stdoutBuf += t + '\n'; },
        printErr: (t) => { this._stderrBuf += t + '\n'; }
      }).then((instance) => { this.module = instance; });
    }
    return this._initPromise;
  }

  async run(bytecode) {
    await this._init();
    if (!bytecode) {
      this.output.appendLine('[error] No compiled bytecode.');
      return;
    }
    this._stdoutBuf = '';
    this._stderrBuf = '';
    this.module.FS.writeFile('/output.mrb', new Uint8Array(bytecode));
    try {
      this.module.callMain(['-b', '/output.mrb']);
    } catch (e) {
      this._stderrBuf += e.message + '\n';
    }
    if (this._stdoutBuf) this.output.append(this._stdoutBuf);
    if (this._stderrBuf) this.output.append(`[stderr] ${this._stderrBuf}`);
  }
}

module.exports = { WasmCompiler, MrubyRunner };
