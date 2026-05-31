#!/bin/sh
set -eu

ANIMA_PACKAGE_NAME="${ANIMA_PACKAGE_NAME:-@meetquinn/animactl}"
ANIMA_VERSION_DEFAULT="latest"
ANIMA_VERSION="${ANIMA_VERSION:-$ANIMA_VERSION_DEFAULT}"
ANIMA_MIN_NODE_MAJOR="${ANIMA_MIN_NODE_MAJOR:-20}"

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

node_major() {
  node -e "const major = Number(process.versions.node.split('.')[0]); if (!Number.isInteger(major)) process.exit(1); console.log(major);"
}

print_node_help() {
  cat >&2 <<'EOF'

Anima needs Node.js 20 or newer. Node includes npm, which Anima uses to download
and run the managed runtime package.

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

MAJOR="$(node_major 2>/dev/null || true)"
if [ -z "$MAJOR" ]; then
  fail "could not read the installed Node.js version."
fi
if [ "$MAJOR" -lt "$ANIMA_MIN_NODE_MAJOR" ]; then
  print_node_help
  fail "Node.js $ANIMA_MIN_NODE_MAJOR or newer is required; found $(node --version)."
fi

if ! have npm; then
  print_node_help
  fail "npm was not found."
fi

PACKAGE_SPEC="${ANIMA_PACKAGE_NAME}@${ANIMA_VERSION}"

say "Starting Anima with ${PACKAGE_SPEC}..."

exec npm exec --yes --package "$PACKAGE_SPEC" -- animactl start "$@"
