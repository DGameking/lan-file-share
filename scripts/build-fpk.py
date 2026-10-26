#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
飞牛 fnOS fpk 打包器（复刻实测可安装包的格式）

为什么不用官方 fnpack.exe：Windows 版 fnpack 在 NTFS 上打包，
所有文件权限位为 666/777（无可执行位），fnOS 安装端校验不通过
（报「应用包不符合系统要求」）。已验证的 Linux CI 打包样本
（good.fpk）格式为：目录 755 / 文件 644 / 脚本 755、GNU tar、
gzip(mtime=0)、manifest 末尾带 app.tgz 的 md5 checksum。

用法：
  python scripts/build-fpk.py --platform x86 --version 1.9.3
  python scripts/build-fpk.py --platform arm --version 1.9.3
"""
import argparse
import gzip
import hashlib
import io
import os
import re
import shutil
import sys
import tarfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FNOS = os.path.join(ROOT, 'fnos-app')
APP_DIR = os.path.join(FNOS, 'app')
RUNTIME_NODE = os.path.join(FNOS, 'runtime', 'node', 'bin', 'node')


def mode_for(path_rel, is_dir):
    if is_dir:
        return 0o755
    # bin/ 下可执行、shell 脚本 → 755
    if '/bin/' in '/' + path_rel.replace('\\', '/') or path_rel.endswith('.sh'):
        return 0o755
    return 0o644


def add_tar_entry(tf, name, path=None, data=None, is_dir=False, mtime=None):
    mtime = mtime or int(time.time())
    info = tarfile.TarInfo(name)
    info.mode = mode_for(name, is_dir)
    info.uid, info.gid = 0, 0
    info.uname, info.gname = 'root', 'root'
    info.mtime = mtime
    if is_dir:
        info.type = tarfile.DIRTYPE
        info.size = 0
        tf.addfile(info)
    else:
        if data is None:
            with open(path, 'rb') as f:
                data = f.read()
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))


def build_app_tgz(mtime):
    """内层 app.tgz：fnos-app/app/ 目录内容（target/... ui/...）"""
    buf = io.BytesIO()
    gz = gzip.GzipFile(fileobj=buf, mode='wb', mtime=0)
    tf = tarfile.open(fileobj=gz, mode='w', format=tarfile.GNU_FORMAT)
    base = APP_DIR
    entries = sorted(os.listdir(base))
    for entry in entries:
        full = os.path.join(base, entry)
        if os.path.isdir(full):
            for dirpath, dirnames, filenames in os.walk(full):
                dirnames.sort()
                rel = os.path.relpath(dirpath, base).replace('\\', '/')
                add_tar_entry(tf, rel, is_dir=True, mtime=mtime)
                for fn in sorted(filenames):
                    add_tar_entry(tf, f'{rel}/{fn}', path=os.path.join(dirpath, fn), mtime=mtime)
        else:
            add_tar_entry(tf, entry, path=full, mtime=mtime)
    tf.close()
    gz.close()
    return buf.getvalue()


def read_manifest(platform, version):
    text = open(os.path.join(FNOS, 'manifest'), encoding='utf-8').read()
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith('#'):
            lines.append(line)
            continue
        m = re.match(r'^([A-Za-z_]+)\s*=\s*(.*)$', s)
        if not m:
            lines.append(line)
            continue
        key, val = m.group(1), m.group(2).strip()
        if key == 'platform':
            val = platform
        elif key == 'version':
            val = version
        elif key == 'install_dep_apps':
            continue  # x86 包内置 runtime / arm 包走 cmd 兜底，不赌应用中心依赖
        lines.append(f'{key:<21} = {val}')
    # 去重：同一 key 保留最后一次
    seen = {}
    for i, line in enumerate(lines):
        m = re.match(r'^([A-Za-z_]+)\s*=', line)
        if m:
            seen[m.group(1)] = i
    out = []
    for i, line in enumerate(lines):
        m = re.match(r'^([A-Za-z_]+)\s*=', line)
        if m and seen[m.group(1)] != i:
            continue
        out.append(line)
    return '\n'.join(out) + '\n'


def build_fpk(platform, version, out_path):
    mtime = int(time.time())

    # x86：注入内置 Linux Node runtime（自包含，不依赖应用中心）；arm：移除 x64 runtime
    runtime_dst = os.path.join(APP_DIR, 'target', 'runtime', 'node')
    injected = False
    if platform == 'x86' and os.path.exists(RUNTIME_NODE):
        os.makedirs(os.path.join(runtime_dst, 'bin'), exist_ok=True)
        shutil.copy2(RUNTIME_NODE, os.path.join(runtime_dst, 'bin', 'node'))
        injected = True
    elif platform == 'arm':
        shutil.rmtree(os.path.join(APP_DIR, 'target', 'runtime'), ignore_errors=True)

    app_tgz = build_app_tgz(mtime)

    # checksum = app.tgz 的 md5（官方格式要求）
    manifest_text = read_manifest(platform, version)
    md5 = hashlib.md5(app_tgz).hexdigest()
    if 'checksum' in manifest_text:
        manifest_text = re.sub(r'checksum\s*=.*', f'checksum{" " * 15}= {md5}', manifest_text)
    else:
        manifest_text += f'checksum{" " * 15}= {md5}\n'

    buf = io.BytesIO()
    gz = gzip.GzipFile(fileobj=buf, mode='wb', mtime=0)
    tf = tarfile.open(fileobj=gz, mode='w', format=tarfile.GNU_FORMAT)

    def add_file(name, data, mode=0o644):
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mode = mode
        info.uid, info.gid = 0, 0
        info.uname, info.gname = 'root', 'root'
        info.mtime = mtime
        tf.addfile(info, io.BytesIO(data))

    # 顶层条目顺序与权限对齐实测可装包：cmd/* 一律 755
    add_file('app.tgz', app_tgz)
    cmd_dir = os.path.join(FNOS, 'cmd')
    add_tar_entry(tf, 'cmd', is_dir=True, mtime=mtime)
    for fn in sorted(os.listdir(cmd_dir)):
        add_file(f'cmd/{fn}', open(os.path.join(cmd_dir, fn), 'rb').read(), mode=0o755)
    add_tar_entry(tf, 'config', is_dir=True, mtime=mtime)
    for fn in ('privilege', 'resource'):
        add_file(f'config/{fn}', open(os.path.join(FNOS, 'config', fn), 'rb').read())
    add_file('ICON.PNG', open(os.path.join(FNOS, 'ICON.PNG'), 'rb').read())
    add_file('ICON_256.PNG', open(os.path.join(FNOS, 'ICON_256.PNG'), 'rb').read())
    add_file('manifest', manifest_text.encode('utf-8'))
    add_tar_entry(tf, 'wizard', is_dir=True, mtime=mtime)
    add_file('wizard/install', open(os.path.join(FNOS, 'wizard', 'install'), 'rb').read())

    tf.close()
    gz.close()

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'wb') as f:
        f.write(buf.getvalue())
    size_mb = len(buf.getvalue()) / 1048576
    print(f'[fpk] {out_path} ({size_mb:.1f} MB) platform={platform} version={version} runtime={"内置" if injected else "无"}')
    print(f'[fpk] app.tgz md5 = {md5}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--platform', choices=['x86', 'arm'], default='x86')
    ap.add_argument('--version', required=True)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    out = args.out or os.path.join(ROOT, 'dist', f'LanFileShare-{args.version}-fnos-{args.platform}.fpk')
    build_fpk(args.platform, args.version, out)


if __name__ == '__main__':
    main()
