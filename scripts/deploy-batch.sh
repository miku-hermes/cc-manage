#!/bin/bash
# cc-manage 网关批次部署：bash scripts/deploy-batch.sh <批次名，如 b28-ui>
#
# 流程：留回滚 tag → build → up -d → 双端点健康轮询（失败自动回滚）→ 冒烟 → 容器 md5 逐文件核对
#
# 用法注意：
#   * 必须用 terminal(background=true, notify=true) 跑 —— `docker compose up -d` 前台会被
#     「long-lived server」守卫拦。用 process_manage(action='wait') 收结果。
#   * 改了 panel/ 必须先 `bash scripts/panel-build.sh`（public/ 是 COPY 进镜像的，光改文件不生效）。
#   * 改动让「配置类型非法就拒绝启动」时，先读一遍生产 config.json 的键与类型再跑本脚本。
set -u
BATCH="${1:?用法: deploy-batch.sh <批次名，如 b28-ui>}"
cd /root/projects/cc-manage || exit 1
IMG=ghcr.io/miku-hermes/cc-manage-gateway
TAG="rollback-pre-${BATCH}"

echo "=== 1. 留回滚 tag ==="
docker tag "$IMG:latest" "$IMG:$TAG" || { echo "!! 打 tag 失败（线上没动）"; exit 1; }
echo "tagged $TAG"

echo "=== 2. build gateway ==="
docker compose build gateway || { echo "!! build 失败，放弃（未动线上）"; exit 1; }

echo "=== 3. up -d gateway ==="
docker compose up -d gateway || { echo "!! up 失败"; exit 1; }

echo "=== 4. 双端点健康轮询（60s；失败自动回滚）==="
ok=0
for i in $(seq 1 60); do
  h=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3051/health || echo 000)
  r=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3051/ready  || echo 000)
  if [ "$h" = "200" ] && [ "$r" = "200" ]; then echo "/health 200, /ready 200 @${i}"; ok=1; break; fi
  sleep 1
done
if [ "$ok" != "1" ]; then
  echo "!! 健康检查失败 → 回滚到 $TAG"
  docker logs --tail 40 cc-manage-gateway-1 2>&1 | tail -20
  docker tag "$IMG:$TAG" "$IMG:latest"
  docker compose up -d gateway
  echo "!! 已回滚，请检查"; exit 1
fi

echo "=== 5. 冒烟 ==="
for p in / /trend /admin /api/status /api/history /health /ready /favicon.ico; do
  printf '%-18s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3051$p")"
done
printf '%-18s -> %s\n' "admin无key(期望401)" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3051/api/admin/accounts)"
printf '%-18s -> %s\n' "公网" "$(curl -s -o /dev/null -w '%{http_code}' https://cc.mikus.ink/)"
printf '%-18s -> %s\n' "公网首页字节" "$(curl -s https://cc.mikus.ink/ | wc -c)"

echo "=== 6. 容器 health 状态（等 40s 让 healthcheck 跑一轮）==="
sleep 40
docker inspect cc-manage-gateway-1 --format '   gateway health = {{.State.Health.Status}}'
docker inspect cc-manage-core-1    --format '   core    health = {{.State.Health.Status}}'

echo "=== 7. md5 逐文件核对（本次是前端批次：index/trend/admin + js/* + assets/*.css 全比）==="
FILES="public/index.html public/trend.html public/admin.html"
for f in public/js/*.js; do FILES="$FILES $f"; done
for f in public/assets/*.css; do FILES="$FILES $f"; done
DIFF=0
for f in $FILES; do
  a=$(docker exec cc-manage-gateway-1 md5sum "/app/$f" 2>/dev/null | awk '{print $1}')
  b=$(md5sum "$f" 2>/dev/null | awk '{print $1}')
  if [ -n "$a" ] && [ "$a" = "$b" ]; then echo "OK   $f"; else echo "DIFF $f (容器=$a 仓库=$b)"; DIFF=$((DIFF+1)); fi
done
echo "md5 不一致文件数：$DIFF"

echo "=== 8. 完成 ==="
echo "接下来：核对远程 SHA == 本地 HEAD → 查 CI 逐 job 全绿（bash scripts/watch-ci.sh）"
