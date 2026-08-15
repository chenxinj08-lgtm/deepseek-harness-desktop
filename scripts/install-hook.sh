#!/usr/bin/env bash
# 安装 pre-push 隐私扫描钩子(第一道防护)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/hooks/pre-push"
DST="$ROOT/.git/hooks/pre-push"
if [ ! -d "$ROOT/.git" ]; then echo "不是 git 仓库: $ROOT"; exit 1; fi
cp "$SRC" "$DST"
chmod +x "$DST"
echo "已安装 pre-push 钩子 → $DST"
echo "验证: node $ROOT/scripts/privacy-scan.mjs"
