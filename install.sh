#!/usr/bin/env bash
# bridge を ~/.claude/model-bridge へ配置し, claude-ds に PATH を通し, エージェント定義を置く.
# 既存ファイルは上書きする. 設定 (.env) と ログは残す.
set -euo pipefail

SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
DEST="${BRIDGE_HOME:-$HOME/.claude/model-bridge}"
BIN="${BRIDGE_BIN_DIR:-$HOME/.local/bin}"
AGENTS="$HOME/.claude/agents"

command -v node >/dev/null || { echo "install: node が要る" >&2; exit 1; }
command -v claude >/dev/null || { echo "install: claude が要る" >&2; exit 1; }

mkdir -p "$DEST" "$BIN" "$AGENTS"
install -m 0755 "$SRC/proxy.mjs" "$SRC/claude-ds" "$SRC/verify.sh" "$SRC/regress.py" "$DEST/"
install -m 0644 "$SRC/agents/deepseek.md" "$SRC/agents/kimi.md" "$AGENTS/"
ln -sf "$DEST/claude-ds" "$BIN/claude-ds"

if [ ! -f "$DEST/.env" ]; then
  cat > "$DEST/.env" <<'ENV'
# API キーをここに書く (少なくとも 1 つ). 環境変数が既にあればそちらが優先される.
# export DEEPSEEK_API_KEY=...
# export KIMI_API_KEY=...
ENV
  chmod 600 "$DEST/.env"
fi

echo "配置先   : $DEST"
echo "実行ファイル: $BIN/claude-ds"
echo "エージェント : $AGENTS/{deepseek,kimi}.md"
echo
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "注意: $BIN が PATH に無い. シェル設定に追加する." ;;
esac
echo "次: $DEST/.env に API キーを書き, claude-ds で起動する."
