#!/usr/bin/env bash
#
# Rivet installer.
#
#   curl -fsSL https://raw.githubusercontent.com/carboy285/rivet/main/install.sh | bash
#
# Clones Rivet into ~/.rivet (override with RIVET_HOME) and links a `rivet`
# command onto your PATH. Rivet has no third-party runtime dependencies, so
# there is nothing to compile and no npm install step.
#
set -euo pipefail

REPO="carboy285/rivet"
BRANCH="${RIVET_BRANCH:-main}"
INSTALL_DIR="${RIVET_HOME:-$HOME/.rivet}"

info() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }

# --- Requirements -----------------------------------------------------------

if ! command -v git >/dev/null 2>&1; then
  err "Rivet's installer needs git. Install git and run this again."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  err "Rivet needs Node.js 20 or newer."
  err "Install it from https://nodejs.org and run this again."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Rivet needs Node.js 20 or newer. Found $(node -v)."
  err "Update Node.js from https://nodejs.org and run this again."
  exit 1
fi

# --- Fetch ------------------------------------------------------------------

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating Rivet in $INSTALL_DIR ..."
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout -q "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
  info "Installing Rivet into $INSTALL_DIR ..."
  rm -rf "$INSTALL_DIR"
  git clone --quiet --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

chmod +x "$INSTALL_DIR/cli/index.js"

# --- Link the `rivet` command ----------------------------------------------

# Prefer a writable directory that is already on PATH; otherwise fall back to
# ~/.local/bin and tell the user how to add it.
BIN_DIR=""
for dir in "$HOME/.local/bin" "/usr/local/bin" "/opt/homebrew/bin" "$HOME/bin"; do
  case ":$PATH:" in
    *":$dir:"*)
      if [ -d "$dir" ] && [ -w "$dir" ]; then BIN_DIR="$dir"; break; fi
      ;;
  esac
done

ON_PATH=1
if [ -z "$BIN_DIR" ]; then
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
  case ":$PATH:" in
    *":$BIN_DIR:"*) : ;;
    *) ON_PATH=0 ;;
  esac
fi

ln -sf "$INSTALL_DIR/cli/index.js" "$BIN_DIR/rivet"
info "Linked rivet -> $BIN_DIR/rivet"

# --- Done -------------------------------------------------------------------

echo
info "Rivet is installed."

if [ "$ON_PATH" -eq 0 ]; then
  warn "$BIN_DIR is not on your PATH yet. Add this line to your shell profile"
  warn "(~/.zshrc or ~/.bashrc), then open a new terminal:"
  echo
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
  echo
fi

echo "Then, from any project folder, run:"
echo
echo "    rivet"
echo
