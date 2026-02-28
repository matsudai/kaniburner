# ====================================================================
#  ブラウザ向け WASM ビルドと配置
#
#  Emscripten で mrbc / mruby を WASM ビルドし，
#  kaniburner-browser/ および kaniburner-vscode/media/ へコピーする．
# ====================================================================

SHELL        := /bin/bash
MAKEFILE_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
EMSDK_ENV    := . $(MAKEFILE_DIR)components/emsdk/emsdk_env.sh
MRUBY_CONFIG := $(MAKEFILE_DIR)build_config/browser.rb
MRUBY_DIR    := components/mruby

MRBC_BIN   := $(MRUBY_DIR)/build/emscripten-browser-mrbc/bin/mrbc
MRBC_WASM  := $(MRUBY_DIR)/build/emscripten-browser-mrbc/bin/mrbc.wasm
MRUBY_BIN  := $(MRUBY_DIR)/build/emscripten-browser-mruby/bin/mruby
MRUBY_WASM := $(MRUBY_DIR)/build/emscripten-browser-mruby/bin/mruby.wasm

DEST_DIRS := kaniburner-browser kaniburner-vscode/media

.PHONY: all clean deploy install help

.DEFAULT_GOAL := all

# WASM ビルド
all:
	$(EMSDK_ENV) && cd $(MRUBY_DIR) && MRUBY_CONFIG=$(MRUBY_CONFIG) bundle exec rake

# ビルド成果物の削除
clean:
	$(EMSDK_ENV) && cd $(MRUBY_DIR) && MRUBY_CONFIG=$(MRUBY_CONFIG) bundle exec rake clean

# kaniburner-browser/ および kaniburner-vscode/media/ へコピー
deploy: all
	$(foreach dir,$(DEST_DIRS),\
		cp $(MRBC_BIN)   $(dir)/mrbc && \
		cp $(MRBC_WASM)  $(dir)/mrbc.wasm && \
		cp $(MRUBY_BIN)  $(dir)/mruby && \
		cp $(MRUBY_WASM) $(dir)/mruby.wasm && \
	) true

# emsdk のインストール・有効化
install:
	cd components/emsdk && ./emsdk install latest && ./emsdk activate latest

# 利用可能なコマンドの表示
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Available targets:"
	@echo "  all         (Default) Build mrbc/mruby WASM."
	@echo "  clean       Remove all build artifacts."
	@echo "  deploy      Build and copy to kaniburner-browser/ & kaniburner-vscode/media/."
	@echo "  install     Install and activate emsdk."
	@echo "  help        Show this help message."
