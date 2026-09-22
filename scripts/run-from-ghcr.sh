#!/usr/bin/env bash
# 拉取并运行 GHCR 上的 cc-manage 镜像（不依赖本仓库源码）。
#
#   ./scripts/run-from-ghcr.sh              # 用默认 owner/版本
#   OWNER=someone VERSION=v1.0.0 ./scripts/run-from-ghcr.sh
#
# 需要宿主目录里已有 accounts.json（真实 CC key）与 keys.json（本地 key）；
# config/ 与 data/ 目录会自动创建并 chown 给容器内的 uid 1000。
set -euo pipefail

OWNER="${OWNER:-miku-hermes}"
VERSION="${VERSION:-latest}"
REGISTRY="${REGISTRY:-ghcr.io}"
DATA_DIR="${DATA_DIR:-$(pwd)/data}"
# 后台管理员账号 / session 密钥都落在 config/，不挂的话容器重建即丢，
# 空目录会让匿名者直接 POST /api/auth/setup 抢占管理员。
CONFIG_DIR="${CONFIG_DIR:-$(pwd)/config}"

GATEWAY_IMAGE="$REGISTRY/$OWNER/cc-manage-gateway:$VERSION"
CORE_IMAGE="$REGISTRY/$OWNER/cc-manage-core:$VERSION"

GATEWAY_PORT="${GATEWAY_PORT:-3051}"

# 两条命令都要能互相访问：自定义 bridge 网络
NET=cc-manage-net

# ── docker run 参数（抽成数组，便于 test/batch3-ops.test.mjs 单测，无需真跑 docker）──
# 公共的权限/资源收紧项。core 用的 vendor 镜像没有 USER 指令，不显式指定就是 root。
fill_common_run_args() {
  COMMON_RUN_ARGS=(
    --user 1000:1000
    --cap-drop ALL
    --security-opt no-new-privileges:true
    --read-only
    --tmpfs /tmp                 # --read-only 下 node 仍需要一个可写 /tmp
    --log-opt max-size=10m
    --log-opt max-file=3
  )
}

# core 无状态、不映射端口、不挂任何宿主目录。
fill_core_run_args() {
  fill_common_run_args
  CORE_RUN_ARGS=(
    -d --name cc-manage-core --restart unless-stopped
    --network "$NET"
    --memory 512m
    -e PORT=3050 -e HOST=0.0.0.0
    -e CC_MAX_BODY_MB="${CC_MAX_BODY_MB:-20}"
    -e CC_MAX_INFLIGHT="${CC_MAX_INFLIGHT:-8}"
    -e NODE_OPTIONS=--max-old-space-size=384
    "${COMMON_RUN_ARGS[@]}"
    "$CORE_IMAGE"
  )
}

# gateway 的 mem_limit 384m 对应「192MB 堆 + 8MB×8 堆外 Buffer + 余量」，
# 与 docker-compose.yml / .env.example 里的算式保持一致，别单独调小。
fill_gateway_run_args() {
  fill_common_run_args
  GATEWAY_RUN_ARGS=(
    -d --name cc-manage-gateway --restart unless-stopped
    --network "$NET"
    --memory 384m
    -p "127.0.0.1:${GATEWAY_PORT}:3051"
    -e GATEWAY_HOST=0.0.0.0 -e GATEWAY_PORT=3051
    -e UPSTREAM_PROXY_URL=http://cc-manage-core:3050
    -e CC_API_BASE="${CC_API_BASE:-https://api.commandcode.ai}"
    -e PROTECT_ADMIN_API="${PROTECT_ADMIN_API:-1}"
    -e NODE_OPTIONS=--max-old-space-size=192
    -v "$(pwd)/accounts.json:/app/accounts.json:ro"
    -v "$(pwd)/keys.json:/app/keys.json:ro"
    -v "$CONFIG_DIR:/app/config"
    -v "$DATA_DIR:/app/data"
    "${COMMON_RUN_ARGS[@]}"
    "$GATEWAY_IMAGE"
  )
}

# 容器以 uid 1000 运行，宿主目录若是 root 建的，容器写不进去：
#   config/ 写不进去 → 后台账号无法落盘 / 空目录可被匿名 setup 抢占；
#   data/   写不进去 → store 静默降级为纯内存，重启丢 state。
# chown 失败（例如非 root 调用）只警告并继续，保留原有降级行为，但日志必须说清楚。
ensure_container_owner() {
  local dir="$1" why="$2"
  mkdir -p "$dir"
  if chown 1000:1000 "$dir" 2>/dev/null; then
    return 0
  fi
  echo "警告：chown 1000:1000 \"$dir\" 失败（$why）" >&2
  echo "      容器内以 uid 1000 运行，写不进去时会静默降级；修复：sudo chown -R 1000:1000 \"$dir\"" >&2
  return 0
}

# 被 source（而不是直接执行）时只加载上面的参数构造函数，不碰 docker 与宿主目录 ——
# test/batch3-ops.test.mjs 就是这么断言参数数组的。
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

for f in accounts.json keys.json; do
  [ -f "$f" ] || { echo "缺少 $f（先从 .example 复制并填入真实值）" >&2; exit 1; }
done

echo "==> 准备目录权限"
ensure_container_owner "$CONFIG_DIR" "config 目录必须可写，否则后台账号/session 无法落盘，空目录还会让匿名者抢注管理员"
ensure_container_owner "$DATA_DIR" "data 目录必须可写，否则 store 降级为纯内存、重启丢 state"

echo "==> 拉取镜像"
docker pull "$CORE_IMAGE"
docker pull "$GATEWAY_IMAGE"

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

echo "==> 启动 core（不映射宿主端口）"
docker rm -f cc-manage-core >/dev/null 2>&1 || true
fill_core_run_args
docker run "${CORE_RUN_ARGS[@]}" >/dev/null

echo "==> 启动 gateway（只绑宿主回环）"
docker rm -f cc-manage-gateway >/dev/null 2>&1 || true
fill_gateway_run_args
docker run "${GATEWAY_RUN_ARGS[@]}" >/dev/null

echo "==> 等待就绪"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

curl -sS "http://127.0.0.1:${GATEWAY_PORT}/health"; echo
echo "面板: http://127.0.0.1:${GATEWAY_PORT}/  （PROTECT_ADMIN_API=1 时需在页面填入 keys.json 里的 key）"
