# B22：面板前端迁到 Astro 构建管道（panel/）。镜像分两阶段：
#   1) panel-build —— Debian(node:22-slim) 里 `npm ci` + `astro build`。Astro/Tailwind 的
#      原生依赖在 musl(alpine) 下风险高，slim 已验证；产物是纯静态文件（html/css/js）。
#   2) 运行阶段 —— 基础镜像与迁移前**完全一致**（node:22-alpine，可注入 digest / revision），
#      只 COPY 静态产物；镜像里没有 panel/、没有 node_modules、没有 npm 缓存，也没有构建工具。
# 构建阶段固定用 node:22-slim（不接收 BASE_IMAGE）；构建的可复现性由提交进仓库的
# panel/package-lock.json 保证（CI 用 `npm ci`）。
# 基础镜像可注入 digest（CI 里 `docker buildx imagetools inspect node:22-alpine` 解析后
# 通过 --build-arg BASE_IMAGE=node:22-alpine@sha256:… 传入）；本地缺省仍是 tag，直接可构建。
#
# 注意（B22c）——Docker 的 ARG 作用域：声明在某个 FROM **之后**的 ARG 只属于该阶段，
# 不能被任何 FROM 行使用。多阶段后运行阶段不再是第一个 FROM，所以 BASE_IMAGE 必须声明在
# **第一个 FROM 之前**（全局作用域），否则 `FROM ${BASE_IMAGE}` 会取到空值、构建直接失败
# （InvalidDefaultArgInFrom / UndefinedArgInFrom，base name should not be blank）。
ARG BASE_IMAGE=node:22-alpine

FROM node:22-slim AS panel-build
WORKDIR /panel
COPY panel/package.json panel/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY panel/ ./
RUN npm run build

FROM ${BASE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
# OCI 溯源标签：CI 构建时传 --build-arg REVISION=$(git rev-parse HEAD)
ARG REVISION=unknown
LABEL org.opencontainers.image.revision="${REVISION}"
# 只 COPY 运行必需的，禁止 `COPY . .`
COPY package.json gateway.mjs ./
COPY src/ ./src/
# B22：面板不再从仓库 COPY 源码 —— 由 panel-build 产出的静态文件落到 /app/public，
# 服务的 URL（/、/admin、/css/、/js/、/vendor/、/assets/）与迁移前逐字一致。
# `COPY --from` 默认 root 属主，靠下面的 `chown -R node:node /app` 修正（顺序不能反）。
COPY --from=panel-build /panel/dist/ ./public/
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3051
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3051/health || exit 1
CMD ["node", "gateway.mjs"]
