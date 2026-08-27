# .vsix のビルドツール
# 使い方 :
#     docker build -t localhost/kaniburner --build-arg uid=$(id -u) --build-arg gid=$(id -g) .
#     docker run --rm -it -v $(pwd):/workspaces/kaniburner localhost/kaniburner make -C vsix install
#     docker run --rm -it -v $(pwd):/workspaces/kaniburner localhost/kaniburner make -C vsix
FROM node:26.7.0-trixie-slim AS node

FROM ruby:4.0.6-slim-trixie

# mruby の WASM ビルドと .vsix パッケージのツールチェーン
#
# - build-essential, git : 汎用のビルドツール
# - python3 : emsdk と emcc が python3 で動く
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        git \
        python3 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# npm install と vsce package が必要とする
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

ARG uid=1000
ARG gid=1000
ARG app_root=/workspaces/kaniburner

RUN getent group ${gid} > /dev/null || groupadd -g ${gid} ruby && \
    useradd -u ${uid} -g ${gid} -s /bin/bash -m ruby

USER ruby

WORKDIR ${app_root}
