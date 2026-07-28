# wt

git worktree を fzf で一覧・切り替え・削除できる CLI。
各 worktree について、そこで行われた **Claude Code への直近の指示・実行コマンド** をプレビュー表示する。

deno compile による単一バイナリで配布するため、利用者に Deno は不要。
実行時に必要なのは **fzf と git だけ**（`brew install fzf`）。

## インストール（利用者向け）

### Homebrew (macOS / Linux)

```sh
brew install todokr/tap/wt
```

### install.sh

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

- branch / 最新コミット
- **worktree メタ情報** — `wt set` で登録した任意の key/value（`task` / `status` など）
- dirty 状態
- **Claude への指示** — そのパスで Claude Code に送った直近のプロンプト（最大 8 件）
- **実行されたコマンド** — Claude が実行した直近の Bash コマンド（最大 8 件）

### worktree メタ情報

各 worktree に任意の key/value を登録できる。fzf の一覧・プレビューに表示され、LLM (Claude Code など)
から `wt info --json` で機械的に読める。保存先は `~/.wt/meta.json`。

```sh
wt set <key> <value...>   # 任意のキーに値をセット (例: wt set task "…" / wt set status "…")
wt unset <key>            # 指定キーを削除
wt get <key>              # 単一 key の値を stdout に出力 (存在しなければ exit 1)
wt clear                  # 現在の worktree のメタ全体を削除
wt info                   # 現在の worktree の情報を表示
wt info --json            # 同上を JSON で
wt info <path>            # 指定パスの情報
wt info --all --json      # 全 worktree 分をまとめて JSON 出力
```

書き込み系は cwd を自動判定する。別の worktree を対象にしたい場合は `--path <p>` を付ける。

**慣習キー** — 以下は `wt` 自身が fzf 一覧の要約列 / preview の上部で参照する:

- `task` — その worktree で行っている作業の 1 行サマリ
- `status` — 現在の進捗ステータス

それ以外 (`pr` / `ticket` / `notes` など) も自由に登録でき、`wt info` で全部表示される。

### worktree の新規作成

```sh
wt new <branch> [<base>] [-m "task メッセージ"] [--dir <slug>]
```

- ブランチ `<branch>` と worktree を新規作成し、その worktree に自動で cd する
- `<branch>` が既存の場合はそれを流用（`-b` を付けない。この場合 `<base>` は指定不可）
- 分岐元 `<base>` を省略すると `main` (無ければ `master` / `origin/HEAD`) から分岐
- `-m` (または `--message`) で作成と同時に `task` メタを登録
- `--dir <slug>` でディレクトリ basename をブランチ名と別に指定可（`feature/foo` を `feature-foo` にする等）
- 配置先はデフォルトで `<メイン worktree>/.worktree/<slug または branch>`
- 環境変数 `WT_BASE_DIR` を設定すると、代わりに `${WT_BASE_DIR}/<slug または branch>` に作成される

### サブコマンド

```sh
wt list [キーワード]           # worktree 一覧を TSV 出力 (キーワードで会話内容フィルタ)
wt preview <path> [キーワード] # 指定 worktree のプレビューを出力
wt rm <path>                   # 指定 worktree を削除 (~/.wt/meta.json の該当エントリも削除)
wt new <name> [<base>] [-m "..."] # ブランチ + worktree を新規作成して cd
wt init zsh|bash               # cd 連携用シェル関数を出力
```

※ サブコマンド名 (`list` / `preview` / `rm` / `new` / `init` / `set` / `unset` / `get` / `clear` / `info`)
と同名のキーワードでは検索できない。

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

タグを push するだけで、`.github/workflows/release.yml` が以下を自動実行する:

1. `deno task build:all` で 3 ターゲットビルド
2. GitHub Release を作成しバイナリを添付
3. `scripts/gen-homebrew-formula.sh` で Formula を生成し `todokr/homebrew-tap` に push

```sh
scripts/release.sh 0.3.1
```

`scripts/release.sh` は事前チェック (main / clean tree / origin 同期 / tag 未使用) と
確認プロンプトを経てから tag 作成 + push を行う。手動で行う場合は
`git tag v0.3.1 && git push origin v0.3.1` でも同じ。

初回セットアップ（一度だけ）:

- 別リポ `todokr/homebrew-tap` を作成（空でよい。CI が `Formula/` を作る）
- `repo` スコープの PAT を発行し、この repo の Actions secret `HOMEBREW_TAP_TOKEN` に登録

手動でリリースする場合:

```sh
deno task build:all
gh release create v0.3.0 dist/wt-* --title "v0.3.0" --generate-notes
./scripts/gen-homebrew-formula.sh 0.3.0 dist > /path/to/tap/Formula/wt.rb
# → tap リポで commit + push
```

## 仕組み

- worktree 一覧は `git worktree list --porcelain`（カレントリポジトリのみ対象）
- Claude Code 履歴は `~/.claude/projects/<パスの英数字以外を - に置換したスラッグ>/*.jsonl` を
  mtime の新しい順に読み、ユーザーメッセージと Bash tool_use を抽出
- fzf のプレビュー・キーバインドは自分自身（バイナリまたは `deno run`）を再帰呼び出しして実現
