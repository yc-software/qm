#!/bin/bash
# Sprites boxes boot a stock image with Node but without gh or claude; the wrapper needs all three before its first turn.
set -uo pipefail

NODE_FLOOR="24.15.0"
GH_VERSION="2.93.0"
CLAUDE_VERSION="2.1.210"
GH_SHA_AMD64="02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0"
GH_SHA_ARM64="c55feb33684abba57e9909737340d5b39282257c0363e1edde6785ac4a413be7"

log() { printf '[factory-tools] %s\n' "$*" >&2; }

version_at_least() {
  local have="${1#v}" floor="${2#v}" h f i
  IFS=. read -r -a h <<<"$have"
  IFS=. read -r -a f <<<"$floor"
  for i in 0 1 2; do
    [ "${h[$i]:-0}" -gt "${f[$i]:-0}" ] 2>/dev/null && return 0
    [ "${h[$i]:-0}" -lt "${f[$i]:-0}" ] 2>/dev/null && return 1
  done
  return 0
}

gh_arch() {
  case "$1" in
    x86_64|amd64) printf 'amd64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    *) return 1 ;;
  esac
}

install_dir() {
  local dir="/usr/local/bin"
  if [ -d "$dir" ] && [ -w "$dir" ]; then printf '%s\n' "$dir"; return 0; fi
  log "FAIL: $dir is not writable, so an installed tool would not reach the wrapper"
  return 1
}

install_gh() {
  local arch sha dir tmp
  arch="$(gh_arch "$(uname -m)")" || { log "FAIL: unsupported architecture $(uname -m) for gh"; return 1; }
  case "$arch" in amd64) sha="$GH_SHA_AMD64" ;; arm64) sha="$GH_SHA_ARM64" ;; esac
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/factory-gh.XXXXXX")" || return 1
  if ! curl -fsSL --retry 3 "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" -o "$tmp/gh.tgz"; then
    log "FAIL: could not download gh ${GH_VERSION}"; rm -rf "$tmp"; return 1
  fi
  if ! printf '%s  %s\n' "$sha" "$tmp/gh.tgz" | sha256sum -c - >/dev/null 2>&1; then
    log "FAIL: gh ${GH_VERSION} checksum mismatch"; rm -rf "$tmp"; return 1
  fi
  dir="$(install_dir)" || { rm -rf "$tmp"; return 1; }
  tar xzf "$tmp/gh.tgz" -C "$tmp" \
    && install "$tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" "$dir/gh" || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

install_claude() {
  local -a args=(install -g)
  local out
  if npm install -h 2>&1 | grep -q -- '--allow-scripts'; then args+=("--allow-scripts=@anthropic-ai/claude-code"); fi
  out="$(mktemp "${TMPDIR:-/tmp}/factory-npm.XXXXXX")" || return 1
  if ! npm "${args[@]}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" >"$out" 2>&1; then
    tail -20 "$out" >&2; rm -f "$out"; return 1
  fi
  rm -f "$out"
}

ensure() {
  local node_v installed=""
  command -v node >/dev/null 2>&1 || { log "FAIL: node is not installed"; return 1; }
  node_v="$(node -v 2>/dev/null)"
  if ! version_at_least "$node_v" "$NODE_FLOOR"; then
    log "FAIL: node $node_v is below the ${NODE_FLOOR} floor the factory needs"; return 1
  fi
  if ! command -v gh >/dev/null 2>&1; then
    install_gh || return 1
    installed="$installed gh"
  fi
  if ! command -v claude >/dev/null 2>&1; then
    command -v npm >/dev/null 2>&1 || { log "FAIL: claude is not installed and npm is missing"; return 1; }
    install_claude || { log "FAIL: could not install @anthropic-ai/claude-code@${CLAUDE_VERSION}"; return 1; }
    command -v claude >/dev/null 2>&1 || { log "FAIL: claude is still not on PATH after install"; return 1; }
    installed="$installed claude"
  fi
  [ -n "$installed" ] && log "installed:$installed (node $node_v, gh $(gh --version 2>/dev/null | head -1 | awk '{print $3}'), claude $(claude --version 2>/dev/null | awk '{print $1}'))"
  return 0
}

case "${1:-}" in
  ensure) ensure ;;
  node-ok) version_at_least "${2:?version}" "$NODE_FLOOR" ;;
  gh-arch) gh_arch "${2:?machine}" ;;
  *) printf 'usage: tools.sh ensure | node-ok <version> | gh-arch <uname -m>\n' >&2; exit 2 ;;
esac
