# Kaniburner

mruby / mruby/c 用のクロスプラットフォーム mrb ライタ (VS Code 拡張)。

## 構成

```
kaniburner-vscode2/
├── Makefile                 build / deploy / vsix
├── build_config/
│   ├── mruby-3.4.rb         mruby 3.4 用 Emscripten ビルドコンフィグ
│   └── mruby-4.0.rb         mruby 4.0 用
├── media/
│   └── mruby-X.Y/           {mrbc,mruby}.{js,wasm} (Makefile が生成)
└── src/
    ├── extension.js         コマンド登録 / Settings / QuickPick
    ├── serial.js            SerialPort + mrbwrite プロトコル
    └── wasm.js              mrbc / mruby WASM ファクトリの遅延初期化
```

WASM のビルド成果物は `components/mruby-X.Y/build/` に出力され、
Makefile が `media/mruby-X.Y/` にコピーする。

## ビルド

初回 submodule 取得はリポジトリルートの README を参照。

```sh
cd kaniburner-vscode2
make install      # 初回のみ: emsdk install/activate + 各 mruby で bundle install
make              # build → deploy → vsix まで一発
make build        # WASM ビルドのみ
make deploy       # ビルド + media/mruby-X.Y/ 配置
make vsix         # deploy + vsce package
make build-3.4    # 3.4 のみ
make clean
make help
```

クロスターゲット用 VSIX は `npm_config_arch=<arch>` + `vsce package --target <platform>-<arch>` で生成する。

## 使い方

1. `.rb` ファイルを開く
2. Settings で `kaniburner.board` と `kaniburner.mrubyVersion` を設定
3. `Kaniburner: Execute All` (エディタタイトルバーのロケットアイコン)
4. 初回はシリアルポート選択の QuickPick が開く。選択結果は workspaceState にキャッシュ
