SHELL        := /bin/bash
MAKEFILE_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

MEDIA_DIR := $(MAKEFILE_DIR)media

# main.ts の AVAILABLE_VERSIONS と一致させる
MRUBY_VERSIONS := 3.4.0 4.0.0

EMSCRIPTEN_VERSION := 6.0.8

MRUBY_REPO := https://github.com/mruby/mruby.git

# バージョンごとのパス
define version_paths
SRC_$(1)   := $(MAKEFILE_DIR)components/mruby-$(1)
CFG_$(1)   := $(MAKEFILE_DIR)build_config/mruby-$(1).rb
MEDIA_$(1) := $(MEDIA_DIR)/mruby-$(1)
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call version_paths,$(v))))

NPM_STAMP := $(MAKEFILE_DIR).npm.stamp

.PHONY: all vsix deploy build install test clean help \
        $(foreach v,$(MRUBY_VERSIONS),build-$(v) deploy-$(v))

.DEFAULT_GOAL := all

all: vsix

# emsdk を取得
$(MAKEFILE_DIR)components/emsdk/emsdk_env.sh:
	git clone --depth 1 --branch $(EMSCRIPTEN_VERSION) https://github.com/emscripten-core/emsdk.git $(MAKEFILE_DIR)components/emsdk

# mruby ソースをリリースタグから取得
define src_rule
$$(SRC_$(1)):
	git clone --depth 1 --branch $(1) $$(MRUBY_REPO) $$(SRC_$(1))
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call src_rule,$(v))))

# mrbc / mruby の WASM ビルド
define build_rule
build-$(1): | $$(SRC_$(1)) $(MAKEFILE_DIR)components/emsdk/emsdk_env.sh
	cd $$(SRC_$(1)) && bundle install
	. $(MAKEFILE_DIR)components/emsdk/emsdk_env.sh && cd $$(SRC_$(1)) && \
	  MRUBY_CONFIG=$$(CFG_$(1)) bundle exec rake
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call build_rule,$(v))))

# 全バージョン一括ビルド
build: $(foreach v,$(MRUBY_VERSIONS),build-$(v))

# ビルド成果物を media/ へ配置
define deploy_rule
deploy-$(1): build-$(1)
	@mkdir -p $$(MEDIA_$(1))
	cp $$(SRC_$(1))/build/emscripten-mrbc/bin/mrbc      $$(MEDIA_$(1))/mrbc.js
	cp $$(SRC_$(1))/build/emscripten-mrbc/bin/mrbc.wasm $$(MEDIA_$(1))/mrbc.wasm
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call deploy_rule,$(v))))

# 全バージョンを media/ へ配置
deploy: $(foreach v,$(MRUBY_VERSIONS),deploy-$(v))

# npm 依存の取得
$(NPM_STAMP): $(MAKEFILE_DIR)package.json
	cd $(MAKEFILE_DIR) && npm install
	@touch $(NPM_STAMP)

# .vsix パッケージ生成
vsix: deploy $(NPM_STAMP)
	cd $(MAKEFILE_DIR) && npx --yes @vscode/vsce package --allow-missing-repository

# テストの実行
test: $(NPM_STAMP)
	cd $(MAKEFILE_DIR) && npm test

# ビルド環境のセットアップ
install: | $(MAKEFILE_DIR)components/emsdk/emsdk_env.sh
	cd $(MAKEFILE_DIR)components/emsdk && ./emsdk install $(EMSCRIPTEN_VERSION) && ./emsdk activate $(EMSCRIPTEN_VERSION)

# ビルド成果物の削除
clean:
	rm -rf $(foreach v,$(MRUBY_VERSIONS),$(MEDIA_DIR)/mruby-$(v))
	rm -f $(MAKEFILE_DIR)*.vsix $(NPM_STAMP)
	$(foreach v,$(MRUBY_VERSIONS),\
	  [ -d $(MAKEFILE_DIR)components/mruby-$(v)/build ] && \
	    rm -rf $(MAKEFILE_DIR)components/mruby-$(v)/build || true; \
	)

# 利用可能なターゲットの表示
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Available targets:"
	@echo "  all         (Default) Build all mruby versions and package .vsix."
	@echo "  vsix        Same as all."
	@echo "  deploy      Build and copy all mruby versions to media/mruby-<version>/."
	@echo "  deploy-<v>  Build and copy a single version (v: $(MRUBY_VERSIONS))."
	@echo "  build       Build WASM for all mruby versions."
	@echo "  build-<v>   Build a single version."
	@echo "  install     Install and activate emsdk."
	@echo "  test        Run tests."
	@echo "  clean       Remove build artifacts (media/mruby-*/, *.vsix)."
	@echo "  help        Show this help message."
