#!/usr/bin/env bash
# 使い方: scripts/release.sh <version>
#   例: scripts/release.sh 0.3.1
# 事前チェック → tag 作成 → push を行い、release ワークフローを起動する。
set -euo pipefail

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "使い方: $0 <version>  (例: $0 0.3.1)" >&2
  exit 1
fi

# semver x.y.z (プレリリース対応: 0.3.1-rc.1 なども通す)
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "エラー: version は semver 形式で指定してください (例: 0.3.1)" >&2
  exit 1
fi

TAG="v$VERSION"

cd "$(git rev-parse --show-toplevel)"

# 現在ブランチが main か
BRANCH=$(git symbolic-ref --short HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "エラー: main ブランチで実行してください (現在: $BRANCH)" >&2
  exit 1
fi

# working tree が clean か
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "エラー: 未コミットの変更があります。commit または stash してください" >&2
  git status --short >&2
  exit 1
fi

# origin/main と同期しているか
git fetch origin main --quiet
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "エラー: main が origin/main と同期していません。pull / push してください" >&2
  echo "  local:  $LOCAL" >&2
  echo "  remote: $REMOTE" >&2
  exit 1
fi

# tag 重複チェック (ローカル + リモート両方)
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "エラー: tag $TAG は既にローカルに存在します" >&2
  exit 1
fi
if git ls-remote --tags origin "$TAG" | grep -q "$TAG"; then
  echo "エラー: tag $TAG は既に origin に存在します" >&2
  exit 1
fi

echo "→ tag $TAG を作成して push します"
echo "  最新コミット: $(git log -1 --oneline)"
read -r -p "続行しますか？ [y/N] " ans
case "$ans" in
  y|Y|yes) ;;
  *) echo "中断しました"; exit 1 ;;
esac

git tag "$TAG"
git push origin "$TAG"

echo ""
echo "=== tag push 完了 ==="
echo "release ワークフローが起動しました。進行状況:"
if command -v gh >/dev/null 2>&1; then
  echo "  gh run watch  (または https://github.com/$(git config --get remote.origin.url | sed -E 's|.*github\.com[:/]([^/]+/[^/]+)(\.git)?|\1|')/actions)"
else
  echo "  https://github.com/$(git config --get remote.origin.url | sed -E 's|.*github\.com[:/]([^/]+/[^/]+)(\.git)?|\1|')/actions"
fi
