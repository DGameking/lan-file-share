#!/bin/bash
# 后台看守：等待 CI 创建 v1.9.9 GitHub Release 后，上传 fpk 双包
set -u
DIR="C:/Users/mukui/lanfs-build"
REPO="DGameking/lan-file-share"
TAG="v1.9.9"
GH="/c/Program Files/GitHub CLI/gh.exe"
X86="$DIR/dist/LanFileShare-1.9.9-fnos-x86.fpk"
ARM="$DIR/dist/LanFileShare-1.9.9-fnos-arm.fpk"

for i in $(seq 1 40); do
  if "$GH" release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "[watch] Release $TAG 已存在，开始上传 fpk"
    "$GH" release upload "$TAG" "$X86" "$ARM" --clobber --repo "$REPO" 2>&1 | tail -5
    echo "[watch] 上传完成"
    exit 0
  fi
  echo "[watch] 第 $i 次：Release 尚未就绪，30s 后重试…"
  sleep 30
done
echo "[watch] 超时：CI 未在 20 分钟内建好 Release，请手动上传 fpk"
exit 1
