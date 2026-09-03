# Kaniburner

## Development

Clone

```sh
git clone https://github.com/matsudai/kaniburner.git
```

Build

```sh
# docker run --rm -it -v $(pwd):/workspaces/kaniburner localhost/kaniburner bash

make -C vsix install
make -C vsix # => vsix/kaniburner-x.y.z.vsix
```
