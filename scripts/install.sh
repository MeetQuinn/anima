#!/bin/sh
set -eu

ANIMA_PACKAGE_NAME="${ANIMA_PACKAGE_NAME:-@meetquinn/animactl}"
ANIMA_VERSION_DEFAULT="latest"
ANIMA_VERSION="${ANIMA_VERSION:-$ANIMA_VERSION_DEFAULT}"

say() {
  printf '%s\n' "$*"
}

fail() {
  say "Anima install: $*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

# The runtime loads node:sqlite, which needs no flag from Node 22.13. Node 23
# could not load it before 23.4 and is end-of-life, so it is not supported.
node_is_supported() {
  node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit((major === 22 && minor >= 13) || major >= 24 ? 0 : 1);"
}

print_node_help() {
  cat >&2 <<'EOF'

Anima needs Node.js 22.13+ or 24+. Node 23 is not supported. Node includes
npm, which Anima uses to download and run the managed runtime package.

Install Node.js, then run this command again:

  macOS with Homebrew:  brew install node
  Other systems:       https://nodejs.org/

This script does not use sudo, install Homebrew, or change your PATH.
EOF
}

if ! have node; then
  print_node_help
  fail "node was not found."
fi

if ! node_is_supported 2>/dev/null; then
  print_node_help
  fail "Node.js 22.13+ or 24+ is required; found $(node --version 2>/dev/null || echo unknown)."
fi

if ! have npm; then
  print_node_help
  fail "npm was not found."
fi

PACKAGE_SPEC="${ANIMA_PACKAGE_NAME}@${ANIMA_VERSION}"

say "Starting Anima with ${PACKAGE_SPEC}..."

exec npm exec --yes --package "$PACKAGE_SPEC" -- animactl start "$@"
