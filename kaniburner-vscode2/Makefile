# ====================================================================
#  kaniburner-vscode2 ビルドパイプライン
#
#  各 mruby バージョン (3.4, 4.0) を Emscripten で WASM ビルドし，
#  media/mruby-X.Y/ に配置したうえで .vsix を生成する．
#
#  ビルド成果物は submodule 側 (components/mruby-X.Y/build/) に出るため，
#  ここ (kaniburner-vscode2/) には build/ を作らない．
# ====================================================================

SHELL        := /bin/bash
MAKEFILE_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
ROOT_DIR     := $(abspath $(MAKEFILE_DIR)..)
EMSDK_ENV    := . $(ROOT_DIR)/components/emsdk/emsdk_env.sh

MEDIA_DIR := $(MAKEFILE_DIR)media

MRUBY_VERSIONS := 3.4 4.0

# バージョンごとのパス
define version_paths
SRC_$(1)   := $(ROOT_DIR)/components/mruby-$(1)
CFG_$(1)   := $(MAKEFILE_DIR)build_config/mruby-$(1).rb
MEDIA_$(1) := $(MEDIA_DIR)/mruby-$(1)
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call version_paths,$(v))))

NPM_STAMP := $(MAKEFILE_DIR).npm.stamp

.PHONY: all vsix deploy build install clean help \
        $(foreach v,$(MRUBY_VERSIONS),build-$(v) deploy-$(v))

.DEFAULT_GOAL := all

# デフォルト: build → deploy → vsix まで実行
all: vsix

# mrbc / mruby の WASM ビルド（バージョン別）
define build_rule
build-$(1):
	$$(EMSDK_ENV) && cd $$(SRC_$(1)) && \
	  MRUBY_CONFIG=$$(CFG_$(1)) bundle exec rake
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call build_rule,$(v))))

# 全バージョン一括ビルド
build: $(foreach v,$(MRUBY_VERSIONS),build-$(v))

# ビルド成果物を media/mruby-X.Y/ にコピー（バージョン別）
define deploy_rule
deploy-$(1): build-$(1)
	@mkdir -p $$(MEDIA_$(1))
	cp $$(SRC_$(1))/build/emscripten-mrbc/bin/mrbc        $$(MEDIA_$(1))/mrbc.js
	cp $$(SRC_$(1))/build/emscripten-mrbc/bin/mrbc.wasm   $$(MEDIA_$(1))/mrbc.wasm
	cp $$(SRC_$(1))/build/emscripten-mruby/bin/mruby      $$(MEDIA_$(1))/mruby.js
	cp $$(SRC_$(1))/build/emscripten-mruby/bin/mruby.wasm $$(MEDIA_$(1))/mruby.wasm
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call deploy_rule,$(v))))

# 全バージョン一括配置
deploy: $(foreach v,$(MRUBY_VERSIONS),deploy-$(v))

# npm 依存の取得（package.json 更新時のみ再実行）
$(NPM_STAMP): $(MAKEFILE_DIR)package.json
	cd $(MAKEFILE_DIR) && npm install
	@touch $(NPM_STAMP)

# .vsix パッケージ生成
vsix: deploy $(NPM_STAMP)
	cd $(MAKEFILE_DIR) && npx --yes @vscode/vsce package --allow-missing-repository

# emsdk のインストール・有効化 + 各 components/mruby-X.Y の bundle install
install:
	cd $(ROOT_DIR)/components/emsdk && ./emsdk install latest && ./emsdk activate latest
	$(foreach v,$(MRUBY_VERSIONS),\
	  cd $(ROOT_DIR)/components/mruby-$(v) && bundle install && \
	)true

# ビルド成果物の削除
clean:
	rm -rf $(foreach v,$(MRUBY_VERSIONS),$(MEDIA_DIR)/mruby-$(v))
	rm -f $(MAKEFILE_DIR)*.vsix $(NPM_STAMP)
	$(foreach v,$(MRUBY_VERSIONS),\
	  [ -d $(ROOT_DIR)/components/mruby-$(v)/build ] && \
	    rm -rf $(ROOT_DIR)/components/mruby-$(v)/build || true; \
	)

# 利用可能なコマンドの表示
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Available targets:"
	@echo "  all         (Default) Build WASM, deploy, and package .vsix."
	@echo "  vsix        Same as all."
	@echo "  deploy      Build WASM and copy to media/mruby-X.Y/."
	@echo "  build       Build WASM for all mruby versions."
	@echo "  build-3.4   Build only mruby 3.4."
	@echo "  build-4.0   Build only mruby 4.0."
	@echo "  install     Install emsdk and bundle install each mruby submodule."
	@echo "  clean       Remove build artifacts."
	@echo "  help        Show this help message."
