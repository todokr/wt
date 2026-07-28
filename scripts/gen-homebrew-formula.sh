#!/usr/bin/env bash
# 使い方: scripts/gen-homebrew-formula.sh <version> <dist_dir>
# dist_dir 内の wt-<target> バイナリから SHA256 を計算し、Homebrew formula (Ruby) を stdout に出力する。
# 出力を Formula/wt.rb に書き出し、tap リポ (todokr/homebrew-tap) にコミットする想定。
set -euo pipefail

VERSION="${1:?version 引数が必要 (例: 0.3.0)}"
DIST="${2:?dist ディレクトリが必要}"

sha() {
  local file="$DIST/$1"
  [ -f "$file" ] || { echo "asset がありません: $file" >&2; exit 1; }
  shasum -a 256 "$file" | awk '{print $1}'
}

SHA_ARM_MAC=$(sha "wt-aarch64-apple-darwin")
SHA_INTEL_MAC=$(sha "wt-x86_64-apple-darwin")
SHA_LINUX=$(sha "wt-x86_64-unknown-linux-gnu")

cat <<EOF
class Wt < Formula
  desc "git worktree switcher with Claude Code history preview"
  homepage "https://github.com/todokr/wt"
  version "${VERSION}"

  depends_on "fzf"

  on_macos do
    on_arm do
      url "https://github.com/todokr/wt/releases/download/v#{version}/wt-aarch64-apple-darwin"
      sha256 "${SHA_ARM_MAC}"

      def install
        bin.install "wt-aarch64-apple-darwin" => "wt"
      end
    end
    on_intel do
      url "https://github.com/todokr/wt/releases/download/v#{version}/wt-x86_64-apple-darwin"
      sha256 "${SHA_INTEL_MAC}"

      def install
        bin.install "wt-x86_64-apple-darwin" => "wt"
      end
    end
  end

  on_linux do
    url "https://github.com/todokr/wt/releases/download/v#{version}/wt-x86_64-unknown-linux-gnu"
    sha256 "${SHA_LINUX}"

    def install
      bin.install "wt-x86_64-unknown-linux-gnu" => "wt"
    end
  end

  def caveats
    <<~CAVEATS
      cd 連携を有効にするには、シェル設定に以下を追記してください:
        eval "\$(wt init zsh)"   # bash なら zsh を bash に置換

      Claude Code の会話履歴プレビューを使うには、~/.claude/projects/ に
      Claude Code のセッション履歴 (.jsonl) が存在している必要があります。
    CAVEATS
  end

  test do
    # wt init zsh は git repo に依存しないため brew test で使いやすい
    assert_match "wt シェル統合", shell_output("#{bin}/wt init zsh")
  end
end
EOF
