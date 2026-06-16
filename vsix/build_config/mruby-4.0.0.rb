# Host build: native mrbc (required for cross-compilation)
MRuby::Build.new do |conf|
  conf.toolchain
  conf.gembox 'default'
end

# Cross build: Emscripten (WASM) for Node - mrbc compiler
# MODULARIZE=1 + EXPORT_NAME='MrbcModule' でファクトリ関数としてエクスポート
MRuby::CrossBuild.new('emscripten-mrbc') do |conf|
  conf.toolchain :emscripten
  conf.gembox 'default'
  conf.enable_cxx_abi
  conf.linker do |linker|
    linker.flags << '-sFORCE_FILESYSTEM'
    linker.flags << "-sEXPORTED_RUNTIME_METHODS=['callMain','FS']"
    linker.flags << "-sEXPORT_NAME='MrbcModule'"
    linker.flags << '-sMODULARIZE=1'
  end
end

# Cross build: Emscripten (WASM) for Node - mruby runtime
# MODULARIZE=1 + EXPORT_NAME='MrubyModule' でファクトリ関数としてエクスポート
MRuby::CrossBuild.new('emscripten-mruby') do |conf|
  conf.toolchain :emscripten
  conf.gembox 'default'
  conf.enable_cxx_abi
  conf.linker do |linker|
    linker.flags << '-sFORCE_FILESYSTEM'
    linker.flags << "-sEXPORTED_RUNTIME_METHODS=['callMain','FS']"
    linker.flags << "-sEXPORT_NAME='MrubyModule'"
    linker.flags << '-sMODULARIZE=1'
  end
end
