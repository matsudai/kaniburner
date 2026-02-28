const vscode = require("vscode");
const path = require("path");
const { Hono } = require("hono");
const { serve } = require("@hono/node-server");
const { createNodeWebSocket } = require("@hono/node-ws");
const { serveStatic } = require("@hono/node-server/serve-static");

/** @type {import("http").Server | null} */
let server = null;
/** @type {vscode.OutputChannel | null} */
let outputChannel = null;
/** @type {Set} WebSocket接続中のクライアント */
const wsClients = new Set();
/** @type {string | null} 最後にrunされた.rbファイルの内容 */
let documentContent = null;

/**
 * 全WSクライアントにメッセージをブロードキャストする
 * @param {object} data 送信するJSON
 */
const broadcast = (data) => {
  const message = JSON.stringify(data);
  for (const ws of wsClients) {
    ws.send(message);
  }
};

/**
 * 拡張の有効化時に呼ばれるエントリポイント
 * Honoサーバー起動・WS管理・コマンド登録を行う
 * @param {vscode.ExtensionContext} context
 */
const activate = (context) => {
  const mediaDir = path.join(context.extensionPath, "media");

  outputChannel = vscode.window.createOutputChannel("Kaniburner");
  context.subscriptions.push(outputChannel);

  /** コマンド: kaniburner.edit — サーバー起動/コード送信 */
  const disposable = vscode.commands.registerCommand(
    "kaniburner.edit",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.endsWith(".rb")) {
        vscode.window.showWarningMessage(
          "Kaniburner: .rbファイルを開いてください"
        );
        return;
      }

      documentContent = editor.document.getText();

      // サーバー起動済み
      if (server) {
        if (wsClients.size > 0) {
          // 接続中 → コード送信
          broadcast({ type: "edit", content: documentContent });
        } else {
          // 切断中 → ブラウザ再オープン（onOpenで自動送信）
          vscode.env.openExternal(
            vscode.Uri.parse(`http://localhost:${server.address().port}`)
          );
        }
        return;
      }

      // --- 初回: サーバー起動 ---
      const app = new Hono();
      const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
        app,
      });

      /** 静的ファイル配信: media/ 配下を公開 */
      app.use("/*", serveStatic({ root: mediaDir, rewriteRequestPath: (p) => p }));

      /** WebSocketエンドポイント: クライアント接続管理 */
      app.get(
        "/ws",
        upgradeWebSocket(() => ({
          onOpen(_event, ws) {
            wsClients.add(ws);
            vscode.commands.executeCommand("setContext", "kaniburner.wsConnected", true);
            // 接続時にdocumentContentを自動送信
            if (documentContent) {
              ws.send(JSON.stringify({ type: "edit", content: documentContent }));
            }
          },
          onMessage(event, ws) {
            try {
              const msg = JSON.parse(event.data.toString());
              if (msg.type === "log" && outputChannel) {
                if (msg.level === "raw") {
                  outputChannel.append(msg.text);
                } else {
                  outputChannel.append(msg.text + "\n");
                }
              } else if (msg.type === "state") {
                vscode.commands.executeCommand("setContext", "kaniburner.deviceConnected", !!msg.deviceConnected);
              }
            } catch (e) { /* ignore */ }
          },
          onClose(_event, ws) {
            wsClients.delete(ws);
            if (wsClients.size === 0) {
              vscode.commands.executeCommand("setContext", "kaniburner.wsConnected", false);
              vscode.commands.executeCommand("setContext", "kaniburner.deviceConnected", false);
            }
          },
        }))
      );

      // --- サーバー起動（空きポート自動割当） ---
      server = serve({ fetch: app.fetch, port: 0 }, (info) => {
        vscode.env.openExternal(
          vscode.Uri.parse(`http://localhost:${info.port}`)
        );
        vscode.window.showInformationMessage(
          `Kaniburner: サーバー起動 → http://localhost:${info.port}`
        );
        outputChannel.show(true);
      });

      injectWebSocket(server);
    }
  );

  context.subscriptions.push(disposable);

  context.subscriptions.push(
    vscode.commands.registerCommand("kaniburner.serve", () => {
      vscode.commands.executeCommand("kaniburner.edit");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("kaniburner.compile", () => {
      broadcast({ type: "compile" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("kaniburner.run", () => {
      broadcast({ type: "run" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("kaniburner.executeAll", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.endsWith(".rb")) {
        vscode.window.showWarningMessage(
          "Kaniburner: .rbファイルを開いてください"
        );
        return;
      }
      documentContent = editor.document.getText();
      broadcast({ type: "executeAll", content: documentContent });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("kaniburner.connect", () => {
      broadcast({ type: "connect" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("kaniburner.disconnect", () => {
      broadcast({ type: "disconnect" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("kaniburner.write", () => {
      broadcast({ type: "write" });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("kaniburner.execute", () => {
      broadcast({ type: "execute" });
    })
  );
};

/**
 * 拡張の無効化時に呼ばれる
 * サーバー停止・WS接続のクリーンアップを行う
 */
const deactivate = () => {
  if (server) {
    server.close();
    server = null;
  }
  wsClients.clear();
  documentContent = null;
  outputChannel = null;
};

module.exports = { activate, deactivate };
