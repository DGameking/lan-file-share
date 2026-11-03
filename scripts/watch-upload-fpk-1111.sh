#!/usr/bin/env bash
# 后台看守：等待 CI 创建 v1.11.1 GitHub Release 后，上传 fpk 双包 + Windows 双包 + 合并 SHA256SUMS.txt
set -u
GH="/c/Program Files/GitHub CLI/gh.exe"
REPO="DGameking/lan-file-share"
TAG="v1.11.1"
DIR="/c/Users/mukui/lanfs-build"
MAX=40   # 最多等 40*30s = 20 分钟
n=0
echo "[watch] waiting for release $TAG ..."
while [ $n -lt $MAX ]; do
  if "$GH" release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "[watch] release found, uploading assets ..."
    "$GH" release upload "$TAG" \
      "$DIR/dist/LanFileShare-1.11.1-fnos-x86.fpk" \
      "$DIR/dist/LanFileShare-1.11.1-fnos-arm.fpk" \
      --repo "$REPO" 2>&1
    # Windows 双包（本机构建产物，存在才传）
    "$GH" release upload "$TAG" \
      "$DIR/dist/LanFileShare-Setup-1.11.1-x64.exe" \
      "$DIR/dist/LanFileShare-Portable-1.11.1-x64.zip" \
      --clobber --repo "$REPO" 2>&1 || true
    # 合并 SHA256SUMS：先取 CI 生成的（覆盖 CI 5 项资产），再合并本地产物哈希后回传
    (cd "$DIR/dist" && "$GH" release download "$TAG" --repo "$REPO" -p "SHA256SUMS.txt" --force 2>/dev/null || true)
    node "$DIR/scripts/gen-checksums.js" \
      "$DIR/dist/LanFileShare-1.11.1-fnos-x86.fpk" \
      "$DIR/dist/LanFileShare-1.11.1-fnos-arm.fpk" \
      "$DIR/dist/LanFileShare-Setup-1.11.1-x64.exe" \
      "$DIR/dist/LanFileShare-Portable-1.11.1-x64.zip"
    "$GH" release upload "$TAG" "$DIR/dist/SHA256SUMS.txt" --clobber --repo "$REPO" 2>&1
    echo "[watch] done."
    exit 0
  fi
  n=$((n+1))
  sleep 30
done
echo "[watch] timeout: release not found in 20min, please upload fpk manually."
exit 1
