# ====================================================================
#  kaniburner-vscode2 ビルドパイプライン
#
#  各 mruby バージョン (3.4, 4.0) を Emscripten で WASM ビルドし，
#  media/mruby-X.Y/ に配置したうえで .vsix を生成する．
#
#  ビルド成果物は components/mruby-X.Y/build/ に出るため，
#  ここ (kaniburner-vscode2/) には build/ を作らない．
# ====================================================================

SHELL        := /bin/bash
MAKEFILE_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
ROOT_DIR     := $(abspath $(MAKEFILE_DIR)..)
EMSDK_DIR    := $(ROOT_DIR)/components/emsdk
EMSDK_ENV    := . $(EMSDK_DIR)/emsdk_env.sh

MEDIA_DIR := $(MAKEFILE_DIR)media

MRUBY_VERSIONS := 3.4 4.0

REF_3.4            := 3.4.0
REF_4.0            := 4.0.0
EMSCRIPTEN_VERSION := 5.0.2

define version_paths
SRC_$(1)   := $(ROOT_DIR)/components/mruby-$(1)
CFG_$(1)   := $(MAKEFILE_DIR)build_config/mruby-$(1).rb
MEDIA_$(1) := $(MEDIA_DIR)/mruby-$(1)
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call version_paths,$(v))))

define fetch_rule
$$(SRC_$(1)):
	@mkdir -p $$@
	set -o pipefail; curl -fL https://github.com/mruby/mruby/archive/refs/tags/$$(REF_$(1)).tar.gz \
	  | tar xz --strip-components=1 -C $$@
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call fetch_rule,$(v))))

$(EMSDK_DIR):
	@mkdir -p $@
	set -o pipefail; curl -fL https://github.com/emscripten-core/emsdk/archive/refs/tags/$(EMSCRIPTEN_VERSION).tar.gz \
	  | tar xz --strip-components=1 -C $@

NPM_STAMP := $(MAKEFILE_DIR).npm.stamp

.PHONY: all vsix deploy build install clean help \
        $(foreach v,$(MRUBY_VERSIONS),build-$(v) deploy-$(v))

.DEFAULT_GOAL := all

# デフォルト: build → deploy → vsix まで実行
all: vsix

define build_rule
build-$(1): | $$(SRC_$(1))
	$$(EMSDK_ENV) && cd $$(SRC_$(1)) && \
	  MRUBY_CONFIG=$$(CFG_$(1)) bundle exec rake
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call build_rule,$(v))))

build: $(foreach v,$(MRUBY_VERSIONS),build-$(v))

define deploy_rule
deploy-$(1): build-$(1)
	@mkdir -p $$(MEDIA_$(1))
	cp $$(SRC_$(1))/build/emscripten-mrbc/bin/mrbc        $$(MEDIA_$(1))/mrbc.js
	cp $$(SRC_$(1))/build/emscripten-mrbc/bin/mrbc.wasm   $$(MEDIA_$(1))/mrbc.wasm
	cp $$(SRC_$(1))/build/emscripten-mruby/bin/mruby      $$(MEDIA_$(1))/mruby.js
	cp $$(SRC_$(1))/build/emscripten-mruby/bin/mruby.wasm $$(MEDIA_$(1))/mruby.wasm
endef
$(foreach v,$(MRUBY_VERSIONS),$(eval $(call deploy_rule,$(v))))

deploy: $(foreach v,$(MRUBY_VERSIONS),deploy-$(v))

# npm 依存の取得（package.json 更新時のみ再実行）
$(NPM_STAMP): $(MAKEFILE_DIR)package.json
	cd $(MAKEFILE_DIR) && npm install
	@touch $(NPM_STAMP)

vsix: deploy $(NPM_STAMP)
	cd $(MAKEFILE_DIR) && npx --yes @vscode/vsce package --allow-missing-repository

install: | $(EMSDK_DIR) $(foreach v,$(MRUBY_VERSIONS),$(SRC_$(v)))
	cd $(EMSDK_DIR) && ./emsdk install $(EMSCRIPTEN_VERSION) && ./emsdk activate $(EMSCRIPTEN_VERSION)
	$(foreach v,$(MRUBY_VERSIONS),\
	  cd $(SRC_$(v)) && bundle install && \
	)true

clean:
	rm -rf $(foreach v,$(MRUBY_VERSIONS),$(MEDIA_DIR)/mruby-$(v))
	rm -f $(MAKEFILE_DIR)*.vsix $(NPM_STAMP)
	$(foreach v,$(MRUBY_VERSIONS),\
	  [ -d $(ROOT_DIR)/components/mruby-$(v)/build ] && \
	    rm -rf $(ROOT_DIR)/components/mruby-$(v)/build || true; \
	)

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
	@echo "  install     Install emsdk and fetch + bundle install each mruby source."
	@echo "  clean       Remove build artifacts."
	@echo "  help        Show this help message."
