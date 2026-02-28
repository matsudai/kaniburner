# Host build: native mrbc (required for cross-compilation)
# CrossBuild needs host mrbc to compile gems' Ruby code into bytecode.
# Based on: mruby/build_config/default.rb
MRuby::Build.new do |conf|
  conf.toolchain
  conf.gembox 'default'
end
