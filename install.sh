#!/bin/sh
# wt インストールスクリプト
# GitHub Releases から自分のプラットフォーム用バイナリを取得して ~/.local/bin/wt に配置する。
#
# 使い方:
#   curl -fsSL https://raw.githubusercontent.com/todokr/wt/main/install.sh | sh
#   (private リポジトリの場合は gh CLI 認証済みの環境で:
#    gh api repos/todokr/wt/contents/install.sh -q .content | base64 -d | sh)
set -eu

REPO="${WT_REPO:-todokr/wt}"
INSTALL_DIR="${WT_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  TARGET="aarch64-apple-darwin" ;;
  Darwin-x86_64) TARGET="x86_64-apple-darwin" ;;
  Linux-x86_64)  TARGET="x86_64-unknown-linux-gnu" ;;
  *) echo "未対応のプラットフォームです: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$INSTALL_DIR"
ASSET="wt-$TARGET"

if command -v gh >/dev/null 2>&1; then
  # private リポジトリでも gh の認証で取得できる
  gh release download --repo "$REPO" --pattern "$ASSET" --output "$INSTALL_DIR/wt" --clobber
else
  curl -fL "https://github.com/$REPO/releases/latest/download/$ASSET" -o "$INSTALL_DIR/wt"
fi
chmod +x "$INSTALL_DIR/wt"

echo "インストールしました: $INSTALL_DIR/wt"
echo ""
echo "セットアップ (fzf が必要です: brew install fzf):"
echo "  1. $INSTALL_DIR が PATH に含まれているか確認"
echo "  2. .zshrc に以下を追記:"
echo '       eval "$(wt init zsh)"'
