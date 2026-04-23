# Kaniburner

## Development

Clone

```sh
git clone \
  --filter=blob:none --also-filter-submodules \
  --recurse-submodules \
  https://github.com/matsudai/kaniburner.git

# git -c submodule.recurse=true -c clone.filter=blob:none \
#   submodule update --init --recursive
```

Build

```sh
make install
make # => kaniburner-x.y.z.vsix
```
