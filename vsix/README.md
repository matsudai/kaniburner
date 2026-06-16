# Kaniburner

Cross platform mruby compiler and mrb writer.

![](https://raw.githubusercontent.com/matsudai/kaniburner/refs/heads/main/docs/images/readme.gif)

## Requirements

Firmware supports [mrbwrite protocol](https://github.com/mrubyc/mrbwrite).

## Getting Started

1. Open `.rb` file on VSCode.
2. Run `> Kaniburner: Connect`.
3. Select the device.
4. Run `> Kaniburner: Execute All`.

## mruby versions

mruby `3.4.0` is bundled and works offline. Other versions (e.g. `4.0.0`) are
downloaded on demand from GitHub Releases when selected, or in advance via
`> Kaniburner: Download mruby Version`. Downloaded assets are cached in the
workspace's `.vscode/kaniburner/` (or the extension's global storage when no
workspace is open), so a pre-populated `.vscode/` folder can be distributed
for offline use.

## Development

Build (requires Ruby; emsdk comes from the repository's submodule, mruby
sources are cloned automatically at their release tags):

```sh
make install
make # => kaniburner-x.y.z.vsix
```

`make` (= `make vsix`) builds and bundles only the default mruby version
(`3.4.0`). Use `make build-4.0.0` / `make deploy-4.0.0` to build other
versions explicitly.

Without a build environment, fetch prebuilt WASM assets from the
`wasm-<x.y.z>` GitHub Release instead:

```sh
make fetch-wasm   # curl the mruby-3.4.0 assets into media/mruby-3.4.0/
npm ci
npx --yes @vscode/vsce package --allow-missing-repository
```

Collect release assets for all versions:

```sh
make dist   # => vsix/dist/mruby-<x.y.z>-{mrbc,mruby}.{js,wasm} + SHA256SUMS.txt
```

## Release tags

- `wasm-<x.y.z>` (e.g. `wasm-0.0.1`): triggers `.github/workflows/wasm.yml`,
  which builds every mruby version and uploads `dist/` to the matching
  GitHub Release. `extension.js`'s `WASM_RELEASE_TAG` must be bumped in
  lockstep when a new `wasm-<x.y.z>` is published.
- `v<x.y.z>` (e.g. `v0.0.9`): triggers `.github/workflows/vsix.yml`, which
  fetches the default version's WASM assets from the `WASM_RELEASE_TAG`
  Release, packages the `.vsix`, and attaches it to the tag's GitHub
  Release.
