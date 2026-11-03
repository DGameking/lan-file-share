#!/usr/bin/env bash
# 后台看守：等待 CI 创建 v1.10.0 GitHub Release 后，上传 fpk 双包
set -u
GH="/c/Program Files/GitHub CLI/gh.exe"
REPO="DGameking/lan-file-share"
TAG="v1.10.0"
DIR="/c/Users/mukui/lanfs-build"
MAX=40   # 最多等 40*30s = 20 分钟
n=0
echo "[watch] waiting for release $TAG ..."
while [ $n -lt $MAX ]; do
  if "$GH" release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "[watch] release found, uploading fpk ..."
    "$GH" release upload "$TAG" \
      "$DIR/dist/LanFileShare-1.10.0-fnos-x86.fpk" \
      "$DIR/dist/LanFileShare-1.10.0-fnos-arm.fpk" \
      --repo "$REPO" 2>&1
    echo "[watch] done."
    exit 0
  fi
  n=$((n+1))
  sleep 30
done
echo "[watch] timeout: release not found in 20min, please upload fpk manually."
exit 1
