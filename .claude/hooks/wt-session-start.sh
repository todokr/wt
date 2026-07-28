#!/usr/bin/env bash
# wt-cli: SessionStart hook — このセッションの起点 (HEAD sha / 開始時刻) をマーカーに記録
# Stop hook 側でセッション開始以降に変更があったかどうかを判定するのに使う
set -u

input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)

[ -z "$session_id" ] && exit 0
[ -z "$cwd" ] && cwd="$PWD"

start_head=$(git -C "$cwd" rev-parse HEAD 2>/dev/null || true)
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

marker="/tmp/wt-session-${session_id}.json"
printf '{"startedAt":"%s","startHead":"%s","cwd":"%s"}\n' \
  "$started_at" "$start_head" "$cwd" > "$marker"

exit 0
