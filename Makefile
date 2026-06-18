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
EMSDK_DIR    := components/emsdk

MRUBY_REF          := 3.4.0
EMSCRIPTEN_VERSION := 5.0.2

MRBC_BIN   := $(MRUBY_DIR)/build/emscripten-browser-mrbc/bin/mrbc
MRBC_WASM  := $(MRUBY_DIR)/build/emscripten-browser-mrbc/bin/mrbc.wasm
MRUBY_BIN  := $(MRUBY_DIR)/build/emscripten-browser-mruby/bin/mruby
MRUBY_WASM := $(MRUBY_DIR)/build/emscripten-browser-mruby/bin/mruby.wasm

DEST_DIRS := kaniburner-browser kaniburner-vscode/media

.PHONY: all clean deploy install help

.DEFAULT_GOAL := all

$(MRUBY_DIR):
	@mkdir -p $@
	set -o pipefail; curl -fL https://github.com/mruby/mruby/archive/refs/tags/$(MRUBY_REF).tar.gz \
	  | tar xz --strip-components=1 -C $@

$(EMSDK_DIR):
	@mkdir -p $@
	set -o pipefail; curl -fL https://github.com/emscripten-core/emsdk/archive/refs/tags/$(EMSCRIPTEN_VERSION).tar.gz \
	  | tar xz --strip-components=1 -C $@

all: | $(MRUBY_DIR)
	$(EMSDK_ENV) && cd $(MRUBY_DIR) && MRUBY_CONFIG=$(MRUBY_CONFIG) bundle exec rake

clean:
	$(EMSDK_ENV) && cd $(MRUBY_DIR) && MRUBY_CONFIG=$(MRUBY_CONFIG) bundle exec rake clean

deploy: all
	$(foreach dir,$(DEST_DIRS),\
		cp $(MRBC_BIN)   $(dir)/mrbc && \
		cp $(MRBC_WASM)  $(dir)/mrbc.wasm && \
		cp $(MRUBY_BIN)  $(dir)/mruby && \
		cp $(MRUBY_WASM) $(dir)/mruby.wasm && \
	) true

install: | $(EMSDK_DIR)
	cd $(EMSDK_DIR) && ./emsdk install $(EMSCRIPTEN_VERSION) && ./emsdk activate $(EMSCRIPTEN_VERSION)

# Release に添付する mruby バイナリを作る。例: make mruby-4.0.0
mruby-%: | $(EMSDK_DIR)
	@mkdir -p components/mruby-$*
	set -o pipefail; curl -fL https://github.com/mruby/mruby/archive/refs/tags/$*.tar.gz \
	  | tar xz --strip-components=1 -C components/mruby-$*
	$(EMSDK_ENV) && cd components/mruby-$* && bundle install && \
	  MRUBY_CONFIG=$(MRUBY_CONFIG) bundle exec rake
	@mkdir -p build/mruby-$*
	cp components/mruby-$*/build/emscripten-browser-mrbc/bin/mrbc        build/mruby-$*/
	cp components/mruby-$*/build/emscripten-browser-mrbc/bin/mrbc.wasm   build/mruby-$*/
	cp components/mruby-$*/build/emscripten-browser-mruby/bin/mruby      build/mruby-$*/
	cp components/mruby-$*/build/emscripten-browser-mruby/bin/mruby.wasm build/mruby-$*/

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Available targets:"
	@echo "  all         (Default) Build mrbc/mruby WASM."
	@echo "  clean       Remove all build artifacts."
	@echo "  deploy      Build and copy to kaniburner-browser/ & kaniburner-vscode/media/."
	@echo "  install     Install and activate emsdk."
	@echo "  help        Show this help message."
