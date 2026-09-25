#!/usr/bin/env bash
# B22：构建 Astro 面板并把产物同步到仓库根 public/（本地与 CI 共用）。
#
# 为什么需要它：仓库根的 public/ 现在是**构建产物**（由 panel/dist 同步而来），不进 git
# （见 .gitignore 的 /public/）。干净 checkout 下没有它，gateway 的 GET / 会回 503
# 「面板未构建」——所以构建是跑测试 / 跑网关的前置步骤。
#
# 行为：panel/ 下没 node_modules 就先 npm ci → npm run build → 清空并重建根 public/。
# 幂等、可重复执行；任何一步失败即以非 0 退出（set -e）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT/panel"

if [ ! -d node_modules ]; then
  echo "==> panel/node_modules 不存在，先执行 npm ci"
  npm ci --no-audit --no-fund
else
  echo "==> panel/node_modules 已存在，跳过 npm ci"
fi

echo "==> npm run build（Astro 构建产物 → panel/dist）"
npm run build

# 先清空再拷：删掉上一轮构建残留的文件，保证 public/ 与 panel/dist 逐字一致。
# 只动仓库根的 public/，不碰 panel/ 自身。
echo "==> 同步 panel/dist/ → $ROOT/public/"
cd "$ROOT"
rm -rf public
cp -r panel/dist public

echo "==> 面板就绪：$(find public -type f | wc -l) 个文件已落到 public/"
