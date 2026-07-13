# wt — 開発用シェル統合 (deno run 直呼び)
# 通常利用はコンパイル済みバイナリ + `eval "$(wt init zsh)"` を推奨。
# main.ts を編集しながら試すときだけ .zshrc でこれを source する:
#   source /Users/shunsuke.tadokoro/git-project/wt-cli/wt.sh

WT_CLI_MAIN="${WT_CLI_MAIN:-${0:A:h}/main.ts}"

wt() {
  local dest
  dest=$(deno run -A "$WT_CLI_MAIN" "$@") || return $?
  if [[ $# -eq 0 && -n "$dest" && -d "$dest" ]]; then
    cd "$dest"
  elif [[ -n "$dest" ]]; then
    print -r -- "$dest"
  fi
}
