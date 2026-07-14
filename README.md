# wt

git worktree を fzf で一覧・切り替え・削除できる CLI。
各 worktree について、そこで行われた **Claude Code への直近の指示・実行コマンド** をプレビュー表示する。

deno compile による単一バイナリで配布するため、利用者に Deno は不要。
実行時に必要なのは **fzf と git だけ**（`brew install fzf`）。

## インストール（利用者向け）

```sh
# GitHub Releases から取得 (private リポジトリなら gh CLI 認証済み環境で)
curl -fsSL https://raw.githubusercontent.com/todokr/wt/main/install.sh | sh
```

または Releases ページから自分のプラットフォームのバイナリ（対応一覧は「開発・リリース」節を参照）を
ダウンロードし、PATH の通った場所に `wt` として置いて `chmod +x` する。

セットアップとして `.zshrc` に1行追記:

```sh
eval "$(wt init zsh)"
```

（cd はシェル関数でしか実現できないため、zoxide などと同じ init 方式を採用。bash は `wt init bash`）

## アンインストール

```sh
rm ~/.local/bin/wt
```

（`WT_INSTALL_DIR` を指定してインストールした場合はそのディレクトリの `wt` を削除）

あわせて `.zshrc` に追記した以下の行を削除:

```sh
eval "$(wt init zsh)"
```

## 使い方

git リポジトリ内で:

```sh
wt              # 全 worktree から選択
wt <キーワード>  # Claude との会話にキーワードを含む worktree に絞って選択
```

fzf が起動し、カレントリポジトリの worktree 一覧が表示される。
キーワード指定時はプレビュー内の該当箇所がハイライトされる。

| キー | 動作 |
| --- | --- |
| `Enter` | 選択した worktree に cd |
| 文字入力 | branch 名・パスでファジー絞り込み（プレビューでは入力がハイライトされる） |
| `ctrl-f` | 入力中の文字列で **会話内容** を検索して一覧を絞り込み |
| `ctrl-d` | 選択した worktree を削除（確認プロンプトあり。dirty なら強制削除を再確認） |
| `ctrl-r` | 全件表示に戻す |
| `Esc` / `ctrl-c` | キャンセル |

プレビューには以下が表示される:

- branch / 最新コミット / dirty 状態
- **Claude への指示** — そのパスで Claude Code に送った直近のプロンプト（最大 8 件）
- **実行されたコマンド** — Claude が実行した直近の Bash コマンド（最大 8 件）

### サブコマンド

```sh
wt list [キーワード]         # worktree 一覧を TSV 出力 (キーワードで会話内容フィルタ)
wt preview <path> [キーワード] # 指定 worktree のプレビューを出力
wt rm <path>                 # 指定 worktree を削除
wt init zsh|bash             # cd 連携用シェル関数を出力
```

※ サブコマンド名 (`list` / `preview` / `rm` / `init`) と同名のキーワードでは検索できない。

## 開発・リリース（メンテナ向け）

要 Deno。

```sh
deno task run        # 開発実行 (または wt.sh を source)
deno task build      # 現在のアーキテクチャ向けに dist/wt をビルド
deno task build:all  # 配布用に3ターゲットをクロスコンパイル
```

`build:all` の成果物:

- `dist/wt-aarch64-apple-darwin` (Apple Silicon Mac)
- `dist/wt-x86_64-apple-darwin` (Intel Mac)
- `dist/wt-x86_64-unknown-linux-gnu` (Linux x64)

リリース手順:

```sh
deno task build:all
gh release create v0.1.0 dist/wt-* --title "v0.1.0" --generate-notes
```

## 仕組み

- worktree 一覧は `git worktree list --porcelain`（カレントリポジトリのみ対象）
- Claude Code 履歴は `~/.claude/projects/<パスの英数字以外を - に置換したスラッグ>/*.jsonl` を
  mtime の新しい順に読み、ユーザーメッセージと Bash tool_use を抽出
- fzf のプレビュー・キーバインドは自分自身（バイナリまたは `deno run`）を再帰呼び出しして実現
