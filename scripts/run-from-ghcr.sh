#!/usr/bin/env bash
# 拉取并运行 GHCR 上的 cc-manage 镜像（不依赖本仓库源码）。
#
#   ./scripts/run-from-ghcr.sh              # 用默认 owner/版本
#   OWNER=someone VERSION=v1.0.0 ./scripts/run-from-ghcr.sh
#
# 需要宿主目录里已有 accounts.json（真实 CC key）与 keys.json（本地 key）。
set -euo pipefail

OWNER="${OWNER:-miku-hermes}"
VERSION="${VERSION:-latest}"
REGISTRY="${REGISTRY:-ghcr.io}"
DATA_DIR="${DATA_DIR:-$(pwd)/data}"

GATEWAY_IMAGE="$REGISTRY/$OWNER/cc-manage-gateway:$VERSION"
CORE_IMAGE="$REGISTRY/$OWNER/cc-manage-core:$VERSION"

GATEWAY_PORT="${GATEWAY_PORT:-3051}"

for f in accounts.json keys.json; do
  [ -f "$f" ] || { echo "缺少 $f（先从 .example 复制并填入真实值）" >&2; exit 1; }
done

mkdir -p "$DATA_DIR"

echo "==> 拉取镜像"
docker pull "$CORE_IMAGE"
docker pull "$GATEWAY_IMAGE"

# 两条命令都要能互相访问：自定义 bridge 网络
NET=cc-manage-net
docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

echo "==> 启动 core（不映射宿主端口）"
docker rm -f cc-manage-core >/dev/null 2>&1 || true
docker run -d --name cc-manage-core --restart unless-stopped \
  --network "$NET" \
  --memory 512m \
  -e PORT=3050 -e HOST=0.0.0.0 \
  -e CC_MAX_BODY_MB="${CC_MAX_BODY_MB:-20}" \
  -e CC_MAX_INFLIGHT="${CC_MAX_INFLIGHT:-8}" \
  -e NODE_OPTIONS=--max-old-space-size=384 \
  "$CORE_IMAGE" >/dev/null

echo "==> 启动 gateway（只绑宿主回环）"
docker rm -f cc-manage-gateway >/dev/null 2>&1 || true
docker run -d --name cc-manage-gateway --restart unless-stopped \
  --network "$NET" \
  --memory 256m \
  -p "127.0.0.1:${GATEWAY_PORT}:3051" \
  -e GATEWAY_HOST=0.0.0.0 -e GATEWAY_PORT=3051 \
  -e UPSTREAM_PROXY_URL=http://cc-manage-core:3050 \
  -e CC_API_BASE="${CC_API_BASE:-https://api.commandcode.ai}" \
  -e PROTECT_ADMIN_API="${PROTECT_ADMIN_API:-1}" \
  -e NODE_OPTIONS=--max-old-space-size=192 \
  -v "$(pwd)/accounts.json:/app/accounts.json:ro" \
  -v "$(pwd)/keys.json:/app/keys.json:ro" \
  -v "$DATA_DIR:/app/data" \
  "$GATEWAY_IMAGE" >/dev/null

echo "==> 等待就绪"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

curl -sS "http://127.0.0.1:${GATEWAY_PORT}/health"; echo
echo "面板: http://127.0.0.1:${GATEWAY_PORT}/  （PROTECT_ADMIN_API=1 时需在页面填入 keys.json 里的 key）"
