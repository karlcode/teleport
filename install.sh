#!/bin/sh
# Installs tlpt, teleport's command (also as tp and teleport), as one native executable that needs no Node:
#
#   curl -fsSL https://raw.githubusercontent.com/karlcode/teleport/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/karlcode/teleport/main/install.sh | sh -s 0.2.0
#
# It downloads the build for this machine from the GitHub release, checks it against the release's
# SHA256SUMS, puts it in ~/.local/bin and adds that folder to PATH in your shell's startup file, once.
# Run it again to update. With Node installed, `npm install -g tlpt` gives the same command.
#
#   TLPT_INSTALL_DIR=<dir>    install there instead of ~/.local/bin
#   TLPT_NO_MODIFY_PATH=1     leave shell startup files alone; print the line to add instead
set -eu

REPO="karlcode/teleport"
VERSION="${1:-latest}"
BASE="${TLPT_BASE_URL:-https://github.com/$REPO/releases}"
DIR="${TLPT_INSTALL_DIR:-$HOME/.local/bin}"

fail() { echo "tlpt install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) fail "on Windows, install with npm: npm install -g tlpt" ;;
  *) fail "no build for $(uname -s); with Node 20 or later: npm install -g tlpt" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no build for $(uname -m); with Node 20 or later: npm install -g tlpt" ;;
esac
# An x64 shell under Rosetta on Apple silicon still wants the arm64 build.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
# Node's official builds, which these are made from, need glibc; Alpine and other musl systems use npm.
if [ "$os" = linux ] && { ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; }; then
  fail "this system uses musl (Alpine?), which the builds don't run on; with Node 20 or later: npm install -g tlpt"
fi
asset="tlpt-$os-$arch.gz"

if [ "$VERSION" = latest ]; then url="$BASE/latest/download"; else url="$BASE/download/v${VERSION#v}"; fi
if command -v curl >/dev/null 2>&1; then get() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then get() { wget -qO "$2" "$1"; }
else fail "needs curl or wget"; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $asset ($VERSION)..."
get "$url/$asset" "$tmp/$asset" || fail "download failed: $url/$asset"
get "$url/SHA256SUMS" "$tmp/SHA256SUMS" || fail "download failed: $url/SHA256SUMS"
want="$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then have="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"; else have="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"; fi
[ -n "$want" ] && [ "$want" = "$have" ] || fail "checksum mismatch for $asset: the download is not what the release published"

mkdir -p "$DIR"
gunzip -c "$tmp/$asset" > "$tmp/tlpt"
chmod 755 "$tmp/tlpt"
"$tmp/tlpt" --version >/dev/null 2>&1 || fail "the downloaded tlpt does not run on this machine"
# Moved in whole, so a tlpt already running keeps its old file and the new one is never half written.
mv -f "$tmp/tlpt" "$DIR/tlpt"
echo "Installed $("$DIR/tlpt" --version) to $DIR/tlpt"
# tp and teleport are the same command, as links. A name another program already has is left to it.
for alias in tp teleport; do
  if [ ! -e "$DIR/$alias" ] || [ "$(readlink "$DIR/$alias" 2>/dev/null)" = tlpt ]; then
    ln -sf tlpt "$DIR/$alias"
  else
    echo "Left $DIR/$alias alone: another program has that name. tlpt is the same command."
  fi
done

case ":$PATH:" in *":$DIR:"*) echo "Run: tlpt --help"; exit 0 ;; esac
line="export PATH=\"$DIR:\$PATH\""
case "$(basename "${SHELL:-sh}")" in
  zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash) if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
  fish) rc="$HOME/.config/fish/conf.d/tlpt.fish"; line="fish_add_path \"$DIR\"" ;;
  *) rc="$HOME/.profile" ;;
esac
if [ "${TLPT_NO_MODIFY_PATH:-0}" = 1 ]; then
  echo "$DIR is not on your PATH. Add this line to $rc:"
  echo "  $line"
  exit 0
fi
mkdir -p "$(dirname "$rc")"
grep -qsF "$line" "$rc" || printf '\n# tlpt\n%s\n' "$line" >> "$rc"
echo "Added $DIR to PATH in $rc. Open a new terminal, or run:"
echo "  $line"
