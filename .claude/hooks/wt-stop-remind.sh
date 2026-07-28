#!/usr/bin/env bash
# wt-cli: Stop hook — セッション中に変更があるのに wt メタが未更新なら
# Claude に対して `wt set status` の実行を促すソフトリマインダを返す
set -u

input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)

[ -z "$session_id" ] && exit 0
[ -z "$cwd" ] && cwd="$PWD"

marker="/tmp/wt-session-${session_id}.json"
[ ! -f "$marker" ] && exit 0

started_at=$(jq -r '.startedAt // empty' "$marker" 2>/dev/null || true)
start_head=$(jq -r '.startHead // empty' "$marker" 2>/dev/null || true)
[ -z "$started_at" ] && exit 0

head_now=$(git -C "$cwd" rev-parse HEAD 2>/dev/null || true)
dirty=$(git -C "$cwd" status --porcelain 2>/dev/null || true)

# セッション開始以降、コミットも作業ツリー変更も無ければリマインダ不要
if [ "$head_now" = "$start_head" ] && [ -z "$dirty" ]; then
  exit 0
fi

# wt が使えない環境ではスキップ
if ! command -v wt >/dev/null 2>&1; then
  exit 0
fi

updated=$(wt info --json --path "$cwd" 2>/dev/null | jq -r '.updatedAt // empty' 2>/dev/null || true)

# 既にこのセッション中に更新されていれば再発火しない
if [ -n "$updated" ] && [ "$(printf '%s\n%s\n' "$started_at" "$updated" | sort | tail -n1)" = "$updated" ] && [ "$updated" != "$started_at" ]; then
  exit 0
fi

reason='このセッションで変更を加えましたが、wt メタが更新されていません。`wt set status "<現状の 1 行サマリ>"` を実行してから停止してください。必要なら `wt set task "..."` も併せて更新してください。'

jq -n --arg r "$reason" '{decision:"block", reason:$r}'
exit 0
