# Host build: native mrbc (required for cross-compilation)
MRuby::Build.new do |conf|
  conf.toolchain
  conf.gembox 'default'
end

# Cross build: Emscripten (WASM) with Node.js filesystem access
# Based on: mruby/build_config/emscripten-cxx.rb
# Toolchain: mruby/tasks/toolchains/emscripten.rake
MRuby::CrossBuild.new('emscripten-node') do |conf|
  conf.toolchain :emscripten
  conf.gembox 'default'
  conf.enable_cxx_abi
  conf.linker do |linker|
    linker.flags << '-sNODERAWFS'
  end
end
