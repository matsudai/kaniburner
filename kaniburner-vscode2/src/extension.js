const vscode = require('vscode');
const path = require('node:path');
const { SerialPort } = require('serialport');
const { SerialComm, MrbwriteProtocol, BOARD_PROFILES } = require('./serial');
const { WasmCompiler, MrubyRunner } = require('./wasm');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {vscode.OutputChannel} */ let output;
/** @type {SerialComm}            */ let serial;
/** @type {MrbwriteProtocol}      */ let protocol;
/** @type {WasmCompiler}          */ let compiler;
/** @type {MrubyRunner}           */ let runner;

const info  = (msg) => output.appendLine(`[info]  ${msg}`);
const error = (msg) => output.appendLine(`[error] ${msg}`);

const setDeviceConnected = (v) =>
  vscode.commands.executeCommand('setContext', 'kaniburner.deviceConnected', v);

function getBoardProfile() {
  const key = vscode.workspace.getConfiguration('kaniburner').get('board') || 'rboard';
  const profile = BOARD_PROFILES[key] || BOARD_PROFILES.rboard;
  return { key, ...profile };
}

function getMrubyVersion() {
  return vscode.workspace.getConfiguration('kaniburner').get('mrubyVersion') || '3.4';
}

let currentVersion = null;
function ensureWasmForVersion(mediaDir) {
  const v = getMrubyVersion();
  if (v !== currentVersion) {
    currentVersion = v;
    compiler = new WasmCompiler(mediaDir, output, v);
    runner = new MrubyRunner(mediaDir, output, v);
  }
}

async function pickPort(context) {
  const cached = context.workspaceState.get('kaniburner.port');
  let ports;
  try {
    ports = await SerialPort.list();
  } catch (e) {
    error(`Failed to list ports: ${e.message}`);
    return null;
  }
  if (!ports || ports.length === 0) {
    vscode.window.showErrorMessage('Kaniburner: No serial ports found.');
    return null;
  }
  const items = ports.map((p) => {
    const meta = [p.manufacturer, p.vendorId && `VID:${p.vendorId}`, p.productId && `PID:${p.productId}`]
      .filter(Boolean).join(' ');
    return {
      label: p.path,
      description: meta || undefined,
      path: p.path,
      picked: p.path === cached
    };
  });
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Kaniburner: Select serial port',
    placeHolder: cached ? `Last used: ${cached}` : 'Pick a port'
  });
  if (!picked) return null;
  await context.workspaceState.update('kaniburner.port', picked.path);
  return picked.path;
}

async function breakAndReconnect(context) {
  if (!serial.connected) return false;
  const portPath = context.workspaceState.get('kaniburner.port');
  const profile = getBoardProfile();
  info('> break');
  await serial.sendBreak();
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (serial.connected) break;
    try {
      const ports = await SerialPort.list();
      if (ports.some((p) => p.path === portPath)) {
        await serial.connect(portPath, profile);
        info('Reconnected.');
        setDeviceConnected(true);
        break;
      }
    } catch (_) { /* retry */ }
  }
  if (!serial.connected) return false;
  return await protocol.ensureCommandMode();
}

async function ensureConnected(context) {
  if (serial.connected) return true;
  const portPath = await pickPort(context);
  if (!portPath) return false;
  const profile = getBoardProfile();
  info(`Connecting (${profile.key}, ${profile.baudRate} baud, ${portPath})...`);
  try {
    await serial.connect(portPath, profile);
    info('Connected.');
    setDeviceConnected(true);
    output.show(true);
    await protocol.ensureCommandMode();
    return true;
  } catch (e) {
    error(`Connect failed: ${e.message}`);
    return false;
  }
}

function getCurrentSource() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !ed.document.fileName.endsWith('.rb')) {
    vscode.window.showWarningMessage('Kaniburner: .rbファイルを開いてください');
    return null;
  }
  return ed.document.getText();
}

async function doCompile(mediaDir) {
  const src = getCurrentSource();
  if (src === null) return null;
  ensureWasmForVersion(mediaDir);
  info(`Compiling (mruby ${currentVersion})...`);
  const bc = await compiler.compile(src);
  if (bc) info(`Compile succeeded. (${bc.length} bytes)`);
  return bc;
}

const activate = (context) => {
  output = vscode.window.createOutputChannel('Kaniburner');
  context.subscriptions.push(output);

  const mediaDir = path.join(context.extensionPath, 'media');
  ensureWasmForVersion(mediaDir);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('kaniburner.mrubyVersion')) ensureWasmForVersion(mediaDir);
  }));

  serial = new SerialComm({
    onRawData: (text) => output.append(text),
    onLineReceived: (line, partial) => protocol.handleLineReceived(line, partial),
    onDisconnect: () => {
      protocol.handleDisconnect();
      setDeviceConnected(false);
      info('Disconnected.');
    }
  });
  protocol = new MrbwriteProtocol(serial, output);

  setDeviceConnected(false);

  const reg = (id, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('kaniburner.compile', async () => { await doCompile(mediaDir); });

  reg('kaniburner.run', async () => {
    const bc = await doCompile(mediaDir);
    if (!bc) return;
    info('Running on mruby...');
    await runner.run(bc);
    info('mruby execution finished.');
  });

  reg('kaniburner.write', async () => {
    const bc = await doCompile(mediaDir);
    if (!bc) return;
    if (!(await ensureConnected(context))) return;
    await protocol.flashPlan([bc]);
  });

  reg('kaniburner.execute', async () => {
    if (!(await ensureConnected(context))) return;
    await protocol.executeProgram();
  });

  reg('kaniburner.executeAll', async () => {
    const bc = await doCompile(mediaDir);
    if (!bc) return;
    if (!(await ensureConnected(context))) return;
    if (!(await breakAndReconnect(context))) return;
    if (await protocol.flashPlan([bc])) {
      await protocol.executeProgram();
    }
  });

  reg('kaniburner.break', async () => {
    if (!serial.connected) {
      vscode.window.showWarningMessage('Kaniburner: Not connected.');
      return;
    }
    await breakAndReconnect(context);
  });

  reg('kaniburner.connect', async () => {
    if (serial.connected) {
      vscode.window.showInformationMessage('Kaniburner: Already connected.');
      return;
    }
    await ensureConnected(context);
  });

  reg('kaniburner.disconnect', async () => {
    info('Disconnecting...');
    await serial.disconnect();
    setDeviceConnected(false);
  });
};

const deactivate = async () => {
  if (serial) await serial.disconnect();
};

module.exports = { activate, deactivate };
