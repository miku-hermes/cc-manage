#!/usr/bin/env bash
# 容器级冒烟：**真构建镜像 + 真起容器 + 真跑一条 /v1 往返**。
#
# 为什么需要它：CI 的 build job 只 build 不 run —— CMD / EXPOSE / HEALTHCHECK / entrypoint /
# 运行时是否缺文件，构建绿灯一概覆盖不到（构建成功 ≠ 容器能起）。
# 这条脚本覆盖：容器能起来并能通过自己的 healthcheck（/ready）、/health 与 /ready 的口径、
# 面板骨架能渲染、以及「mock CC → 真 vendor 内核 → 网关」的一条非流式往返。
#
# 用法： bash scripts/smoke.sh            （需要本机有 docker，会构建两个镜像）
#        SMOKE_SKIP_BUILD=1 bash scripts/smoke.sh   （复用已有镜像）
# 失败时自动转储三个容器的日志，便于排查。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NET=cc-manage-smoke
MOCK_NAME=cc-manage-smoke-mock
CORE_NAME=cc-manage-smoke-core
GATEWAY_NAME=cc-manage-smoke-gateway
GATEWAY_IMAGE="${SMOKE_GATEWAY_IMAGE:-cc-manage-gateway:smoke}"
CORE_IMAGE="${SMOKE_CORE_IMAGE:-cc-manage-core:smoke}"
MOCK_IMAGE="${SMOKE_MOCK_IMAGE:-node:22-alpine}"
MOCK_PORT=3099
LOCAL_KEY=sk-cg-smoketest0001
ACCOUNT_KEY=user_test_alpha

WORK="$(mktemp -d)"
CONTAINERS=("$GATEWAY_NAME" "$CORE_NAME" "$MOCK_NAME")

cleanup() {
  for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}

dump_logs() {
  echo "!! 冒烟失败，转储容器状态与日志" >&2
  for c in "${CONTAINERS[@]}"; do
    echo "--- docker inspect ${c} ---" >&2
    docker inspect --format '{{.Name}} running={{.State.Running}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}(无 healthcheck){{end}}' "$c" >&2 2>&1 || true
  done
  for c in "${CONTAINERS[@]}"; do
    echo "--- docker logs --tail 100 ${c} ---" >&2
    docker logs --tail 100 "$c" >&2 2>&1 || true
  done
}

on_exit() {
  status=$?
  # 注意：`[ ... ] && dump_logs` 在 set -e 下会在判断为假时直接中断 trap，cleanup 就不跑了。
  if [ "$status" -ne 0 ]; then dump_logs; fi
  cleanup
  return "$status"
}
trap on_exit EXIT

fail() { echo "错误：$*" >&2; exit 1; }

# ── 0：compose 有效配置（base + override 合并）────────────────────────────
if docker compose version >/dev/null 2>&1; then
  echo "==> docker compose config -q（docker-compose.yml + docker-compose.override.yml）"
  docker compose -f docker-compose.yml -f docker-compose.override.yml config -q \
    || fail "compose 配置校验失败（base + override 合并后不合法）"
else
  echo "==> 跳过 compose 校验（本机没有 docker compose）"
fi

# ── 1：本地构建（不 push）───────────────────────────────────────────────
if [ "${SMOKE_SKIP_BUILD:-0}" = "1" ]; then
  echo "==> 跳过构建（SMOKE_SKIP_BUILD=1）"
  docker image inspect "$GATEWAY_IMAGE" >/dev/null || fail "镜像不存在：$GATEWAY_IMAGE"
  docker image inspect "$CORE_IMAGE" >/dev/null || fail "镜像不存在：$CORE_IMAGE"
else
  echo "==> 构建 core 镜像（真内核：$CORE_IMAGE）"
  docker build -q -t "$CORE_IMAGE" ./vendor/commandcode-proxy >/dev/null
  echo "==> 构建 gateway 镜像（$GATEWAY_IMAGE）"
  docker build -q -t "$GATEWAY_IMAGE" . >/dev/null
fi

# ── 1.5：镜像元数据（CMD / EXPOSE / HEALTHCHECK 光看构建绿灯是看不到的）──────
echo "==> 校验镜像元数据"
img_field() { docker image inspect --format "$2" "$1" 2>/dev/null || echo missing; }

gw_hc="$(img_field "$GATEWAY_IMAGE" '{{json .Config.Healthcheck.Test}}')"
[ "$gw_hc" != "null" ] || fail "gateway 镜像没有 HEALTHCHECK 指令（Dockerfile 的 HEALTHCHECK 没生效）"
case "$gw_hc" in *3051/health*) : ;; *) fail "gateway 镜像的 HEALTHCHECK 应探 /health（镜像默认 liveness），实际：$gw_hc" ;; esac

core_hc="$(img_field "$CORE_IMAGE" '{{json .Config.Healthcheck.Test}}')"
[ "$core_hc" != "null" ] || fail "core 镜像没有 HEALTHCHECK 指令"
case "$core_hc" in *3050/health*) : ;; *) fail "core 镜像的 HEALTHCHECK 应探 /health（vendor 内核只有这个路由），实际：$core_hc" ;; esac

gw_expose="$(img_field "$GATEWAY_IMAGE" '{{json .Config.ExposedPorts}}')"
case "$gw_expose" in *3051*) : ;; *) fail "gateway 镜像缺 EXPOSE 3051，实际：$gw_expose" ;; esac
gw_cmd="$(img_field "$GATEWAY_IMAGE" '{{json .Config.Cmd}}')"
case "$gw_cmd" in *gateway.mjs*) : ;; *) fail "gateway 镜像的 CMD 应启动 gateway.mjs，实际：$gw_cmd" ;; esac
core_cmd="$(img_field "$CORE_IMAGE" '{{json .Config.Cmd}}')"
case "$core_cmd" in *proxy.mjs*) : ;; *) fail "core 镜像的 CMD 应启动 proxy.mjs，实际：$core_cmd" ;; esac

# ── 2：假凭据 + 网络 ────────────────────────────────────────────────────
mkdir -p "$WORK/config" "$WORK/data"
cat > "$WORK/config/accounts.json" <<JSON
{"accounts":[{"name":"冒烟账号","key":"${ACCOUNT_KEY}","enabled":true}]}
JSON
cat > "$WORK/config/keys.json" <<JSON
{"keys":[{"name":"冒烟客户端","key":"${LOCAL_KEY}"}]}
JSON
# 容器内是 uid 1000（镜像 USER node），宿主目录必须让它可写；
# 不 chown（CI runner 非 root，chown 会失败），改成对所有人可读写。
chmod -R a+rwX "$WORK"

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

# ── 3：起 mock CC 上游 ─────────────────────────────────────────────────
echo "==> 启动 mock CC 上游"
docker run -d --name "$MOCK_NAME" --network "$NET" \
  -e "MOCK_PORT=${MOCK_PORT}" -e MOCK_HOST=0.0.0.0 \
  -v "$ROOT/mocks:/mocks:ro" \
  "$MOCK_IMAGE" node /mocks/mock-cc-upstream.mjs >/dev/null

# ── 4：起 core（真 vendor 内核）─────────────────────────────────────────
echo "==> 启动 core（真内核，不映射宿主端口）"
docker run -d --name "$CORE_NAME" --network "$NET" \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true \
  --read-only --tmpfs /tmp --memory 512m \
  --health-cmd "wget -q --spider http://127.0.0.1:3050/health || exit 1" \
  --health-interval 5s --health-timeout 3s --health-start-period 5s --health-retries 12 \
  -e PORT=3050 -e HOST=0.0.0.0 \
  -e CC_MAX_BODY_MB=20 -e CC_MAX_INFLIGHT=8 -e NODE_OPTIONS=--max-old-space-size=384 \
  -e "CC_API_BASE=http://${MOCK_NAME}:${MOCK_PORT}" \
  -e CC_USE_PROVIDER_MODELS=false \
  "$CORE_IMAGE" >/dev/null

# ── 5：起 gateway（只绑宿主回环，随机宿主端口避免撞车）──────────────────
echo "==> 启动 gateway"
if [ -n "${SMOKE_GATEWAY_PORT:-}" ]; then
  PORT_ARG="127.0.0.1:${SMOKE_GATEWAY_PORT}:3051"
else
  PORT_ARG="127.0.0.1::3051"
fi
docker run -d --name "$GATEWAY_NAME" --network "$NET" \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true \
  --read-only --tmpfs /tmp --memory 384m \
  -p "$PORT_ARG" \
  --health-cmd "wget -q --spider http://127.0.0.1:3051/ready || exit 1" \
  --health-interval 5s --health-timeout 5s --health-start-period 10s --health-retries 12 \
  -e GATEWAY_HOST=0.0.0.0 -e GATEWAY_PORT=3051 \
  -e "UPSTREAM_PROXY_URL=http://${CORE_NAME}:3050" \
  -e "CC_API_BASE=http://${MOCK_NAME}:${MOCK_PORT}" \
  -e PUBLIC_DASHBOARD=1 -e LOG_LEVEL=info -e NODE_OPTIONS=--max-old-space-size=192 \
  -v "$WORK/config:/app/config" -v "$WORK/data:/app/data" \
  "$GATEWAY_IMAGE" >/dev/null

# 用 sed 取第一行而不是 `head -1`：docker port 会同时打印 IPv4/IPv6 两行，
# head 提前关闭管道会让 docker 收到 SIGPIPE，在 set -o pipefail 下整个脚本以 141 退出。
BASE="http://127.0.0.1:$(docker port "$GATEWAY_NAME" 3051/tcp | sed -n '1s/.*://p')"
echo "    网关地址：$BASE"

# ── 6：等容器自己的 healthcheck 变 healthy（CMD/EXPOSE/HEALTHCHECK 的真实性检查）──
echo "==> 等待容器 healthy"
wait_healthy() {
  local name="$1" tries="${2:-24}"
  for _ in $(seq 1 "$tries"); do
    local st
    st="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo missing)"
    if [ "$st" = "healthy" ]; then return 0; fi
    if [ "$st" = "missing" ]; then fail "容器 $name 不存在（起不来的典型症状）"; fi
    if [ "$st" = "none" ]; then fail "容器 $name 没有 healthcheck（Dockerfile/compose 的 HEALTHCHECK 没生效）"; fi
    sleep 2
  done
  fail "容器 $name 在超时内没有变成 healthy"
}
wait_healthy "$CORE_NAME"
wait_healthy "$GATEWAY_NAME"

# ── 7：HTTP 断言 ───────────────────────────────────────────────────────
# B24f：响应体一律写进**本次检查自己的**文件，不再共用 $WORK/body。
#
# 旧写法 http_code 把 body 写进共享的 $WORK/body，于是出现「这一检查刚取到 /js/state.js、
# 下一检查却去读同一个文件里的首页 HTML」这种自伤 —— 失败与镜像无关，纯属读错文件。
# 根治办法不是补一行，而是让共享变量不存在：要读谁的 body，就必须自己先 fetch_into 一次。
http_code() { curl -sS -o "$1" -w '%{http_code}' --max-time 20 "${@:2}" || echo 000; }

# fetch_into <file> <url...>：把响应体写进指定文件并回显 HTTP 状态码（内部调 http_code）。
fetch_into() { http_code "$1" "${@:2}"; }

# body_info <file>：fail 信息里的「路径 / 字节数 / 开头片段」。
# 目的：下次再读错文件时，报错里直接能看到「这个文件是 state.js 不是 HTML」，
# 不会又被误判成「镜像里没有静态资源」。
body_info() {
  local file="$1" bytes
  bytes="$(wc -c < "$file" 2>/dev/null | tr -d '[:space:]' || true)"
  printf '%s（%s 字节，开头：%s）' "$file" "${bytes:-取不到}" "$(head -c 120 "$file" 2>/dev/null | tr '\n' ' ')"
}

# assert_html <file> <what>：先确认手里这份文件**看起来是 HTML**，再往下 grep 提取。
# 读错文件（比如拿到 /js/state.js 的文本）时必须直说「期望 HTML」，而不是含糊地报
# 「首页没有外链 /assets/*.css」——那会把「脚本读错文件」误导成「镜像缺资源」。
assert_html() {
  local file="$1" what="$2"
  if ! grep -Eq '<!doctype|<html|<link' "$file" 2>/dev/null; then
    fail "$what：期望 HTML，实际拿到 $(body_info "$file")"
  fi
}

assert_json() {
  local file="$1" what="$2"
  if command -v node >/dev/null 2>&1; then
    # 走 stdin 而不是 argv：`node -e` 的 argv 偏移容易写错，而且这里要保证
    # 非 JSON 时是**明确失败**（不是静默通过）。
    if ! node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{JSON.parse(s)}catch(e){console.error("不是合法 JSON: "+e.message+" | 原文: "+s.slice(0,200));process.exit(1)}})' < "$file"; then
      fail "$what 的响应体不是合法 JSON（$(body_info "$file")）"
    fi
  else
    case "$(head -c 1 "$file")" in
      '{'|'[') : ;;
      *) fail "$what 的响应体看起来不是 JSON（$(body_info "$file")）" ;;
    esac
  fi
}

echo "==> GET /health（liveness）"
code="$(fetch_into "$WORK/health.body" "$BASE/health")"
[ "$code" = "200" ] || fail "/health 期望 200，实际 $code（body: $(body_info "$WORK/health.body")）"
assert_json "$WORK/health.body" "/health"
grep -q '"ok":true' "$WORK/health.body" || fail "/health 响应体缺少 ok:true（$(body_info "$WORK/health.body")）"

echo "==> GET /ready（readiness：真探 core）"
code="$(fetch_into "$WORK/ready.body" "$BASE/ready")"
[ "$code" = "200" ] || fail "/ready 期望 200（上游可达），实际 $code（body: $(body_info "$WORK/ready.body")）"
assert_json "$WORK/ready.body" "/ready"
grep -q '"upstream":"up"' "$WORK/ready.body" || fail "/ready 响应体缺少 upstream:up（$(body_info "$WORK/ready.body")）"

echo "==> GET /（面板骨架）"
code="$(fetch_into "$WORK/index.body" "$BASE/")"
[ "$code" = "200" ] || fail "面板 / 期望 200，实际 $code（body: $(body_info "$WORK/index.body")）"
for marker in 'cc-manage' 'id="health"' '<script src="js/utils.js">'; do
  grep -q "$marker" "$WORK/index.body" || fail "面板 HTML 缺少骨架标记：$marker（说明静态资源没进镜像 / CMD 不对；$(body_info "$WORK/index.body")）"
done

echo "==> GET /js/state.js 与首页外链 /assets/*.css（静态资源真的在镜像里）"
code="$(fetch_into "$WORK/state.body" "$BASE/js/state.js")"
[ "$code" = "200" ] || fail "/js/state.js 期望 200，实际 $code（public/ 没进镜像？body: $(body_info "$WORK/state.body")）"
# B24d：样式从内联改成独立可缓存文件；CSS 路径从**真正的首页 HTML** 里取。
# B24f：这里**再取一次** $BASE/ 写进本检查自己的文件（$WORK/home-css.body），
# 而不是复用上一个检查的 $WORK/index.body —— 复用跨检查的 body 正是本批要根除的 bug。
code="$(fetch_into "$WORK/home-css.body" "$BASE/")"
[ "$code" = "200" ] || fail "面板 / 期望 200，实际 $code（body: $(body_info "$WORK/home-css.body")）"
assert_html "$WORK/home-css.body" "首页 HTML（用于提取 /assets/*.css）"
# 末尾 `|| true`：grep 无匹配 + set -o pipefail 会让整个命令替换以非 0 结束，
# 在 set -e 下会**静默退出**（连下面那句 fail 都跑不到）。这里要的是走到明确的 fail。
css_path="$(grep -o '/assets/[^"]*\.css' "$WORK/home-css.body" | head -n 1 || true)"
[ -n "$css_path" ] || fail "首页没有外链 /assets/*.css（面板未构建或样式仍被内联；$(body_info "$WORK/home-css.body")）"
code="$(fetch_into "$WORK/css.body" "$BASE$css_path")"
[ "$code" = "200" ] || fail "$css_path 期望 200，实际 $code（独立 CSS 没进镜像？body: $(body_info "$WORK/css.body")）"

echo "==> POST /v1/chat/completions（mock CC → 真内核 → 网关）"
code="$(fetch_into "$WORK/v1.body" -X POST "$BASE/v1/chat/completions" \
  -H "authorization: Bearer ${LOCAL_KEY}" -H 'content-type: application/json' \
  -d '{"model":"mock-model","stream":false,"messages":[{"role":"user","content":"hi"}]}')"
case "$code" in
  200|400|401|429|502) : ;;
  000) fail "/v1 请求超时/连不上（挂死），不是结构化错误（$(body_info "$WORK/v1.body")）" ;;
  5*) fail "/v1 返回崩溃型 5xx（$code）：$(body_info "$WORK/v1.body")" ;;
  *) fail "/v1 返回意料之外的状态码 $code：$(body_info "$WORK/v1.body")" ;;
esac
assert_json "$WORK/v1.body" "/v1"
if [ "$code" = "200" ]; then
  grep -q '"choices"' "$WORK/v1.body" || fail "/v1 回 200 但响应体不像一次补全：$(body_info "$WORK/v1.body")"
  echo "    /v1 200，响应体形状正常（choices 存在）"
else
  echo "    /v1 返回结构化错误 $code（可接受：不算崩溃、不算挂死）"
fi

echo "==> 冒烟通过 ✅（容器 healthy + /health + /ready + 面板 + /v1 往返）"
