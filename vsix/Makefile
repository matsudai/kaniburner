SHELL        := /bin/bash
MAKEFILE_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
ROOT_DIR     := $(abspath $(MAKEFILE_DIR)..)
EMSDK_ENV    := . $(ROOT_DIR)/components/emsdk/emsdk_env.sh

MEDIA_DIR := $(MAKEFILE_DIR)media
DIST_DIR  := $(MAKEFILE_DIR)dist

MRUBY_VERSIONS  := 3.4.0 4.0.0
DEFAULT_VERSION := 3.4.0

# extension.js の WASM_RELEASE_TAG と一致させる
WASM_RELEASE_TAG ?= mruby-0.0.1
WASM_BASE_URL    := https://github.com/matsudai/kaniburner/releases/download/$(WASM_RELEASE_TAG)

MRUBY_REPO := https://github.com/mruby/mruby.git

# バージョンごとのパス
define version_paths
SRC_$(1)   := $(ROOT_DIR)/components/mruby-$(1)
CFG_$(1)   := $(MAKEFILE_DIR)build_config/mruby-$(1).rb
MEDIA_$(1) := $(MEDIA_DIR)/mruby-$(1)
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call version_paths,$(v))))

NPM_STAMP := $(MAKEFILE_DIR).npm.stamp

.PHONY: all vsix deploy build dist fetch-wasm install clean help \
        $(foreach v,$(MRUBY_VERSIONS),build-$(v) deploy-$(v))

.DEFAULT_GOAL := all

all: vsix

# mruby ソースをリリースタグから取得
define src_rule
$$(SRC_$(1)):
	git clone --depth 1 --branch $(1) $$(MRUBY_REPO) $$(SRC_$(1))
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call src_rule,$(v))))

# mrbc / mruby の WASM ビルド
define build_rule
build-$(1): | $$(SRC_$(1))
	cd $$(SRC_$(1)) && bundle install
	$$(EMSDK_ENV) && cd $$(SRC_$(1)) && \
	  MRUBY_CONFIG=$$(CFG_$(1)) bundle exec rake
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call build_rule,$(v))))

# 全バージョン一括ビルド
build: $(foreach v,$(MRUBY_VERSIONS),build-$(v))

# ビルド成果物を media/ へ配置
define deploy_rule
deploy-$(1): build-$(1)
	@mkdir -p $$(MEDIA_$(1))
	cp $$(SRC_$(1))/build/emscripten-mrbc/bin/mrbc        $$(MEDIA_$(1))/mrbc.js
	cp $$(SRC_$(1))/build/emscripten-mrbc/bin/mrbc.wasm   $$(MEDIA_$(1))/mrbc.wasm
	cp $$(SRC_$(1))/build/emscripten-mruby/bin/mruby      $$(MEDIA_$(1))/mruby.js
	cp $$(SRC_$(1))/build/emscripten-mruby/bin/mruby.wasm $$(MEDIA_$(1))/mruby.wasm
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call deploy_rule,$(v))))

# .vsix に同梱する既定バージョンのみ配置
deploy: deploy-$(DEFAULT_VERSION)

# npm 依存の取得
$(NPM_STAMP): $(MAKEFILE_DIR)package.json
	cd $(MAKEFILE_DIR) && npm install
	@touch $(NPM_STAMP)

# .vsix パッケージ生成
vsix: deploy $(NPM_STAMP)
	cd $(MAKEFILE_DIR) && npx --yes @vscode/vsce package --allow-missing-repository

# GitHub Release へアップロードする資産の集約
dist: $(foreach v,$(MRUBY_VERSIONS),build-$(v))
	@mkdir -p $(DIST_DIR)
	$(foreach v,$(MRUBY_VERSIONS),\
	  cp $(SRC_$(v))/build/emscripten-mrbc/bin/mrbc        $(DIST_DIR)/mruby-$(v)-mrbc.js; \
	  cp $(SRC_$(v))/build/emscripten-mrbc/bin/mrbc.wasm   $(DIST_DIR)/mruby-$(v)-mrbc.wasm; \
	  cp $(SRC_$(v))/build/emscripten-mruby/bin/mruby      $(DIST_DIR)/mruby-$(v)-mruby.js; \
	  cp $(SRC_$(v))/build/emscripten-mruby/bin/mruby.wasm $(DIST_DIR)/mruby-$(v)-mruby.wasm; \
	)
	cd $(DIST_DIR) && sha256sum mruby-*-mrbc.js mruby-*-mrbc.wasm mruby-*-mruby.js mruby-*-mruby.wasm > SHA256SUMS.txt

# ビルド環境なしで既定バージョンの WASM を GitHub Release から取得
fetch-wasm:
	@mkdir -p $(MEDIA_$(DEFAULT_VERSION))
	curl -fL -o $(MEDIA_$(DEFAULT_VERSION))/mrbc.js    $(WASM_BASE_URL)/mruby-$(DEFAULT_VERSION)-mrbc.js
	curl -fL -o $(MEDIA_$(DEFAULT_VERSION))/mrbc.wasm  $(WASM_BASE_URL)/mruby-$(DEFAULT_VERSION)-mrbc.wasm
	curl -fL -o $(MEDIA_$(DEFAULT_VERSION))/mruby.js   $(WASM_BASE_URL)/mruby-$(DEFAULT_VERSION)-mruby.js
	curl -fL -o $(MEDIA_$(DEFAULT_VERSION))/mruby.wasm $(WASM_BASE_URL)/mruby-$(DEFAULT_VERSION)-mruby.wasm

# ビルド環境のセットアップ
install:
	cd $(ROOT_DIR)/components/emsdk && ./emsdk install latest && ./emsdk activate latest

# ビルド成果物の削除
clean:
	rm -rf $(foreach v,$(MRUBY_VERSIONS),$(MEDIA_DIR)/mruby-$(v))
	rm -rf $(DIST_DIR)
	rm -f $(MAKEFILE_DIR)*.vsix $(NPM_STAMP)
	$(foreach v,$(MRUBY_VERSIONS),\
	  [ -d $(ROOT_DIR)/components/mruby-$(v)/build ] && \
	    rm -rf $(ROOT_DIR)/components/mruby-$(v)/build || true; \
	)

# 利用可能なターゲットの表示
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Available targets:"
	@echo "  all           (Default) Build/deploy the default version ($(DEFAULT_VERSION)) and package .vsix."
	@echo "  vsix          Same as all."
	@echo "  deploy        Build and copy the default version ($(DEFAULT_VERSION)) to media/mruby-$(DEFAULT_VERSION)/."
	@echo "  deploy-3.4.0  Build and copy only mruby 3.4.0."
	@echo "  deploy-4.0.0  Build and copy only mruby 4.0.0 (not bundled in .vsix by default)."
	@echo "  build         Build WASM for all mruby versions."
	@echo "  build-3.4.0   Build only mruby 3.4.0."
	@echo "  build-4.0.0   Build only mruby 4.0.0."
	@echo "  dist          Build all versions and collect release assets + SHA256SUMS.txt into dist/."
	@echo "  fetch-wasm    Fetch the default version's WASM assets from GitHub Release \$$(WASM_RELEASE_TAG) (no build env needed)."
	@echo "  install       Install and activate emsdk."
	@echo "  clean         Remove build artifacts (media/mruby-*/, dist/, *.vsix)."
	@echo "  help          Show this help message."
