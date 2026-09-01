# 未決事項

`vsix/` の VS Code 拡張について、判断が必要な項目。所掌はいずれもユーザー。

## Auto connect のチェックボックスがポート未設定では入らない

`buildDeviceView` はチェックボックスに実効値（`port !== null && autoConnect`）を出す。ポート未設定でチェックすると `autoConnect: true` は保存されるが、行は Unchecked のまま表示される。

変更するなら、チェックボックスには保存値を出し、`port` の有無は `pollAutoConnect` の発火条件だけに効かせる。

## コマンドパレットに Break と Reset が並ぶ

ツールバーは `kaniburner.runMode` で1枠を出し分けるが、コマンドパレットは `when` の対象外。両方が出て、ハンドラを共有しているため動作も同じ。

隠すなら `menus.commandPalette` で片方に `"when": "false"` を置く。

## package.json の version

`0.0.11`。`make` は同名の `.vsix` を上書きする。
