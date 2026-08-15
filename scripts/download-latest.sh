#!/usr/bin/env bash
# 一键下载 DeepSeek Harness 桌面版最新安装包(自动匹配当前平台)
# 用法: bash scripts/download-latest.sh
set -euo pipefail
REPO="chenxinj08-lgtm/deepseek-harness-desktop"

case "$(uname -s)" in
  Darwin)
    ARCH=$(uname -m)
    if [ "$ARCH" = "arm64" ]; then FILE="DeepSeek-Harness-arm64.dmg"; else FILE="DeepSeek-Harness-x64.dmg"; fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    FILE="DeepSeek-Harness-Setup-x64.exe"
    ;;
  *)
    echo "暂不支持的系统: $(uname -s)"; exit 1
    ;;
esac

URL="https://github.com/$REPO/releases/latest/download/$FILE"
echo "==> 下载 $URL"
curl -fL --retry 3 -o "$FILE" "$URL"
echo "==> 完成: $FILE ($(du -h "$FILE" | cut -f1))"
