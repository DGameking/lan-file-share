#!/usr/bin/env bash
# 看守：等待 v1.9.12 Release 就绪后自动上传 fpk 双包
GH="/c/Program Files/GitHub CLI/gh.exe"
REPO="--repo DGameking/lan-file-share"
cd "$(dirname "$0")/.."

for i in $(seq 1 40); do
  if "$GH" release view v1.9.12 $REPO >/dev/null 2>&1; then
    echo "[watch] Release v1.9.12 已存在，开始上传 fpk"
    "$GH" release upload v1.9.12 \
      "dist/LanFileShare-1.9.12-fnos-x86.fpk" \
      "dist/LanFileShare-1.9.12-fnos-arm.fpk" $REPO --clobber && echo "[watch] 上传完成"
    exit 0
  fi
  echo "[watch] 第 $i 次：Release 尚未就绪，30s 后重试…"
  sleep 30
done
echo "[watch] 超时（20 分钟）未等到 Release"
exit 1
