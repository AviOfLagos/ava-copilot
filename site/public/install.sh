#!/bin/sh
# Avi Copilot installer for macOS and Linux.
#
# Downloads the latest release, verifies its SHA-256, and unpacks it to a stable folder so the
# browser's own "Load unpacked" always points at the same place — re-running this script later is
# how you update (it overwrites the files in that folder; you still click Reload on the extensions
# page, because Chrome does not watch an unpacked folder for changes).
#
# Usage:
#   curl -fsSL https://avi-copilot.vercel.app/install.sh | bash
#   curl -fsSL https://avi-copilot.vercel.app/install.sh | sh
#   sh install.sh [options]
#
# Options:
#   --dir PATH         Install into PATH instead of the default per-OS location.
#   --browser NAME     brave | chrome | edge | chromium — which browser's extensions page to try to
#                       open and whose name to print in the instructions. Default: auto-detect.
#   --with-voices      Also fetch the local voice and wake-word models (~70 MB) into the installed
#                       folder, from the same pinned sources and SHA-256s the project's own setup
#                       scripts use. Needs Node.js on PATH; skipped with a warning if it's missing.
#   --uninstall        Remove the installed folder and exit.
#   --version          Print the latest available version (and the installed one, if any) and exit.
#   --yes, -y          Don't ask for confirmation (used by --uninstall).
#   --no-open          Don't open the browser or touch the clipboard; just print the steps.
#   --help, -h         Print this message and exit.
#
# Env:
#   AVI_COPILOT_BASE_URL   Overrides the download host, e.g. for testing against a local server:
#                          AVI_COPILOT_BASE_URL=http://127.0.0.1:8080 sh install.sh --dir /tmp/test
#
# This targets a normal macOS or Linux shell: curl or wget, shasum or sha256sum, and unzip, all of
# which ship on macOS and nearly every Linux desktop/server distribution by default. `set -eu` and
# plain `[ ]`/`case` keep the shell logic itself portable across dash, bash and ash.
set -eu

# Everything is inside this one function, called only at the very end of the file. That way, if
# `curl | sh` is cut off mid-download, the shell has a truncated *function body* with no closing
# brace — a syntax error — and runs nothing, rather than executing whatever partial script it got.
main() {
  BASE_URL="${AVI_COPILOT_BASE_URL:-https://avi-copilot.vercel.app}"
  BASE_URL="${BASE_URL%/}"
  TARGET_DIR=""
  BROWSER_CHOICE=""
  WITH_VOICES=0
  DO_UNINSTALL=0
  SHOW_VERSION=0
  ASSUME_YES=0
  NO_OPEN=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --dir)
        [ $# -ge 2 ] || die "--dir needs a path"
        TARGET_DIR="$2"
        shift 2
        ;;
      --dir=*) TARGET_DIR="${1#--dir=}"; shift ;;
      --browser)
        [ $# -ge 2 ] || die "--browser needs a name (brave, chrome, edge or chromium)"
        BROWSER_CHOICE="$2"
        shift 2
        ;;
      --browser=*) BROWSER_CHOICE="${1#--browser=}"; shift ;;
      --with-voices) WITH_VOICES=1; shift ;;
      --uninstall) DO_UNINSTALL=1; shift ;;
      --version) SHOW_VERSION=1; shift ;;
      --yes | -y) ASSUME_YES=1; shift ;;
      --no-open) NO_OPEN=1; shift ;;
      --help | -h) usage; return 0 ;;
      *) die "Unknown argument: $1 (see --help)" ;;
    esac
  done

  case "$BROWSER_CHOICE" in
    "" | brave | chrome | edge | chromium) ;;
    *) die "--browser must be one of: brave, chrome, edge, chromium (got: $BROWSER_CHOICE)" ;;
  esac

  [ -n "$TARGET_DIR" ] || TARGET_DIR="$(default_target_dir)"
  # A literal leading "~" in --dir (the shell already expands an unquoted one before we see it, but
  # --dir=~/foo may reach us unexpanded). The quoting below is deliberate: it keeps "~" literal for
  # the match instead of letting the shell try to expand it, which is exactly what's wanted here.
  # shellcheck disable=SC2088
  case "$TARGET_DIR" in
    "~") TARGET_DIR="$HOME" ;;
    "~/"*) TARGET_DIR="$HOME/${TARGET_DIR#"~/"}" ;;
  esac

  # No trailing slashes, so the checks below compare like with like
  while :; do
    case "$TARGET_DIR" in
      */) TARGET_DIR="${TARGET_DIR%/}" ;;
      *) break ;;
    esac
  done

  if [ "$SHOW_VERSION" -eq 1 ]; then
    print_version
    return 0
  fi

  # Install and uninstall replace or remove the folder: only ever one this script made
  guard_target

  if [ "$DO_UNINSTALL" -eq 1 ]; then
    do_uninstall
    return 0
  fi

  need_tool curl_or_wget "curl or wget" "to download the release"
  need_tool sha256_tool "shasum or sha256sum" "to verify it"
  need_tool unzip "unzip" "to install it"

  WORK_DIR="$(mktemp -d)"
  trap 'rm -rf "$WORK_DIR"' EXIT INT TERM HUP

  info "Checking the latest release at $BASE_URL ..."
  LATEST_JSON="$WORK_DIR/latest.json"
  fetch "$BASE_URL/download/latest.json" "$LATEST_JSON" \
    || die "Could not reach $BASE_URL/download/latest.json. Check your connection, or that AVI_COPILOT_BASE_URL is right, and try again."

  VERSION="$(json_string "$LATEST_JSON" version)"
  ZIP_PATH_REL="$(json_string "$LATEST_JSON" file)"
  ZIP_SHA256="$(json_string "$LATEST_JSON" sha256)"
  [ -n "$VERSION" ] && [ -n "$ZIP_PATH_REL" ] && [ -n "$ZIP_SHA256" ] \
    || die "$BASE_URL/download/latest.json is missing version, file or sha256 - this installer and the site may be out of sync."

  INSTALLED_VERSION="$(installed_version)"
  if [ -n "$INSTALLED_VERSION" ]; then
    info "Avi Copilot $INSTALLED_VERSION is installed at $TARGET_DIR; updating to ${VERSION}..."
  else
    info "Installing Avi Copilot $VERSION to ${TARGET_DIR}..."
  fi

  ZIP_FILE="$WORK_DIR/avi-copilot.zip"
  fetch "$BASE_URL/$ZIP_PATH_REL" "$ZIP_FILE" || die "Could not download $BASE_URL/$ZIP_PATH_REL."

  GOT_SHA256="$(sha256_of "$ZIP_FILE")"
  if [ "$GOT_SHA256" != "$ZIP_SHA256" ]; then
    die "Downloaded file does not match the published checksum.
  expected: $ZIP_SHA256
       got: $GOT_SHA256
The download may be incomplete or corrupted - try again. If this keeps happening, something is wrong on the server side; please report it."
  fi
  ok "Checksum verified."

  EXTRACT_DIR="$WORK_DIR/extracted"
  mkdir -p "$EXTRACT_DIR"
  unzip -q -o "$ZIP_FILE" -d "$EXTRACT_DIR" || die "The downloaded zip could not be unpacked (it may be corrupted). Try again."
  [ -f "$EXTRACT_DIR/manifest.json" ] || die "The downloaded release doesn't look like an extension (no manifest.json) - please report this."
  # The marker that lets a later update or --uninstall know this folder is ours to replace
  printf 'Installed by the Avi Copilot installer. Remove the folder with: install.sh --uninstall\n' >"$EXTRACT_DIR/$MARKER"

  mkdir -p "$(dirname "$TARGET_DIR")"
  SWAP_DIR="${TARGET_DIR}.new.$$"
  rm -rf "$SWAP_DIR"
  mv "$EXTRACT_DIR" "$SWAP_DIR"
  rm -rf "$TARGET_DIR"
  mv "$SWAP_DIR" "$TARGET_DIR"
  ok "Installed Avi Copilot $VERSION to $TARGET_DIR"

  if [ "$WITH_VOICES" -eq 1 ]; then
    install_voices "$LATEST_JSON"
  fi

  announce_next_steps
}

# ---- output helpers --------------------------------------------------------------------------

# A file the installer puts in every folder it makes. An update or --uninstall only ever replaces or
# removes a folder that is missing, empty, or has this file: never a folder of the user's own.
MARKER="avi-copilot-install.txt"

# Whether a folder may be replaced or removed by this script (see MARKER)
is_ours() { # is_ours DIR
  [ -e "$1" ] || return 0
  [ -d "$1" ] || return 1
  [ -f "$1/$MARKER" ] && return 0
  [ -z "$(ls -A "$1" 2>/dev/null)" ]
}

guard_target() {
  case "$TARGET_DIR" in
    "" | "/" | "$HOME") die "Refusing to install into ${TARGET_DIR:-/}: give it a folder of its own, e.g. --dir \"$HOME/avi-copilot\"." ;;
  esac
  case "$HOME/" in
    "$TARGET_DIR"/*) die "Refusing to use $TARGET_DIR: your home folder is inside it." ;;
  esac
  is_ours "$TARGET_DIR" ||
    die "$TARGET_DIR already exists and was not made by this installer, so it is left alone. Pick a new or empty folder with --dir."
}

info() { printf '%s\n' "$*"; }
ok() { printf '\033[32mOK\033[0m %s\n' "$*"; }
warn() { printf '\033[33mWarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31mError:\033[0m %s\n' "$*" >&2
  exit 1
}

usage() {
  # Not read from the script's own header comment: $0 isn't a readable file when this runs from a
  # pipe (`curl ... | sh`), which is the primary documented way to run it.
  cat <<'USAGE'
Avi Copilot installer for macOS and Linux.

Usage:
  curl -fsSL https://avi-copilot.vercel.app/install.sh | bash
  curl -fsSL https://avi-copilot.vercel.app/install.sh | sh
  sh install.sh [options]

Options:
  --dir PATH         Install into PATH instead of the default per-OS location.
  --browser NAME     brave | chrome | edge | chromium - which browser's extensions page to try to
                      open and whose name to print in the instructions. Default: auto-detect.
  --with-voices      Also fetch the local voice and wake-word models (~70 MB) into the installed
                      folder, from the same pinned sources and SHA-256s the project's own setup
                      scripts use. Needs Node.js on PATH; skipped with a warning if it's missing.
  --uninstall        Remove the installed folder and exit.
  --version          Print the latest available version (and the installed one, if any) and exit.
  --yes, -y          Don't ask for confirmation (used by --uninstall).
  --no-open          Don't open the browser or touch the clipboard; just print the steps.
  --help, -h         Print this message and exit.

Env:
  AVI_COPILOT_BASE_URL   Overrides the download host, e.g. for testing against a local server:
                         AVI_COPILOT_BASE_URL=http://127.0.0.1:8080 sh install.sh --dir /tmp/test

Default install location:
  macOS:  ~/Library/Application Support/Avi Copilot/extension
  Linux:  ${XDG_DATA_HOME:-~/.local/share}/avi-copilot/extension
USAGE
}

# ---- lookups ---------------------------------------------------------------------------------

default_target_dir() {
  case "$(uname -s)" in
    Darwin) printf '%s' "$HOME/Library/Application Support/Avi Copilot/extension" ;;
    *) printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/avi-copilot/extension" ;;
  esac
}

need_tool() { # need_tool CHECK_FN LABEL PURPOSE
  if ! "$1" >/dev/null 2>&1; then
    die "Need $2 $3. Install it and try again."
  fi
}

curl_or_wget() { command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; }
sha256_tool() { command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1; }

fetch() { # fetch URL DEST
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  else
    wget -q "$1" -O "$2"
  fi
}

sha256_of() { # sha256_of FILE -> hex digest on stdout
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# A minimal, deliberately narrow JSON reader for this project's own flat latest.json: it only ever
# needs one top-level or one-level-nested string field at a time, so it doesn't need a parser.
json_string() { # json_string FILE KEY -> the string value of "KEY": "..." (top-level anywhere in the file)
  grep -o "\"$2\"[   ]*:[   ]*\"[^\"]*\"" "$1" 2>/dev/null | head -n1 | sed -E 's/.*:[   ]*"([^"]*)"/\1/'
}

installed_version() {
  [ -f "$TARGET_DIR/manifest.json" ] || return 0
  json_string "$TARGET_DIR/manifest.json" version
}

print_version() {
  WORK_DIR="$(mktemp -d)"
  trap 'rm -rf "$WORK_DIR"' EXIT INT TERM HUP
  if fetch "$BASE_URL/download/latest.json" "$WORK_DIR/latest.json" 2>/dev/null; then
    LATEST="$(json_string "$WORK_DIR/latest.json" version)"
    DATE="$(json_string "$WORK_DIR/latest.json" date)"
    info "latest: ${LATEST:-unknown}${DATE:+ (released $DATE)}"
  else
    warn "Could not reach $BASE_URL to check the latest version."
  fi
  INSTALLED="$(installed_version)"
  if [ -n "$INSTALLED" ]; then
    info "installed: $INSTALLED ($TARGET_DIR)"
  else
    info "installed: (none) - default location is $TARGET_DIR"
  fi
}

# ---- uninstall --------------------------------------------------------------------------------

do_uninstall() {
  if [ ! -e "$TARGET_DIR" ]; then
    info "Nothing installed at $TARGET_DIR."
    return 0
  fi
  if [ "$ASSUME_YES" -ne 1 ]; then
    # /dev/tty can exist (so -r passes) but still fail to open with no controlling terminal at all
    # (common for CI, automation, `curl | sh` with stdin otherwise occupied) — actually try it
    # rather than trust the permission bit, so that case falls through to the --yes message below
    # instead of crashing on an unguarded redirection.
    if { : </dev/tty; } 2>/dev/null; then
      printf 'Remove %s? [y/N] ' "$TARGET_DIR" >/dev/tty
      read -r REPLY </dev/tty || REPLY=""
      case "$REPLY" in
        y | Y | yes | YES) ;;
        *)
          info "Cancelled."
          return 0
          ;;
      esac
    else
      die "Refusing to uninstall without confirmation in a non-interactive shell. Re-run with --yes."
    fi
  fi
  rm -rf "$TARGET_DIR"
  ok "Removed $TARGET_DIR"
}

# ---- optional local voice / wake-word models ------------------------------------------------

install_voices() { # install_voices LATEST_JSON_FILE
  latest_json="$1"
  if ! command -v node >/dev/null 2>&1; then
    warn "--with-voices needs Node.js on PATH; skipping. Install it from https://nodejs.org, then re-run with --with-voices."
    return 0
  fi

  # json_string alone would match the first "file"/"sha256" key anywhere in the file, which is the
  # top-level release zip's, not the nested setupScripts entries — so narrow to each sub-object first.
  wake_rel="$(nested_json_string "$latest_json" wakeWordSetup file)"
  wake_sha="$(nested_json_string "$latest_json" wakeWordSetup sha256)"
  voice_rel="$(nested_json_string "$latest_json" voiceModelsSetup file)"
  voice_sha="$(nested_json_string "$latest_json" voiceModelsSetup sha256)"

  if [ -z "$wake_rel" ] || [ -z "$voice_rel" ]; then
    warn "This server's latest.json has no setup-script entries; skipping --with-voices. Try updating the installer."
    return 0
  fi

  info "Fetching the local voice and wake-word models (downloads roughly 70 MB from Hugging Face, npm and alphacephei.com)..."
  voices_work="$(mktemp -d)"
  mkdir -p "$voices_work/scripts" "$voices_work/public"

  if fetch_verified "$BASE_URL/$wake_rel" "$voices_work/scripts/wake-word-setup.mjs" "$wake_sha" \
    && (cd "$voices_work/scripts" && node wake-word-setup.mjs) \
    && [ -d "$voices_work/public/wake" ]; then
    rm -rf "$TARGET_DIR/wake"
    mv "$voices_work/public/wake" "$TARGET_DIR/wake"
    ok "Wake-word model installed."
  else
    warn "Could not set up the wake-word model; continuing without it."
  fi

  if fetch_verified "$BASE_URL/$voice_rel" "$voices_work/scripts/voice-models-setup.mjs" "$voice_sha" \
    && (cd "$voices_work/scripts" && node voice-models-setup.mjs) \
    && [ -d "$voices_work/public/voice" ]; then
    rm -rf "$TARGET_DIR/voice"
    mv "$voices_work/public/voice" "$TARGET_DIR/voice"
    ok "Local voices installed."
  else
    warn "Could not set up the local voices; continuing without them."
  fi

  rm -rf "$voices_work"
}

# Reads "KEY": { ... "FIELD": "value" ... } for one specific nested object by name, by narrowing to
# the text from KEY's opening brace to its first closing brace before applying json_string.
nested_json_string() { # nested_json_string FILE KEY FIELD
  awk -v key="\"$2\"" 'index($0,key){grab=1} grab{print; if(/}/){exit}}' "$1" >"$1.$2.tmp" 2>/dev/null || true
  json_string "$1.$2.tmp" "$3"
  rm -f "$1.$2.tmp"
}

fetch_verified() { # fetch_verified URL DEST SHA256
  fetch "$1" "$2" || {
    warn "Could not download $1"
    return 1
  }
  got="$(sha256_of "$2")"
  if [ "$got" != "$3" ]; then
    warn "Checksum mismatch for $1 (expected $3, got $got)"
    rm -f "$2"
    return 1
  fi
}

# ---- browser detection and the final instructions -----------------------------------------

detect_browsers() { # prints found browser keys, one per line
  if [ "$(uname -s)" = Darwin ]; then
    [ -d "/Applications/Brave Browser.app" ] && echo brave
    [ -d "/Applications/Google Chrome.app" ] && echo chrome
    [ -d "/Applications/Microsoft Edge.app" ] && echo edge
    [ -d "/Applications/Chromium.app" ] && echo chromium
  else
    command -v brave-browser >/dev/null 2>&1 && echo brave
    command -v google-chrome >/dev/null 2>&1 && echo chrome
    command -v microsoft-edge >/dev/null 2>&1 && echo edge
    { command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; } && echo chromium
  fi
  return 0
}

browser_label() {
  case "$1" in
    brave) echo "Brave" ;;
    chrome) echo "Chrome" ;;
    edge) echo "Edge" ;;
    chromium) echo "Chromium" ;;
  esac
}

# Opens BROWSER's own extensions page, macOS via `open -a`, Linux by invoking the browser binary
# with the URL as its argument — both are the normal, documented way to hand a running (or
# not-yet-running) Chromium-family browser a URL to show; verified on this machine with Brave on
# macOS (an already-running instance opens it as a new tab; `open -a` is what a plain end-user
# install script should use, rather than invoking the app bundle's binary directly).
open_extensions_page() { # open_extensions_page BROWSER_KEY
  url="$1://extensions"
  [ "$1" = chromium ] && url="chrome://extensions"
  if [ "$(uname -s)" = Darwin ]; then
    case "$1" in
      brave) app="Brave Browser" ;;
      chrome) app="Google Chrome" ;;
      edge) app="Microsoft Edge" ;;
      chromium) app="Chromium" ;;
      *) return 1 ;;
    esac
    open -a "$app" "$url" >/dev/null 2>&1
    return $?
  fi
  bin=""
  case "$1" in
    brave) command -v brave-browser >/dev/null 2>&1 && bin=brave-browser ;;
    chrome) command -v google-chrome >/dev/null 2>&1 && bin=google-chrome ;;
    edge) command -v microsoft-edge >/dev/null 2>&1 && bin=microsoft-edge ;;
    chromium)
      command -v chromium >/dev/null 2>&1 && bin=chromium
      [ -z "$bin" ] && command -v chromium-browser >/dev/null 2>&1 && bin=chromium-browser
      ;;
  esac
  [ -n "$bin" ] || return 1
  "$bin" "$url" >/dev/null 2>&1 &
  return 0
}

copy_to_clipboard() { # copy_to_clipboard TEXT -> 0 if copied
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$1" | pbcopy
    return 0
  fi
  if command -v xclip >/dev/null 2>&1; then
    printf '%s' "$1" | xclip -selection clipboard
    return 0
  fi
  if command -v xsel >/dev/null 2>&1; then
    printf '%s' "$1" | xsel --clipboard --input
    return 0
  fi
  if command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$1" | wl-copy
    return 0
  fi
  return 1
}

announce_next_steps() {
  found="$(detect_browsers || true)"
  target_key="$BROWSER_CHOICE"
  if [ -z "$target_key" ]; then
    target_key="$(printf '%s\n' "$found" | head -n1)"
  fi

  copied=0
  if [ "$NO_OPEN" -ne 1 ]; then
    copy_to_clipboard "$TARGET_DIR" && copied=1
  fi

  printf '\n'
  if [ -n "$target_key" ]; then
    label="$(browser_label "$target_key")"
    info "Finish it in $label:"
  else
    info "Finish it in your browser (Brave, Chrome and Edge all work the same way):"
  fi
  info "  1. Open the extensions page (chrome://extensions, brave://extensions or edge://extensions)"
  info "  2. Turn on \"Developer mode\" (top-right toggle)"
  if [ "$copied" -eq 1 ]; then
    info "  3. Click \"Load unpacked\" and paste the folder path (already copied to your clipboard):"
  else
    info "  3. Click \"Load unpacked\" and choose this folder:"
  fi
  info "       $TARGET_DIR"

  if [ -n "$target_key" ] && [ "$NO_OPEN" -ne 1 ]; then
    if open_extensions_page "$target_key"; then
      printf '\n'
      info "Opened the extensions page for you."
    fi
  fi
}
# ---- entry point ------------------------------------------------------------------------------
main "$@"
