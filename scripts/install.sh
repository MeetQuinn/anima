#!/bin/sh
set -eu

ANIMA_PACKAGE_NAME="${ANIMA_PACKAGE_NAME:-@meetquinn/animactl}"
ANIMA_VERSION_DEFAULT="latest"
ANIMA_VERSION="${ANIMA_VERSION:-$ANIMA_VERSION_DEFAULT}"
ANIMA_MIN_NODE_VERSION="${ANIMA_MIN_NODE_VERSION:-22.13}"

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

# Exits 0 when the installed Node is at least ANIMA_MIN_NODE_VERSION (major.minor).
node_meets_minimum() {
  node -e "const [wantMajor, wantMinor] = process.argv[1].split('.').map(Number); const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > wantMajor || (major === wantMajor && minor >= wantMinor) ? 0 : 1);" "$ANIMA_MIN_NODE_VERSION"
}

print_node_help() {
  cat >&2 <<'EOF'

Anima needs Node.js 22.13 or newer. Node includes npm, which Anima uses to
download and run the managed runtime package.

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

if ! node_meets_minimum 2>/dev/null; then
  print_node_help
  fail "Node.js $ANIMA_MIN_NODE_VERSION or newer is required; found $(node --version 2>/dev/null || echo unknown)."
fi

if ! have npm; then
  print_node_help
  fail "npm was not found."
fi

PACKAGE_SPEC="${ANIMA_PACKAGE_NAME}@${ANIMA_VERSION}"

say "Starting Anima with ${PACKAGE_SPEC}..."

exec npm exec --yes --package "$PACKAGE_SPEC" -- animactl start "$@"
