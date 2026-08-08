#!/usr/bin/env bash
# Claude Code の更新後や bridge の変更後に, 統合が生きているかを確認する.
# 静的 (バイナリ内の文字列) / 単体 (回帰テスト) / 実走 (実 API) の 3 層で見る.
set -uo pipefail

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PORT="${BRIDGE_PORT:-8787}"
BIN="$(readlink -f "$(command -v claude)")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

ok()  { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mNG\033[0m   %s\n' "$1"; fail=1; }

echo "claude : $(claude --version 2>&1 | head -1)"
echo "binary : $BIN"
echo

echo "[1] 依存する内部拡張点がバイナリに残っているか"
grep -aq '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL' "$BIN" \
  && ok "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL が存在する" \
  || bad "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL が消えた (OAuth 維持で前段を挟めない)"
grep -aq 'ANTHROPIC_BASE_URL' "$BIN" \
  && ok "ANTHROPIC_BASE_URL が存在する" \
  || bad "ANTHROPIC_BASE_URL が消えた"

echo
echo "[2] SSE 変換の回帰テスト (モック上流・実 API 不使用)"
if out="$(timeout 300 python3 "$DIR/regress.py" 2>&1)"; then
  ok "回帰テスト全通過 ($(echo "$out" | grep -c '^  OK') 項目)"
else
  bad "回帰テストが失敗"
  echo "$out" | sed 's/^/       /'
fi

echo
echo "[3] bridge プロセス"
if wget -q -T 3 -O "$TMP/h" "http://127.0.0.1:${PORT}/__bridge/health" 2>/dev/null; then
  ok "health 応答あり"
  python3 -c "
import json
d=json.load(open('$TMP/h'))
for p in d['providers']:
    print(f\"       provider {p['name']:<10} match={p['match']:<20} key={'yes' if p['hasKey'] else 'NO'}\")"
else
  bad "health 応答なし (claude-ds --bridge-restart で起動する)"
fi

echo
echo "[4] 実走 (Anthropic 素通し / OAuth 維持)"
out="$(cd "$TMP" && timeout 180 claude-ds -p 'Reply with exactly: BRIDGE_OK' </dev/null 2>&1 | tr -d '\r')"
case "$out" in
  *BRIDGE_OK*) ok "Claude が OAuth のまま応答した" ;;
  *) bad "素通しに失敗: $(echo "$out" | tail -3 | tr '\n' ' ')" ;;
esac

# provider ごとの実走: "<表示名> <モデル名> <サブエージェント名>"
# ループ内で claude を起動するため, 一覧の読み取りは fd 3 に逃がす (stdin を食われる).
while read -r label model agent <&3; do
  [ -z "$label" ] && continue
  echo
  echo "[5:$label] 実走 (ルーティング)"
  out="$(cd "$TMP" && timeout 240 claude-ds --model "$model" -p "Reply with exactly: ${label}_OK" </dev/null 2>&1 | tr -d '\r')"
  case "$out" in
    *"${label}_OK"*) ok "$model が応答した" ;;
    *) bad "$model のルーティングに失敗: $(echo "$out" | tail -3 | tr '\n' ' ')" ;;
  esac

  echo "[6:$label] 実走 (サブエージェントがツールを使って完走するか)"
  printf 'MAGIC_%s\n' "$label" > "$TMP/probe_$label.txt"
  out="$(cd "$TMP" && timeout 420 claude-ds -p "Use the Agent tool with subagent_type '$agent' and run_in_background false to read probe_$label.txt in the cwd and report the token it contains. Then state that token." </dev/null 2>&1 | tr -d '\r')"
  case "$out" in
    *"MAGIC_$label"*) ok "$agent がツールを使って完走した" ;;
    *) bad "$agent のサブエージェントに失敗: $(echo "$out" | tail -3 | tr '\n' ' ')" ;;
  esac
done 3<<'PROVIDERS'
DEEPSEEK deepseek-v4-flash[1m] deepseek
KIMI kimi-k3[1m] kimi
PROVIDERS

echo
if [ "$fail" -eq 0 ]; then
  echo "すべて通過. bridge は機能している."
else
  echo "失敗あり. 復旧するなら次のどれか."
  echo "  - bridge を入れ直す : claude-ds --bridge-restart"
  echo "  - 直前の版へ戻す   : claude install <version>"
  echo "  - bridge を切る    : claude で起動する (claude-ds を使わない)"
fi
exit "$fail"
