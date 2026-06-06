#!/bin/sh
# Vesper installer — fetch a release, install dependencies with Bun, and put the
# `vesper` command on your PATH. POSIX sh, no bashisms.
#
#   curl -fsSL https://raw.githubusercontent.com/ogarciarevett/vesper/main/install.sh | sh
#
# Trust note: piping a script to a shell runs code you have not read. You can
# instead download it, read it, then run it:
#   curl -fsSL https://raw.githubusercontent.com/ogarciarevett/vesper/main/install.sh -o install.sh
#   less install.sh && sh install.sh
#
# Options:
#   --version <tag>   install a specific release tag (default: latest release, else main)
#   --with-whatsapp   also install the opt-in WhatsApp-Web channel (Baileys; larger)
#   --yes, -y         do not prompt (e.g. to auto-install Bun)
#   --dry-run         print every step without changing anything
#   --tarball <path>  install from a local source tarball instead of downloading
#   --help, -h        show this help
#
# Environment overrides (advanced / testing):
#   VESPER_REPO     owner/name           (default: ogarciarevett/vesper)
#   VESPER_PREFIX   install directory    (default: $HOME/.local/share/vesper)
#   VESPER_BIN_DIR  where `vesper` links (default: $HOME/.local/bin)
set -eu

REPO="${VESPER_REPO:-ogarciarevett/vesper}"
PREFIX="${VESPER_PREFIX:-$HOME/.local/share/vesper}"
BIN_DIR="${VESPER_BIN_DIR:-$HOME/.local/bin}"
VERSION=""
ASSUME_YES=0
DRY_RUN=0
WITH_WHATSAPP=0
LOCAL_TARBALL=""

# Colors only when stdout is a terminal.
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RESET=""
fi

log()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
err()  { printf 'error: %s\n' "$1" >&2; }

# Run a command, or just print it under --dry-run.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    %s[dry-run]%s %s\n' "$DIM" "$RESET" "$*"
  else
    "$@"
  fi
}

usage() {
  sed -n '2,30p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || printf 'see the script header for usage\n'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:?--version needs a tag}"; shift 2 ;;
    --version=*) VERSION="${1#*=}"; shift ;;
    --tarball) LOCAL_TARBALL="${2:?--tarball needs a path}"; shift 2 ;;
    --tarball=*) LOCAL_TARBALL="${1#*=}"; shift ;;
    --with-whatsapp) WITH_WHATSAPP=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) err "unknown option: $1"; usage; exit 1 ;;
  esac
done

# 1. Never run as root — Vesper is per-user and writes to $HOME.
if [ "$(id -u)" = "0" ]; then
  err "refusing to run as root. Install Vesper as your normal user."
  exit 1
fi

# 2. Bun is required (Hard rule 8). Offer the official installer, surfaced — never silent.
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    note "found bun $(bun --version)"
    return 0
  fi
  log "Bun is required but was not found."
  note "Vesper would install it via the official installer: curl -fsSL https://bun.sh/install | bash"
  if [ "$ASSUME_YES" -ne 1 ]; then
    printf '    install Bun now? [y/N] '
    read -r reply </dev/tty 2>/dev/null || reply=""
    case "$reply" in
      y|Y|yes|YES) : ;;
      *) err "Bun is required. Install it from https://bun.sh and re-run."; exit 1 ;;
    esac
  fi
  run sh -c 'curl -fsSL https://bun.sh/install | bash'
  # The Bun installer drops the binary here; make it visible to the rest of this run.
  BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin"
  if [ -x "$BUN_BIN/bun" ]; then PATH="$BUN_BIN:$PATH"; export PATH; fi
  command -v bun >/dev/null 2>&1 || { err "Bun install did not put 'bun' on PATH. Open a new shell and re-run."; exit 1; }
}

# 3. Resolve the source tarball URL for the requested (or latest) version.
resolve_tarball_url() {
  if [ -n "$VERSION" ]; then
    printf 'https://github.com/%s/archive/refs/tags/%s.tar.gz\n' "$REPO" "$VERSION"
    return 0
  fi
  # No version pinned: ask the GitHub API for the latest release tag; fall back to main.
  tag="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
          | grep '"tag_name"' | head -n1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  if [ -n "$tag" ]; then
    note "latest release: $tag"
    printf 'https://github.com/%s/archive/refs/tags/%s.tar.gz\n' "$REPO" "$tag"
  else
    note "no published release found — installing the main branch"
    printf 'https://github.com/%s/archive/refs/heads/main.tar.gz\n' "$REPO"
  fi
}

main() {
  ensure_bun

  tmp="$(mktemp -d "${TMPDIR:-/tmp}/vesper-install.XXXXXX")"
  # shellcheck disable=SC2064  # expand tmp now so the trap cleans the right dir.
  trap "rm -rf '$tmp'" EXIT INT TERM
  tarball="$tmp/vesper-src.tar.gz"

  if [ -n "$LOCAL_TARBALL" ]; then
    log "Using local tarball: $LOCAL_TARBALL"
    run cp "$LOCAL_TARBALL" "$tarball"
  else
    url="$(resolve_tarball_url)"
    log "Downloading $url"
    run curl -fsSL "$url" -o "$tarball"
  fi

  log "Extracting"
  run mkdir -p "$tmp/src"
  # GitHub tarballs nest everything under one top-level dir; strip it.
  run tar -xzf "$tarball" -C "$tmp/src" --strip-components 1

  # 4. Place the source at $PREFIX. Re-install = archive the old tree (no silent rm).
  if [ -e "$PREFIX" ]; then
    backup="$PREFIX.bak.$(date +%Y%m%d%H%M%S)"
    log "Existing install found — archiving to $backup"
    run mv "$PREFIX" "$backup"
  fi
  run mkdir -p "$(dirname "$PREFIX")"
  run mv "$tmp/src" "$PREFIX"

  log "Installing dependencies with Bun"
  if [ "$WITH_WHATSAPP" -eq 1 ]; then
    note "including the opt-in WhatsApp-Web channel"
    run sh -c "cd '$PREFIX' && bun install --production"
  else
    note "skipping the opt-in WhatsApp-Web channel (re-run with --with-whatsapp to include it)"
    run sh -c "cd '$PREFIX' && bun install --production --omit=optional"
  fi

  # 5. Expose `vesper` on PATH via a symlink to the CLI entry (it carries its own
  #    `#!/usr/bin/env bun` shebang, so it must be executable).
  entry="$PREFIX/packages/vesper-cli/src/index.ts"
  log "Linking vesper -> $BIN_DIR/vesper"
  run chmod +x "$entry"
  run mkdir -p "$BIN_DIR"
  run ln -sf "$entry" "$BIN_DIR/vesper"

  printf '\n%sVesper installed.%s\n' "$BOLD" "$RESET"
  case ":$PATH:" in
    *":$BIN_DIR:"*) : ;;
    *) note "add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  note "next:  vesper init   # creates ~/.vesper (you stay in control — not done automatically)"
  note "then:  vesper hello  # proves your CLI orchestration works"
}

main
